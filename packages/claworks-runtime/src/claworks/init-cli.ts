/**
 * init-cli.ts — `claworks init --profile industrial|enterprise|daily-report`
 *
 * 10 分钟企业零门槛初始化：创建 ~/.claworks/、写入 claworks.json、
 * 链接 Pack、探测 LLM、发布 profile 加载事件。
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Command } from "commander";
import { CW_EVENTS } from "../kernel/event-names.js";
import { applyDetectedLlmToConfig, detectLlmProviderFromEnv } from "./direct-llm-bridge.js";
import { resolvePackProfileIds } from "./pack-profile.js";
import { loadPersistedInstalled } from "./pack-runtime.js";
import {
  CLAWORKS_STANDARD_GATEWAY_PORT,
  discoverPackSourceDir,
  repairClaworksJsonConfig,
  seedPacksToStateDir,
} from "./product-config-repair.js";
import { isClaworksProduct, isClaworksProductionMode } from "./product-env.js";
import { createClaworksRuntime, startClaworksRuntime, stopClaworksRuntime } from "./runtime.js";

export const INIT_PROFILES = ["industrial", "enterprise", "daily-report"] as const;
export type InitProfile = (typeof INIT_PROFILES)[number];

export type InitStepSummary = {
  step: number;
  title: string;
  detail: string;
  status: "ok" | "warn" | "skip";
};

export type ClaworksInitResult = {
  profile: InitProfile;
  stateDir: string;
  configPath: string;
  packIds: string[];
  llmProvider: string | null;
  steps: InitStepSummary[];
  warnings: string[];
};

function repoRootFromModule(): string {
  return resolve(fileURLToPath(new URL("../../../..", import.meta.url)));
}

function resolveInitScriptPath(): string | null {
  const script = join(repoRootFromModule(), "scripts/claworks-init.mjs");
  return existsSync(script) ? script : null;
}

function ensureStateLayout(stateDir: string): void {
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(join(stateDir, "workspace"), { recursive: true });
  mkdirSync(join(stateDir, "packs"), { recursive: true });
}

function readConfigObject(configPath: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function profileLabel(profile: InitProfile): string {
  switch (profile) {
    case "industrial":
      return "流程工业";
    case "daily-report":
      return "日报分析";
    default:
      return "通用企业";
  }
}

/** User-visible warnings so init/onboard does not imply simulate OT is production-ready. */
export function collectClaworksInitWarnings(
  config: Record<string, unknown>,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const warnings: string[] = [];
  const robot = ((
    config.plugins as { entries?: Record<string, { config?: Record<string, unknown> }> } | undefined
  )?.entries?.["claworks-robot"]?.config ?? {}) as Record<string, unknown>;
  const production =
    robot.production_mode === true ||
    isClaworksProductionMode(robot) ||
    env.CLAWORKS_PRODUCTION === "1" ||
    env.CLAWORKS_PRODUCTION === "true";

  const connectors = (robot.connectors ?? {}) as Record<
    string,
    { enabled?: boolean; simulate?: boolean; preset?: string }
  >;
  const secureInit =
    env.CLAWORKS_INIT_SECURE === "1" ||
    env.CLAWORKS_INIT_SECURE === "true" ||
    env.CLAWORKS_PRODUCTION === "1";
  if (secureInit && !production) {
    warnings.push(
      "CLAWORKS_INIT_SECURE=1 已设置但 production_mode 未开启 — 请 CLAWORKS_INIT_SECURE=1 pnpm claworks:init --force 或 config 中设 production_mode: true",
    );
  }
  const apiKey = (robot.api as { api_key?: string } | undefined)?.api_key?.trim();
  if (secureInit && !apiKey) {
    warnings.push(
      "CLAWORKS_INIT_SECURE=1 已设置但 api.api_key 缺失 — secure init 会生成 Bearer token；请重新 init 或手动配置 api.api_key + gateway.auth.token",
    );
  }
  if (!production && !secureInit && env.CLAWORKS_PRODUCT_PROFILE?.trim() !== "personal_work") {
    warnings.push(
      "当前为开发模式 — 生产签收前请 CLAWORKS_INIT_SECURE=1 pnpm claworks:init --force（写入 production_mode + api_key + gateway token）",
    );
  }
  if (connectors.echo?.enabled !== false && connectors.echo) {
    warnings.push(
      "connectors.echo 为演示 OT 事件（非真实产线数据）；生产环境请配置 MQTT/OPC UA 等真实连接器",
    );
  }
  if (production && connectors.echo?.enabled !== false && connectors.echo) {
    warnings.push(
      "production_mode 已开启但 connectors.echo 仍启用 — 运行 claworks doctor --fix 关闭演示连接器",
    );
  }
  const simulating = Object.entries(connectors).filter(
    ([, cfg]) => cfg && typeof cfg === "object" && cfg.simulate === true,
  );
  if (production && simulating.length > 0) {
    warnings.push(
      `production_mode 已开启但 OT 连接器 simulate=true：${simulating.map(([id]) => id).join(", ")} — 运行 claworks doctor --fix`,
    );
  }
  if (simulating.length > 0 && !production) {
    warnings.push(
      `OT 连接器处于 simulate 开发模式：${simulating.map(([id]) => id).join(", ")}。生产前设 production_mode=true 并运行 claworks doctor --fix`,
    );
  }
  if (!production && env.CLAWORKS_PRODUCT_PROFILE?.trim() !== "personal_work") {
    warnings.push(
      "个人企业混合（自托管 Qwen/KB）：复制 contrib/examples/claworks-personal.env.example → ~/.claworks/personal.env，然后 CLAWORKS_PRODUCT_PROFILE=personal_work pnpm claworks:repair:personal",
    );
  }
  return warnings;
}

export async function runClaworksInit(opts: {
  profile?: string;
  force?: boolean;
  env?: NodeJS.ProcessEnv;
  skipProfileEvent?: boolean;
}): Promise<ClaworksInitResult> {
  const env = opts.env ?? process.env;
  const rawProfile = opts.profile?.trim() || "enterprise";
  if (!INIT_PROFILES.includes(rawProfile as InitProfile)) {
    throw new Error(`无效 profile: ${rawProfile}（可选: ${INIT_PROFILES.join(", ")}）`);
  }
  const profile = rawProfile as InitProfile;

  const stateDir = env.OPENCLAW_STATE_DIR?.trim() || join(homedir(), ".claworks");
  const configPath = env.OPENCLAW_CONFIG_PATH?.trim() || join(stateDir, "claworks.json");
  const packsDir = discoverPackSourceDir(env.CLAWORKS_PACKS_DIR?.trim() || process.cwd());
  const packIds = resolvePackProfileIds(profile, { packsDir });
  const steps: InitStepSummary[] = [];
  const warnings: string[] = [];
  let stepNo = 1;

  ensureStateLayout(stateDir);
  steps.push({
    step: stepNo++,
    title: "创建目录",
    detail: `已准备 ${stateDir}（配置、工作区、Pack 链接目录）`,
    status: "ok",
  });

  const detectedLlm = detectLlmProviderFromEnv(env);
  const llmProvider = detectedLlm ? `${detectedLlm.provider} (${detectedLlm.model})` : null;
  steps.push({
    step: stepNo++,
    title: "探测 LLM",
    detail: llmProvider
      ? `已检测到 ${llmProvider}，将写入 model_router`
      : "未检测到 OPENAI/ANTHROPIC/OLLAMA 环境变量，LLM 步骤将以 stub 运行",
    status: llmProvider ? "ok" : "warn",
  });

  const initScript = resolveInitScriptPath();
  const configExisted = existsSync(configPath);
  if (!configExisted || opts.force) {
    if (!initScript) {
      throw new Error("找不到 scripts/claworks-init.mjs，无法写入初始配置");
    }
    const initEnv = {
      ...env,
      CLAWORKS_PRODUCT: "1",
      CLAWORKS_INIT_PROFILE: profile,
      ...(opts.force ? { CLAWORKS_INIT_FORCE: "1" } : {}),
    };
    const result = spawnSync(process.execPath, [initScript], {
      cwd: repoRootFromModule(),
      env: initEnv,
      encoding: "utf8",
    });
    if (result.status !== 0) {
      throw new Error(result.stderr?.trim() || "claworks-init.mjs 执行失败");
    }
    steps.push({
      step: stepNo++,
      title: "写入配置",
      detail: opts.force
        ? `已覆盖 ${configPath}（Gateway 端口 ${CLAWORKS_STANDARD_GATEWAY_PORT}）`
        : `已创建 ${configPath}（Gateway 端口 ${CLAWORKS_STANDARD_GATEWAY_PORT}）`,
      status: "ok",
    });
  } else {
    steps.push({
      step: stepNo++,
      title: "写入配置",
      detail: `配置已存在，跳过覆盖（使用 --force 可重建）`,
      status: "skip",
    });
  }

  let config = readConfigObject(configPath);
  if (!config) {
    throw new Error(`无法读取配置: ${configPath}`);
  }

  if (detectedLlm && applyDetectedLlmToConfig(config, detectedLlm)) {
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
    steps.push({
      step: stepNo++,
      title: "配置 LLM 路由",
      detail: `model_router 已指向 ${llmProvider}`,
      status: "ok",
    });
  }

  const repair = repairClaworksJsonConfig(config, {
    packSourceDir: packsDir,
    stateDir,
    seedRobotMd: true,
  });
  warnings.push(...repair.warnings);
  warnings.push(...collectClaworksInitWarnings(config, env));
  if (repair.changed) {
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  }

  const seed = seedPacksToStateDir({
    stateDir,
    sourceDir: packsDir ?? undefined,
    packIds,
  });
  warnings.push(...seed.warnings);
  steps.push({
    step: stepNo++,
    title: "链接功能包",
    detail:
      seed.linked.length > 0
        ? `已链接 ${seed.linked.length} 个 Pack：${seed.linked.join(", ")}`
        : seed.missing.length > 0
          ? `未找到 Pack 源目录，请 clone claworks-packs 或设置 CLAWORKS_PACKS_DIR`
          : "Pack 目录已就绪",
    status: seed.linked.length > 0 ? "ok" : "warn",
  });

  if (!opts.skipProfileEvent) {
    const runtime = await createClaworksRuntime({
      packs: { installed: packIds.length > 0 ? packIds : await loadPersistedInstalled() },
    });
    await startClaworksRuntime(runtime);
    try {
      await runtime.kernel.publish(CW_EVENTS.PACK_LOAD_PROFILE_REQUESTED, "claworks.init", {
        profile,
        packs: packIds,
        source: "claworks.init",
      });
      steps.push({
        step: stepNo++,
        title: "加载行业模板",
        detail: `已发布 ${CW_EVENTS.PACK_LOAD_PROFILE_REQUESTED}（${profileLabel(profile)}）`,
        status: "ok",
      });
    } catch (err) {
      warnings.push(`profile 事件发布失败: ${err instanceof Error ? err.message : String(err)}`);
      steps.push({
        step: stepNo++,
        title: "加载行业模板",
        detail: `profile 事件发布失败，可稍后手动调用 pack.load_profile 能力`,
        status: "warn",
      });
    } finally {
      await stopClaworksRuntime(runtime);
    }
  }

  steps.push({
    step: stepNo++,
    title: "下一步",
    detail:
      "运行 pnpm claworks:start 启动 Gateway；生产前 CLAWORKS_INIT_SECURE=1 pnpm claworks:init --force；个人企业见 pnpm claworks:repair:personal",
    status: "ok",
  });

  return {
    profile,
    stateDir,
    configPath,
    packIds,
    llmProvider,
    steps,
    warnings,
  };
}

export function formatInitSummary(result: ClaworksInitResult): string {
  const lines: string[] = [
    "",
    `✅ ClaWorks 初始化完成（${profileLabel(result.profile)} 模式）`,
    "",
  ];
  for (const step of result.steps) {
    const icon = step.status === "ok" ? "✓" : step.status === "warn" ? "!" : "·";
    lines.push(`  ${icon} ${step.step}. ${step.title} — ${step.detail}`);
  }
  if (result.warnings.length > 0) {
    lines.push("", "⚠ 提示：");
    for (const warn of result.warnings) {
      lines.push(`  - ${warn}`);
    }
  }
  lines.push("", `配置：${result.configPath}`, `状态目录：${result.stateDir}`, "");
  return lines.join("\n");
}

export function registerClaworksInitCli(program: Command): void {
  if (!isClaworksProduct()) {
    return;
  }

  program
    .command("init")
    .description("10 分钟零门槛初始化（目录、配置、Pack、LLM 探测、行业 Profile）")
    .option("--profile <name>", "行业模板：industrial | enterprise | daily-report", "enterprise")
    .option("--force", "覆盖已有 claworks.json", false)
    .action(async (opts: { profile: string; force?: boolean }) => {
      try {
        const result = await runClaworksInit({
          profile: opts.profile,
          force: Boolean(opts.force),
        });
        process.stderr.write(formatInitSummary(result));
      } catch (err) {
        process.stderr.write(`初始化失败: ${err instanceof Error ? err.message : String(err)}\n`);
        process.exit(1);
      }
    });
}
