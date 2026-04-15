import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import { createLog } from "../../../logger.js";
import {
  fetchLatestStableVersion,
  isPublishedVersionOnNpm,
  isValidVersion,
  PLUGIN_ID,
  readInstalledVersion,
  runOpenClawCommand,
  runOpenClawCommandWithRetry,
  snapshotYuanbaoChannelConfig,
} from "./utils.js";

const log = createLog("upgrade");

// 安装和更新插件命令的Default超时（5 分钟）
const INSTALL_SCRIPT_TIMEOUT_MS = 5 * 60 * 1000;

enum MessageEnum {
  // 指定版本场景 - 配置被卸载后无法恢复时
  REPAIR_BOT_CONFIG_GUIDE = "❌ 升级失败，请前往 Bot 管理页面使用「修复 Bot 配置」功能修复。",
  // 通用场景 - 自动升级失败时
  AUTO_UPGRADE_FAILED_FALLBACK = "❌ 升级命令执行失败，元宝创建的 Bot 可前往「Bot 设置」点击「更新插件」进行升级，非元宝创建的Bot，请前往各自平台手动更新。",
  // 限频场景 - npm 操作触发 429 限频且重试耗尽时
  RATE_LIMITED = "❌ 升级失败，当前服务繁忙，请稍后再试。元宝创建的 Bot 可前往「Bot 设置」点击「更新插件」进行升级。",
}

/**
 * 升级/安装命令返回非零退出码时，回读实际安装版本判断是否已成功升级。
 *
 * 某些环境下命令伴随告警会导致 exit code 非零，但插件实际已安装到位，
 * Therefore the actual version should be used to determine the real state.
 */
async function verifyVersionAfterFailedCommand(params: {
  currentVersion: string | null;
  targetVersion: string | null;
  commandResult: { error?: string; rateLimited?: boolean };
  commandName: string;
}): Promise<
  | { upgraded: true; installedVersion: string }
  | { upgraded: false; installedVersion: string | null; rateLimited: boolean }
> {
  const { currentVersion, targetVersion, commandResult, commandName } = params;
  const installedVersion = await readInstalledVersion(PLUGIN_ID);
  const upgraded =
    !!installedVersion &&
    ((targetVersion != null && installedVersion === targetVersion) ||
      (targetVersion == null && currentVersion != null && installedVersion !== currentVersion));

  if (upgraded) {
    log.warn(`${commandName} 安装命令执行异常，但版本已更新成功`, {
      currentVersion,
      targetVersion,
      installedVersion,
      error: commandResult.error,
    });
    return { upgraded: true, installedVersion };
  }

  log.error(`${commandName} 执行失败`, {
    currentVersion,
    targetVersion,
    installedVersion: installedVersion ?? "(读取失败)",
    error: commandResult.error,
    rateLimited: !!commandResult.rateLimited,
  });
  return { upgraded: false, installedVersion, rateLimited: !!commandResult.rateLimited };
}

/**
 * 执行「指定版本」升级流程（卸载 + 重装 + 配置恢复）。
 */
async function runSpecifiedVersionFlow(params: {
  targetVersion?: string;
  currentVersion: string | null;
  config: OpenClawConfig;
  onProgress?: (text: string) => Promise<unknown>;
}): Promise<{ ok: boolean; skip?: boolean; error?: string; message?: string }> {
  const { targetVersion: _targetVersion, currentVersion, config, onProgress } = params;

  const hasTargetVersion = !!_targetVersion;
  const targetVersion = _targetVersion ?? (await fetchLatestStableVersion());

  log.info("检测到指定版本请求，执行卸载重装流程", {
    currentVersion: currentVersion ?? "(读取失败)",
    targetVersion,
  });

  // Step 1: 检查是否已是最新版本
  if (currentVersion && currentVersion === targetVersion) {
    log.info("已是最新版本，跳过升级", { version: targetVersion });
    return {
      ok: true,
      skip: true,
      message: `✅ 当前已是最新版本（v${targetVersion}），无需更新。`,
    };
  }

  if (hasTargetVersion) {
    await onProgress?.(
      currentVersion
        ? `🔄 正在将**元宝 Bot 插件**从 **v${currentVersion}** 升级至 **v${targetVersion}** ，请稍等片刻。`
        : `⏳ 正在将**元宝 Bot 插件**升级至 **v${targetVersion}** ，请稍等片刻。`,
    );
  }

  // Step 2: 先备份配置，后续在重装后逐项恢复
  const restoreSnapshotJson = snapshotYuanbaoChannelConfig(config);
  log.info("指定版本安装前已记录 yuanbao channel 配置", { hasSnapshot: !!restoreSnapshotJson });
  const restoreSnapshotConfig = async (): Promise<{ ok: true } | { ok: false; error?: string }> => {
    if (!restoreSnapshotJson) {
      return { ok: true };
    }
    const restoreResult = await runOpenClawCommand([
      "config",
      "set",
      "channels.yuanbao",
      restoreSnapshotJson,
      "--strict-json",
    ]);
    if (!restoreResult.ok) {
      return { ok: false, error: restoreResult.error };
    }
    return { ok: true };
  };

  // Step 3: 某些系统在 channels.yuanbao 存在时卸载会异常，先删除该配置
  const clearResult = await runOpenClawCommand(["config", "unset", "channels.yuanbao"]);
  if (!clearResult.ok) {
    log.error("指定版本安装失败：清理 channels.yuanbao 配置失败");
  } else {
    log.info("指定版本安装前已清理 channels.yuanbao 配置");
  }

  // Step 4: 卸载旧插件
  const uninstallResult = await runOpenClawCommand(["plugins", "uninstall", "--force", PLUGIN_ID]);
  if (!uninstallResult.ok) {
    // 卸载失败后尝试恢复配置
    const restoreAfterUninstallFailure = await restoreSnapshotConfig();
    if (!restoreAfterUninstallFailure.ok) {
      log.error("指定版本安装失败：卸载失败后配置恢复失败", {
        error: restoreAfterUninstallFailure.error,
      });
      return {
        ok: false,
        error: `配置恢复失败：${restoreAfterUninstallFailure.error ?? "unknown error"}`,
        message: MessageEnum.REPAIR_BOT_CONFIG_GUIDE,
      };
    }

    const details = `${uninstallResult.error ?? ""}\n${uninstallResult.stderr ?? ""}`;
    if (!/plugin not found/i.test(details)) {
      log.error("指定版本安装失败：卸载步骤失败", { error: uninstallResult.error });
      return {
        ok: false,
        error: uninstallResult.error ?? "插件卸载失败",
        message: MessageEnum.REPAIR_BOT_CONFIG_GUIDE,
      };
    }

    log.warn("卸载步骤返回未安装，继续安装", { error: uninstallResult.error });
  }

  // Step 5: 安装新插件
  const installResult = await runOpenClawCommandWithRetry({
    args: ["plugins", "install", `${PLUGIN_ID}@${targetVersion}`],
    timeoutMs: INSTALL_SCRIPT_TIMEOUT_MS,
    commandName: "plugins install",
  });

  // Step 6: 无论安装是否成功都尝试恢复配置，避免失败路径下配置丢失
  const restoreAfterInstall = await restoreSnapshotConfig();
  if (!restoreAfterInstall.ok) {
    log.error("指定版本安装失败：配置恢复失败", { error: restoreAfterInstall.error });
    return {
      ok: false,
      error: `配置恢复失败：${restoreAfterInstall.error ?? "unknown error"}`,
      message: MessageEnum.REPAIR_BOT_CONFIG_GUIDE,
    };
  }

  // Step 7: 检查安装结果；命令 exit code 非零时可能仅为告警，需回读版本确认真实状态
  if (!installResult.ok) {
    const verify = await verifyVersionAfterFailedCommand({
      currentVersion,
      targetVersion: targetVersion ?? null,
      commandResult: installResult,
      commandName: "plugins install",
    });
    if (!verify.upgraded) {
      return {
        ok: false,
        error: installResult.error ?? "插件安装失败",
        message: verify.rateLimited
          ? MessageEnum.RATE_LIMITED
          : MessageEnum.REPAIR_BOT_CONFIG_GUIDE,
      };
    }
  }
  log.info("指定版本安装流程完成", { targetVersion, hasSnapshot: !!restoreSnapshotJson });

  // Step 8: 通知升级成功
  await onProgress?.(
    currentVersion
      ? `✅ 更新成功！**元宝 Bot 插件**已从 v${currentVersion} 升级至 v${targetVersion}`
      : `✅ 更新成功！**元宝 Bot 插件**已升级至 v${targetVersion}`,
  );

  return { ok: true };
}

/**
 * 执行常规升级流程（升级到 npm 最新正式版）。
 */
async function runRegularUpgradeFlow(params: {
  currentVersion: string | null;
  onProgress?: (text: string) => Promise<unknown>;
}): Promise<{
  ok: boolean;
  skip?: boolean;
  error?: string;
  message?: string;
  needToInstall?: boolean;
}> {
  const { currentVersion, onProgress } = params;

  // Step 1: 检查是否已是最新正式版本
  const latestStableVersion = await fetchLatestStableVersion();
  if (latestStableVersion && currentVersion && currentVersion === latestStableVersion) {
    log.info("已是最新正式版本，跳过升级", { version: latestStableVersion });
    return {
      ok: true,
      skip: true,
      message: `✅ 当前已是最新版本（v${latestStableVersion}），无需更新。`,
    };
  }
  if (!latestStableVersion) {
    log.warn("未获取到 npm 最新正式版本，将直接执行 update");
  }

  await onProgress?.(
    currentVersion && latestStableVersion
      ? `🔄 正在将**元宝 Bot 插件**从 **v${currentVersion}** 升级至 **v${latestStableVersion}** ，请稍等片刻。`
      : "⏳ 正在将**元宝 Bot 插件**升级至最新版本，请稍等片刻。",
  );

  // Step 2: 执行 update 命令
  const updateResult = await runOpenClawCommandWithRetry({
    args: ["plugins", "update", `${PLUGIN_ID}@latest`],
    commandName: "plugins update",
  });

  // Step 3.1: 检查更新结果；命令 exit code 非零时可能仅为告警，需回读版本确认真实状态
  if (!updateResult.ok) {
    const verify = await verifyVersionAfterFailedCommand({
      currentVersion,
      targetVersion: latestStableVersion,
      commandResult: updateResult,
      commandName: "plugins update",
    });
    if (verify.upgraded) {
      await onProgress?.(
        latestStableVersion
          ? `✅ 更新成功！**元宝 Bot 插件**已从 v${currentVersion} 升级至 v${latestStableVersion}`
          : `✅ 更新成功！**元宝 Bot 插件**已更新至 v${verify.installedVersion}`,
      );
      return { ok: true };
    }
    return {
      ok: false,
      error: updateResult.error ?? "常规升级失败",
      message: verify.rateLimited ? MessageEnum.RATE_LIMITED : undefined,
    };
  }
  if (updateResult.stdout?.includes("No install record")) {
    // CDN 安装的版本首次执行 update 命令会提示 No install record，此处重新走指定版本安装流程
    return {
      ok: false,
      error: updateResult.error ?? "常规升级失败，需要重新安装",
      needToInstall: true,
    };
  }
  log.info("更新命令执行完毕");

  // Step 3.2: 通知升级成功
  await onProgress?.(
    latestStableVersion
      ? `✅ 更新成功！**元宝 Bot 插件**已从 v${currentVersion} 升级至 v${latestStableVersion}`
      : "✅ 更新成功！**元宝 Bot 插件**已更新至最新版本",
  );

  return { ok: true };
}

/**
 * Execute the complete plugin upgrade flow, returning the final plain-text status message sent to the user.
 *
 * @param config - OpenClaw Runtime配置
 * @param accountId - 账号标识（当前仅预留）
 * @param onProgress - 可选的进度通知回调
 * @param targetVersion - 可选目标版本；为空时执行常规升级到最新正式版
 * @returns 返回最终应发送给用户的文本；空字符串表示已通过 `onProgress` 完成提示
 */
export async function performUpgrade(
  config: OpenClawConfig,
  accountId?: string,
  onProgress?: (text: string) => Promise<unknown>,
  targetVersion?: string,
): Promise<string> {
  log.info("开始升级流程", { targetVersion: targetVersion ?? "(最新正式版)" });

  // accountId 预留
  void accountId;

  const isTargetVersionSpecified = !!targetVersion;

  // 仅在指定版本场景做格式校验
  if (isTargetVersionSpecified) {
    const requestedVersion = targetVersion;
    if (!isValidVersion(requestedVersion)) {
      log.error("指定的版本号格式无效，升级流程中止", { targetVersion });
      return `❌ 版本号格式无效：\`${targetVersion}\`，请使用 \`1.2.3\` 或 \`1.2.3-beta.abc\` 格式。`;
    }
    const isPublished = await isPublishedVersionOnNpm(requestedVersion);
    if (!isPublished) {
      log.error("指定版本在 npm 不存在，升级流程中止", { targetVersion });
      return `❌ 指定版本 \`${targetVersion}\` 不存在或暂不可用，请确认版本号后重试。`;
    }
  }

  const currentVersion = await readInstalledVersion(PLUGIN_ID);
  log.info("读取当前版本", {
    currentVersion: currentVersion ?? "(读取失败)",
    targetVersion: targetVersion ?? "(未指定)",
  });

  // 升级命令会改写 openclaw.json，先关闭自动重载
  const disableReloadResult = await runOpenClawCommand([
    "config",
    "set",
    "gateway.reload.mode",
    "off",
  ]);
  if (!disableReloadResult.ok) {
    log.error("升级流程中止：关闭自动重载失败", { error: disableReloadResult.error });
    return MessageEnum.AUTO_UPGRADE_FAILED_FALLBACK;
  }

  try {
    if (isTargetVersionSpecified) {
      // 执行指定版本安装流程
      const result = await runSpecifiedVersionFlow({
        targetVersion,
        currentVersion,
        config,
        onProgress,
      });
      if (!result.ok) {
        return result.message ?? MessageEnum.AUTO_UPGRADE_FAILED_FALLBACK;
      }
      if (result.skip) {
        return result.message ?? "✅ 当前已是指定版本，无需更新。";
      }
    } else {
      // 执行常规升级流程
      const result = await runRegularUpgradeFlow({ currentVersion, onProgress });
      if (!result.ok) {
        if (result.needToInstall) {
          // 需要通过指定版本安装流程重新安装
          log.info("常规升级失败，需要通过指定版本安装流程重新安装");
          const result = await runSpecifiedVersionFlow({ currentVersion, config, onProgress });
          if (!result.ok) {
            return result.message ?? MessageEnum.AUTO_UPGRADE_FAILED_FALLBACK;
          }
          if (result.skip) {
            return result.message ?? "✅ 当前已是指定版本，无需更新。";
          }
        } else {
          return result.message ?? MessageEnum.AUTO_UPGRADE_FAILED_FALLBACK;
        }
      }
      if (result.skip) {
        return result.message ?? "✅ 当前已是最新版本，无需更新。";
      }
    }
  } finally {
    // 无论成功失败都恢复自动重载配置
    const restoreReloadResult = await runOpenClawCommand([
      "config",
      "set",
      "gateway.reload.mode",
      "hybrid",
    ]);
    if (!restoreReloadResult.ok) {
      log.error("恢复 gateway.reload.mode=hybrid 失败", {
        error: restoreReloadResult.error ?? "恢复自动重载失败",
      });
    }
  }

  // 升级提示先发送，再执行重启
  await onProgress?.("⏳ OpenClaw Gateway 准备重启，预计需要花费 10 秒左右，重启后升级生效。");

  const restartResult = await runOpenClawCommand(["gateway", "restart"]);
  log.info("升级后重启命令执行结果", { ok: restartResult.ok, error: restartResult.error });

  return "";
}
