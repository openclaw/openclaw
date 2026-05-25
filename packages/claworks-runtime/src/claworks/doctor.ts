import { existsSync, mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createDirectLlmBridge } from "./direct-llm-bridge.js";
import {
  loadPersistedInstalled,
  mergePackConfig,
  reloadClaworksPacksFromDisk,
} from "./pack-runtime.js";
import {
  hasPackSourcesAvailable,
  repairClaworksJsonConfig,
  seedPacksToStateDir,
  detectPackLayerSystemConflict,
  discoverPackSourceDir,
  type ProductConfigRepairResult,
} from "./product-config-repair.js";
import { isClaworksProductionMode } from "./product-env.js";
import type { ClaworksRuntime } from "./runtime-types.js";

export type DoctorCheck = {
  id: string;
  status: "ok" | "warn" | "error";
  message: string | null;
};

export function runClaworksDoctor(runtime: ClaworksRuntime): DoctorCheck[] {
  const checks: DoctorCheck[] = [];

  checks.push({
    id: "kernel",
    status: "ok",
    message: null,
  });

  const playbooks = runtime.playbookEngine.list();
  checks.push({
    id: "playbooks",
    status: playbooks.length > 0 ? "ok" : "warn",
    message:
      playbooks.length > 0
        ? null
        : "No playbooks loaded — check packs.paths and packs.installed in config",
  });

  const types = runtime.ontology.listTypes();
  checks.push({
    id: "ontology",
    status: types.length > 0 ? "ok" : "warn",
    message:
      types.length > 0 ? null : "No object types loaded — install process-industry or other packs",
  });

  checks.push({
    id: "packs",
    status: runtime.loadedPacks.length > 0 ? "ok" : "warn",
    message:
      runtime.loadedPacks.length > 0
        ? `Loaded: ${runtime.loadedPacks.map((p) => `${p.manifest.id}@${p.manifest.version}`).join(", ")}`
        : "No packs loaded",
  });

  const installedIds = [
    ...new Set([
      ...runtime.loadedPacks.map((p) => p.manifest.id),
      ...(runtime.config.packs?.installed ?? []),
    ]),
  ];
  const layerConflict = detectPackLayerSystemConflict(installedIds);
  checks.push({
    id: "pack_layer_system",
    status: layerConflict.conflict ? "error" : layerConflict.message ? "warn" : "ok",
    message: layerConflict.message,
  });

  try {
    runtime.db.prepare("SELECT 1").get();
    checks.push({ id: "database", status: "ok", message: null });
  } catch (err) {
    checks.push({
      id: "database",
      status: "error",
      message: err instanceof Error ? err.message : String(err),
    });
  }

  const dbUrl = runtime.config.data?.database_url ?? "";
  if (dbUrl.startsWith("postgres")) {
    if (runtime.databaseNote) {
      checks.push({
        id: "database_postgres",
        status: "warn",
        message: runtime.databaseNote,
      });
    } else if (runtime.databaseDialect === "postgresql") {
      checks.push({
        id: "database_postgres",
        status: "ok",
        message: "PostgreSQL ObjectStore active (run `pnpm claworks:migrate` on fresh clusters)",
      });
    } else {
      checks.push({
        id: "database_postgres",
        status: "warn",
        message:
          "postgresql:// configured but dialect is not postgresql — check `pg` install and URL",
      });
    }
  }

  const kbProvider = runtime.config.data?.kb_provider ?? "stub";
  const kbEmbed = runtime.config.data?.kb_embed_model?.trim();
  checks.push({
    id: "kb",
    status: kbProvider === "memory-core" ? "ok" : "warn",
    message:
      kbProvider === "memory-core"
        ? `Vector KB via memory-core + memory-lancedb${kbEmbed ? ` (embed: ${kbEmbed})` : ""} — GET /v1/kb/status for live bridge`
        : "Using stub/file KB — set data.kb_provider=memory-core and run CLAWORKS_VECTOR_KB=1 pnpm claworks:repair",
  });

  const connectorIds = Object.keys(runtime.config.connectors ?? {}).filter(
    (id) =>
      (runtime.config.connectors as Record<string, { enabled?: boolean }>)[id]?.enabled !== false,
  );
  checks.push({
    id: "connectors",
    status: connectorIds.length > 0 ? "ok" : "warn",
    message:
      connectorIds.length > 0
        ? `Active: ${connectorIds.join(", ")}`
        : "No connectors enabled — set connectors.echo in config or CLAWORKS_DEMO_CONNECTORS=1 on init",
  });

  checks.push({
    id: "robot",
    status: "ok",
    message: `${runtime.robot.name} (${runtime.robot.role}) @ ${runtime.robot.endpoint}`,
  });

  if (!hasPackSourcesAvailable()) {
    checks.push({
      id: "packs_source",
      status: "warn",
      message: "No pack sources — clone ../claworks-packs or set CLAWORKS_PACKS_DIR",
    });
  }

  // ── Gateway 桥接（LLM / 通知 / IM）────────────────────────────────────────
  const modelRouter = runtime.config.model_router ?? {};
  const hasLlmRoute = Boolean(
    modelRouter.chat?.trim() ||
    modelRouter.complete?.trim() ||
    modelRouter.fast?.trim() ||
    modelRouter.default?.trim(),
  );
  checks.push({
    id: "gateway_bridge_llm",
    status: hasLlmRoute ? "ok" : "warn",
    message: hasLlmRoute
      ? "model_router configured for Gateway LLM bridge"
      : "No model_router — set CLAWORKS_LLM_BASE_URL or agents.defaults.model, then claworks doctor --fix",
  });

  const notifyTargets = runtime.config.notify?.targets ?? [];
  checks.push({
    id: "gateway_bridge_notify",
    status: notifyTargets.length > 0 ? "ok" : "warn",
    message:
      notifyTargets.length > 0
        ? `Notify targets: ${notifyTargets.map((t) => `${t.channel}:${t.to}`).join(", ")}`
        : "notify.targets empty — run claworks doctor --fix to derive from channels.feishu.allowFrom or set notify.targets",
  });

  const imAuto = runtime.config.im_bridge?.auto_on_message_received === true;
  checks.push({
    id: "gateway_bridge_im",
    status: imAuto ? "ok" : "warn",
    message: imAuto
      ? "IM auto-bridge enabled (message_received → classify_im)"
      : "im_bridge.auto_on_message_received=false — users must POST /v1/bridge/im or enable auto bridge",
  });

  // ── 生产就绪安全检查 ─────────────────────────────────────────────────────
  const isProduction = isClaworksProductionMode(runtime.config);

  const apiKey = runtime.config.api?.api_key?.trim();
  checks.push({
    id: "security_api_key",
    status: apiKey ? "ok" : "warn",
    message: apiKey
      ? "API key configured"
      : "No api.api_key — all requests authorized as system; set api.api_key for production",
  });

  const requireApiKey = runtime.config.api?.require_api_key === true;
  checks.push({
    id: "security_require_api_key",
    status: requireApiKey ? "ok" : isProduction ? "error" : "warn",
    message: requireApiKey
      ? "require_api_key=true"
      : "api.require_api_key not set — recommended for production (set to true)",
  });

  const dbUrlForCheck = runtime.config.data?.database_url ?? "";
  checks.push({
    id: "database_production",
    status: dbUrlForCheck.startsWith("postgres") ? "ok" : isProduction ? "warn" : "ok",
    message: dbUrlForCheck.startsWith("postgres")
      ? "PostgreSQL configured"
      : isProduction
        ? "SQLite in production — consider PostgreSQL for reliability & scale"
        : "SQLite (development default)",
  });

  const a2aPeers = runtime.config.a2a?.peers ?? [];
  if (a2aPeers.length > 0) {
    const httpsA2a = runtime.config.security?.require_https_a2a === true;
    checks.push({
      id: "security_a2a_https",
      status: httpsA2a ? "ok" : isProduction ? "warn" : "ok",
      message: httpsA2a
        ? "A2A HTTPS enforcement enabled"
        : `${a2aPeers.length} A2A peer(s) configured — set security.require_https_a2a=true for production`,
    });
  }

  checks.push({
    id: "production_mode",
    status: "ok",
    message: isProduction
      ? "production_mode=true — stub steps fail-closed, full security enforcement"
      : "production_mode=false (dev mode) — stub steps return gracefully",
  });

  const connectors = runtime.config.connectors ?? {};
  const simulating = Object.entries(connectors).filter(
    ([, cfg]) =>
      cfg && typeof cfg === "object" && (cfg as { simulate?: boolean }).simulate === true,
  );
  if (simulating.length > 0) {
    checks.push({
      id: "connectors_simulate",
      status: isProduction ? "error" : "warn",
      message: isProduction
        ? `OT connectors in simulate mode: ${simulating.map(([id]) => id).join(", ")} — run claworks doctor --fix or set simulate: false`
        : `Dev simulate connectors: ${simulating.map(([id]) => id).join(", ")}`,
    });
  }

  const echoEnabled =
    (connectors.echo as { enabled?: boolean } | undefined)?.enabled !== false &&
    connectors.echo !== undefined;
  if (echoEnabled && isProduction) {
    checks.push({
      id: "connectors_echo_demo",
      status: "error",
      message:
        "connectors.echo is demo-only (synthetic OT events) — disable for production and configure MQTT/OPC UA connectors",
    });
  }

  return checks;
}

export async function runClaworksDoctorFix(
  runtime: ClaworksRuntime,
): Promise<{ applied: string[]; warnings: string[]; repair: ProductConfigRepairResult }> {
  const applied: string[] = [];
  const warnings: string[] = [];

  const wrapped: Record<string, unknown> = {
    plugins: {
      allow: ["claworks-robot"],
      entries: {
        "claworks-robot": { enabled: true, config: runtime.config },
      },
    },
  };
  const sourceDir = discoverPackSourceDir();
  const jsonRepair = repairClaworksJsonConfig(wrapped, {
    packSourceDir: sourceDir,
    enableEchoConnector: !isClaworksProductionMode(runtime.config),
    seedRobotMd: false,
  });
  if (jsonRepair.changed) {
    const repaired = (
      wrapped.plugins as { entries?: Record<string, { config?: typeof runtime.config }> }
    )?.entries?.["claworks-robot"]?.config;
    if (repaired) {
      runtime.config = repaired;
    }
    applied.push(...jsonRepair.actions);
  }
  warnings.push(...jsonRepair.warnings);

  const sourceDirForSeed = sourceDir;
  const seed = seedPacksToStateDir({
    sourceDir: sourceDirForSeed ?? undefined,
    packIds: runtime.config.packs?.installed ?? undefined,
  });
  if (seed.linked.length > 0) {
    applied.push(`Linked packs under ~/.claworks/packs: ${seed.linked.join(", ")}`);
  }
  warnings.push(...seed.warnings);

  const persisted = await loadPersistedInstalled();
  const packConfig = mergePackConfig(runtime.config.packs, persisted);
  const extraPaths = [sourceDir].filter((p): p is string => Boolean(p));
  packConfig.paths = [...new Set([...(packConfig.paths ?? []), ...extraPaths])];
  runtime.config.packs = packConfig;

  if (!runtime.config.connectors || Object.keys(runtime.config.connectors).length === 0) {
    runtime.config.connectors = { echo: { preset: "echo", enabled: true } };
    applied.push("connectors.echo: enabled");
  }

  // ── Fix 1: LLM bridge 未配置时从环境变量自动尝试配置 ──────────────────────
  if (!runtime.llmComplete) {
    const bridge = createDirectLlmBridge();
    if (bridge) {
      runtime.llmComplete = bridge;
      const provider =
        process.env["ANTHROPIC_API_KEY"] && !process.env["OPENAI_API_KEY"]
          ? "Anthropic"
          : process.env["OLLAMA_BASE_URL"]
            ? "Ollama"
            : "OpenAI";
      applied.push(`llmComplete: auto-configured direct LLM bridge (${provider})`);
    } else {
      warnings.push(
        "LLM bridge 未配置且无可用环境变量 (OPENAI_API_KEY / ANTHROPIC_API_KEY / OLLAMA_BASE_URL)；LLM 相关步骤将降级",
      );
    }
  }

  // ── Fix 2: Pack 目录不存在时自动创建 ──────────────────────────────────────
  const packsDir = join(homedir(), ".claworks", "packs");
  if (!existsSync(packsDir)) {
    try {
      mkdirSync(packsDir, { recursive: true });
      applied.push(`Created pack directory: ${packsDir}`);
    } catch (err) {
      warnings.push(`无法创建 pack 目录 ${packsDir}: ${String(err)}`);
    }
  }

  // ── Fix 3: 检测并清理 SQLite WAL 锁文件 ───────────────────────────────────
  const dbUrl =
    runtime.config.data?.database_url ?? `sqlite://${join(homedir(), ".claworks", "robot.db")}`;
  if (dbUrl.startsWith("sqlite://")) {
    const dbPath = dbUrl.slice("sqlite://".length);
    const shmPath = `${dbPath}-shm`;
    const walPath = `${dbPath}-wal`;
    let dbAccessible = true;
    try {
      runtime.db.prepare("SELECT 1").get();
    } catch {
      dbAccessible = false;
    }
    if (!dbAccessible) {
      for (const lockFile of [shmPath, walPath]) {
        if (existsSync(lockFile)) {
          try {
            rmSync(lockFile, { force: true });
            applied.push(`Removed stale SQLite lock file: ${lockFile}`);
          } catch (err) {
            warnings.push(`无法删除锁文件 ${lockFile}: ${String(err)}`);
          }
        }
      }
    }
  }

  await reloadClaworksPacksFromDisk(runtime);
  applied.push(
    `Reloaded ${runtime.loadedPacks.length} pack(s), ${runtime.playbookEngine.list().length} playbook(s), ${runtime.ontology.listTypes().length} object type(s)`,
  );

  return { applied, warnings, repair: { changed: applied.length > 0, actions: applied, warnings } };
}
