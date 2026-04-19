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

// Default timeout for install/update plugin commands (5 minutes)
const INSTALL_SCRIPT_TIMEOUT_MS = 5 * 60 * 1000;

enum MessageEnum {
  // Specified version scenario - config cannot be recovered after uninstall
  REPAIR_BOT_CONFIG_GUIDE = "❌ 升级失败，请前往 Bot 管理页面使用「修复 Bot 配置」功能修复。",
  // General scenario - auto upgrade failed
  AUTO_UPGRADE_FAILED_FALLBACK = "❌ 升级命令执行失败，元宝创建的 Bot 可前往「Bot 设置」点击「更新插件」进行升级，非元宝创建的Bot，请前往各自平台手动更新。",
  // Rate-limited scenario - npm 429 retries exhausted
  RATE_LIMITED = "❌ 升级失败，当前服务繁忙，请稍后再试。元宝创建的 Bot 可前往「Bot 设置」点击「更新插件」进行升级。",
}

/**
 * When upgrade/install command returns non-zero exit code, re-read installed version to determine if upgrade actually succeeded.
 * Some environments produce non-zero exit codes due to warnings, but the plugin is actually installed.
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
 * Execute "specified version" upgrade flow (uninstall + reinstall + config restore).
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

  // Step 1: Check if already on target version
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

  // Step 2: Backup config first, restore after reinstall
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

  // Step 3: Some systems fail to uninstall when channels.yuanbao exists, clear it first
  const clearResult = await runOpenClawCommand(["config", "unset", "channels.yuanbao"]);
  if (!clearResult.ok) {
    log.error("指定版本安装失败：清理 channels.yuanbao 配置失败");
  } else {
    log.info("指定版本安装前已清理 channels.yuanbao 配置");
  }

  // Step 4: Uninstall old plugin
  const uninstallResult = await runOpenClawCommand(["plugins", "uninstall", "--force", PLUGIN_ID]);
  if (!uninstallResult.ok) {
    // Try to restore config after uninstall failure
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

  // Step 5: Install new plugin
  const installResult = await runOpenClawCommandWithRetry({
    args: ["plugins", "install", `${PLUGIN_ID}@${targetVersion}`],
    timeoutMs: INSTALL_SCRIPT_TIMEOUT_MS,
    commandName: "plugins install",
  });

  // Step 6: Always try to restore config regardless of install result, to avoid config loss on failure path
  const restoreAfterInstall = await restoreSnapshotConfig();
  if (!restoreAfterInstall.ok) {
    log.error("指定版本安装失败：配置恢复失败", { error: restoreAfterInstall.error });
    return {
      ok: false,
      error: `配置恢复失败：${restoreAfterInstall.error ?? "unknown error"}`,
      message: MessageEnum.REPAIR_BOT_CONFIG_GUIDE,
    };
  }

  // Step 7: Check install result; non-zero exit code may be just a warning, re-read version to confirm
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

  // Step 8: Notify upgrade success
  await onProgress?.(
    currentVersion
      ? `✅ 更新成功！**元宝 Bot 插件**已从 v${currentVersion} 升级至 v${targetVersion}`
      : `✅ 更新成功！**元宝 Bot 插件**已升级至 v${targetVersion}`,
  );

  return { ok: true };
}

/**
 * Execute regular upgrade flow (upgrade to latest stable npm version).
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

  // Step 1: Check if already on latest stable version
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

  // Step 2: Execute update command
  const updateResult = await runOpenClawCommandWithRetry({
    args: ["plugins", "update", `${PLUGIN_ID}@latest`],
    commandName: "plugins update",
  });

  // Step 3.1: Check update result; non-zero exit code may be just a warning, re-read version to confirm
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
    // CDN installed version first time executing update command will prompt No install record, here we re-run the specified version install flow
    return {
      ok: false,
      error: updateResult.error ?? "常规升级失败，需要重新安装",
      needToInstall: true,
    };
  }
  log.info("更新命令执行完毕");

  // Step 3.2: Notify upgrade success
  await onProgress?.(
    latestStableVersion
      ? `✅ 更新成功！**元宝 Bot 插件**已从 v${currentVersion} 升级至 v${latestStableVersion}`
      : "✅ 更新成功！**元宝 Bot 插件**已更新至最新版本",
  );

  return { ok: true };
}

/**
 * Execute the complete plugin upgrade flow, returning the final plain-text status message sent to the user.
 */
export async function performUpgrade(
  config: OpenClawConfig,
  accountId?: string,
  onProgress?: (text: string) => Promise<unknown>,
  targetVersion?: string,
): Promise<string> {
  log.info("开始升级流程", { targetVersion: targetVersion ?? "(最新正式版)" });

  // accountId reserved for future use
  void accountId;

  // Only validate version format for specified-version scenario
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

  // Upgrade command rewrites openclaw.json, disable auto-reload first
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
      // Execute specified-version install flow
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
      // Execute regular upgrade flow
      const result = await runRegularUpgradeFlow({ currentVersion, onProgress });
      if (!result.ok) {
        if (result.needToInstall) {
          // Need to reinstall via specified-version install flow
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
    // Always restore auto-reload config regardless of success/failure
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

  // Send upgrade notice first, then restart
  await onProgress?.("⏳ OpenClaw Gateway 准备重启，预计需要花费 10 秒左右，重启后升级生效。");

  const restartResult = await runOpenClawCommand(["gateway", "restart"]);
  log.info("升级后重启命令执行结果", { ok: restartResult.ok, error: restartResult.error });

  return "";
}
