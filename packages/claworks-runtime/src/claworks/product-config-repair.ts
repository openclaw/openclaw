import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  symlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ClaworksRobotConfig } from "./config-types.js";
import { repairNotifyTargets } from "./notify-config-repair.js";
import {
  isPersonalWorkProfile,
  repairPersonalEnterpriseProfile,
} from "./personal-enterprise-repair.js";
import { isClaworksProductionMode } from "./product-env.js";

/** OpenClaw personal install default; ClaWorks product must not bind here. */
export const OPENCLAW_RESERVED_GATEWAY_PORT = 18_789;
export const CLAWORKS_STANDARD_GATEWAY_PORT = 18_800;

export const DEFAULT_CLAWORKS_PACK_IDS = [
  "base",
  "enterprise-foundation",
  "process-industry",
  "enterprise-general",
  "enterprise-commercial",
] as const;

export type ProductConfigRepairResult = {
  changed: boolean;
  actions: string[];
  warnings: string[];
};

const OT_SIMULATE_PRESET_SUFFIX = "-simulate";

/** Normalize OT connector presets for production (no simulate / no *-simulate presets). */
export function repairOtConnectorSimulateFlags(
  connectors: Record<string, { simulate?: boolean; preset?: string }> | undefined,
  opts: { productionMode?: boolean; env?: NodeJS.ProcessEnv } = {},
): {
  connectors: Record<string, { simulate?: boolean; preset?: string }>;
  actions: string[];
  changed: boolean;
} {
  const env = opts.env ?? process.env;
  const enforceProduction =
    opts.productionMode === true ||
    env.CLAWORKS_PRODUCTION === "1" ||
    env.CLAWORKS_INIT_SECURE === "1";
  if (!connectors) {
    return { connectors: {}, actions: [], changed: false };
  }
  const next = { ...connectors };
  let changed = false;
  const actions: string[] = [];
  for (const [id, raw] of Object.entries(next)) {
    if (!raw || typeof raw !== "object") {
      continue;
    }
    const entry = { ...raw };
    let entryChanged = false;
    if (typeof entry.preset === "string" && entry.preset.endsWith(OT_SIMULATE_PRESET_SUFFIX)) {
      entry.preset = entry.preset.slice(0, -OT_SIMULATE_PRESET_SUFFIX.length);
      entry.simulate = false;
      entryChanged = true;
      actions.push(`connectors.${id}.preset → ${entry.preset} (removed -simulate suffix)`);
    }
    if (enforceProduction && entry.simulate === true) {
      entry.simulate = false;
      entryChanged = true;
      actions.push(`connectors.${id}.simulate = false (production)`);
    }
    if (entryChanged) {
      next[id] = entry;
      changed = true;
    }
  }
  return { connectors: next, actions, changed };
}

const LEGACY_L0_PACK = "core";
const NEW_L0_PACK = "base";
const LEGACY_CHAIN_PACKS = new Set(["core", "comms", "knowledge", "workflow"]);
const NEW_CHAIN_MARKERS = new Set(["base", "enterprise-foundation", "process-industry"]);

/** Detect core (legacy) + base (new) L0 both installed — causes playbook ID collisions. */
export function detectPackLayerSystemConflict(installed: string[]): {
  conflict: boolean;
  message: string | null;
} {
  const ids = new Set(installed);
  const hasCore = ids.has(LEGACY_L0_PACK);
  const hasBase = ids.has(NEW_L0_PACK);
  if (hasCore && hasBase) {
    return {
      conflict: true,
      message:
        "Both legacy L0 (core) and new L0 (base) installed — use one system (see claworks-packs/PACK-LAYER-SYSTEMS.md)",
    };
  }
  const legacyOther = [...LEGACY_CHAIN_PACKS].some((p) => ids.has(p) && p !== LEGACY_L0_PACK);
  const newOther = [...NEW_CHAIN_MARKERS].some((p) => ids.has(p));
  if (hasCore && newOther) {
    return {
      conflict: true,
      message:
        "Mixed legacy core-chain and new base-chain packs — pick one profile from claworks.packs.json",
    };
  }
  if (hasBase && legacyOther && !hasCore) {
    return {
      conflict: false,
      message: "base + legacy comms/knowledge/workflow — prefer new profiles only",
    };
  }
  return { conflict: false, message: null };
}

export function discoverPackSourceDir(cwd = process.cwd()): string | null {
  const env = process.env.CLAWORKS_PACKS_DIR?.trim();
  if (env && existsSync(env)) {
    return resolve(env);
  }
  const candidates = [
    join(cwd, "claworks-packs"),
    join(cwd, "..", "claworks-packs"),
    join(fileURLToPath(new URL("../../../..", import.meta.url)), "..", "claworks-packs"),
  ];
  for (const dir of candidates) {
    const manifest = join(dir, "base", "claworks.pack.json");
    if (existsSync(manifest)) {
      return resolve(dir);
    }
  }
  return null;
}

/** True when sibling claworks-packs or ~/.claworks/packs has at least one pack. */
export function hasPackSourcesAvailable(opts?: { cwd?: string; stateDir?: string }): boolean {
  if (discoverPackSourceDir(opts?.cwd)) {
    return true;
  }
  const stateDir = opts?.stateDir?.trim() || join(homedir(), ".claworks");
  const packsRoot = join(stateDir, "packs");
  if (!existsSync(packsRoot)) {
    return false;
  }
  for (const name of readdirSync(packsRoot)) {
    const manifest = join(packsRoot, name, "claworks.pack.json");
    if (existsSync(manifest)) {
      return true;
    }
  }
  return false;
}

export function discoverProductPluginAllowPath(cwd = process.cwd()): string | null {
  const candidates = [
    join(cwd, "contrib/claworks-product.plugins.allow.json"),
    join(cwd, "..", "claworks", "contrib/claworks-product.plugins.allow.json"),
    join(
      fileURLToPath(new URL("../../../..", import.meta.url)),
      "contrib/claworks-product.plugins.allow.json",
    ),
  ];
  for (const p of candidates) {
    if (existsSync(p)) {
      return resolve(p);
    }
  }
  return null;
}

export function loadProductPluginAllow(profile = "extended"): string[] {
  const allowPath = discoverProductPluginAllowPath();
  if (!allowPath) {
    return ["claworks-robot", "feishu", "webhooks", "memory-core", "memory-lancedb"];
  }
  try {
    const raw = JSON.parse(readFileSync(allowPath, "utf8")) as {
      core?: string[];
      personal_work?: string[];
      optional_domestic_llm?: string[];
      optional_enterprise?: string[];
    };
    const core = raw.core ?? ["claworks-robot"];
    if (profile === "personal_work") {
      return raw.personal_work ?? core;
    }
    if (profile === "full") {
      return [
        ...new Set([
          ...core,
          ...(raw.optional_domestic_llm ?? []),
          ...(raw.optional_enterprise ?? []),
        ]),
      ];
    }
    if (profile === "core") {
      return core;
    }
    return [...new Set([...core, ...(raw.optional_domestic_llm ?? [])])];
  } catch {
    return ["claworks-robot", "feishu", "webhooks", "memory-core", "memory-lancedb"];
  }
}

export function repairProductPluginsAllow(
  config: Record<string, unknown>,
  opts?: { profile?: string },
): ProductConfigRepairResult {
  const actions: string[] = [];
  const warnings: string[] = [];
  let changed = false;

  const profile =
    opts?.profile?.trim() ||
    process.env.CLAWORKS_PRODUCT_PROFILE?.trim() ||
    (process.env.CLAWORKS_INIT_PROFILE?.trim() === "core" ? "core" : "extended");

  const desired = loadProductPluginAllow(profile);
  const plugins = (config.plugins ?? {}) as Record<string, unknown>;
  config.plugins = plugins;
  const allow = new Set(Array.isArray(plugins.allow) ? (plugins.allow as string[]) : []);
  for (const id of desired) {
    if (!allow.has(id)) {
      allow.add(id);
      actions.push(`plugins.allow: added ${id}`);
      changed = true;
    }
  }
  if (changed) {
    plugins.allow = [...allow];
  }

  const entries = (plugins.entries ?? {}) as Record<string, Record<string, unknown>>;
  plugins.entries = entries;
  entries["claworks-robot"] ??= { enabled: true };
  if (entries["claworks-robot"].enabled !== true) {
    entries["claworks-robot"].enabled = true;
    actions.push("plugins.entries.claworks-robot.enabled = true");
    changed = true;
  }
  if (allow.has("feishu") && entries.feishu?.enabled !== true) {
    entries.feishu = { ...entries.feishu, enabled: true };
    actions.push("plugins.entries.feishu.enabled = true");
    changed = true;
  }

  return { changed, actions, warnings };
}

function resolvePackSourcePath(packId: string, primaryDir: string | null): string | null {
  if (!primaryDir) {
    return null;
  }
  const primary = join(primaryDir, packId);
  if (existsSync(primary)) {
    return primary;
  }
  return null;
}

export function seedPacksToStateDir(opts?: {
  stateDir?: string;
  sourceDir?: string;
  packIds?: readonly string[];
}): { linked: string[]; missing: string[]; warnings: string[] } {
  const stateDir = opts?.stateDir?.trim() || join(homedir(), ".claworks");
  const destRoot = join(stateDir, "packs");
  const primaryDir = opts?.sourceDir?.trim() || discoverPackSourceDir();
  const packIds = opts?.packIds ?? DEFAULT_CLAWORKS_PACK_IDS;
  const linked: string[] = [];
  const missing: string[] = [];
  const warnings: string[] = [];

  mkdirSync(destRoot, { recursive: true });

  if (!primaryDir) {
    warnings.push(
      "No claworks-packs source found — clone sibling repo or set CLAWORKS_PACKS_DIR to a directory containing base/, process-industry/, etc.",
    );
    return { linked, missing: [...packIds], warnings };
  }

  for (const packId of packIds) {
    const src = resolvePackSourcePath(packId, primaryDir);
    const dest = join(destRoot, packId);
    if (!src) {
      missing.push(packId);
      continue;
    }
    if (existsSync(dest)) {
      linked.push(packId);
      continue;
    }
    try {
      symlinkSync(src, dest, "dir");
      linked.push(packId);
    } catch (err) {
      warnings.push(
        `Could not symlink ${packId}: ${err instanceof Error ? err.message : String(err)}`,
      );
      missing.push(packId);
    }
  }

  return { linked, missing, warnings };
}

const VECTOR_KB_PLUGIN_IDS = ["memory-core", "memory-lancedb"] as const;

/** Wire OpenClaw memory-core + LanceDB for semantic KB (vector search). */
export function repairVectorKnowledgeBase(
  config: Record<string, unknown>,
  opts?: { force?: boolean },
): ProductConfigRepairResult {
  const actions: string[] = [];
  const warnings: string[] = [];
  let changed = false;

  const plugins = (config.plugins ?? {}) as Record<string, unknown>;
  config.plugins = plugins;

  const allow = new Set(Array.isArray(plugins.allow) ? (plugins.allow as string[]) : []);
  for (const id of VECTOR_KB_PLUGIN_IDS) {
    if (!allow.has(id)) {
      allow.add(id);
      actions.push(`plugins.allow: added ${id}`);
      changed = true;
    }
  }
  plugins.allow = [...allow];

  const entries = (plugins.entries ?? {}) as Record<string, Record<string, unknown>>;
  plugins.entries = entries;

  const memoryCore = entries["memory-core"];
  if (memoryCore !== undefined) {
    delete entries["memory-core"];
    actions.push("plugins.entries.memory-core: removed (memory slot uses memory-lancedb)");
    changed = true;
  }

  const memoryLance = entries["memory-lancedb"] ?? {};
  if (memoryLance.enabled === false) {
    warnings.push("memory-lancedb disabled — vector store slot may fail");
  } else {
    const prev = JSON.stringify(memoryLance);
    entries["memory-lancedb"] = { ...memoryLance, enabled: true };
    if (prev !== JSON.stringify(entries["memory-lancedb"])) {
      actions.push("plugins.entries.memory-lancedb: enabled");
      changed = true;
    }
  }

  const slots = (plugins.slots ?? {}) as Record<string, string>;
  if (slots.memory !== "memory-lancedb") {
    plugins.slots = { ...slots, memory: "memory-lancedb" };
    actions.push("plugins.slots.memory = memory-lancedb");
    changed = true;
  }

  const robotEntry = entries["claworks-robot"] ?? {};
  entries["claworks-robot"] = robotEntry;
  const robotConfig = (robotEntry.config ?? {}) as ClaworksRobotConfig;
  robotEntry.config = robotConfig;
  robotConfig.data ??= {};

  const stateDir = defaultClaworksStateDir();
  const kbPath = join(stateDir, "kb", "lancedb");
  if (!robotConfig.data.kb_path || opts?.force) {
    robotConfig.data.kb_path = kbPath;
    actions.push(`data.kb_path -> ${kbPath}`);
    changed = true;
  }
  if (robotConfig.data.kb_provider !== "memory-core") {
    robotConfig.data.kb_provider = "memory-core";
    actions.push("data.kb_provider = memory-core");
    changed = true;
  }
  const embedModel =
    robotConfig.data.kb_embed_model?.trim() ||
    robotConfig.model_router?.embed?.trim() ||
    "text-embedding-3-small";
  if (!robotConfig.data.kb_embed_model) {
    robotConfig.data.kb_embed_model = embedModel;
    actions.push(`data.kb_embed_model = ${embedModel}`);
    changed = true;
  }

  const lanceEntry = entries["memory-lancedb"] ?? {};
  const lanceCfg = (lanceEntry.config ?? {}) as Record<string, unknown>;
  const embedding = (lanceCfg.embedding ?? {}) as Record<string, unknown>;
  if (embedding.model !== embedModel) {
    entries["memory-lancedb"] = {
      ...lanceEntry,
      enabled: lanceEntry.enabled !== false,
      config: {
        ...lanceCfg,
        embedding: { ...embedding, model: embedModel },
      },
    };
    actions.push(`plugins.entries.memory-lancedb.embedding.model = ${embedModel}`);
    changed = true;
  }

  return { changed, actions, warnings };
}

export function repairClaworksRobotPluginConfig(
  config: Record<string, unknown>,
  opts?: { packSourceDir?: string | null; enableEchoConnector?: boolean },
): ProductConfigRepairResult {
  const actions: string[] = [];
  const warnings: string[] = [];
  let changed = false;

  const plugins = (config.plugins ?? {}) as Record<string, unknown>;
  config.plugins = plugins;

  const allow = Array.isArray(plugins.allow) ? [...(plugins.allow as string[])] : [];
  if (!allow.includes("claworks-robot")) {
    allow.unshift("claworks-robot");
    plugins.allow = allow;
    actions.push("plugins.allow: added claworks-robot");
    changed = true;
  }

  const entries = (plugins.entries ?? {}) as Record<string, Record<string, unknown>>;
  plugins.entries = entries;

  const entry = entries["claworks-robot"] ?? {};
  entries["claworks-robot"] = entry;
  if (entry.enabled === false) {
    entry.enabled = true;
    actions.push("plugins.entries.claworks-robot.enabled: true");
    changed = true;
  } else if (entry.enabled !== true) {
    entry.enabled = true;
    actions.push("plugins.entries.claworks-robot: created/enabled");
    changed = true;
  }

  const pluginConfig = (entry.config ?? {}) as ClaworksRobotConfig & Record<string, unknown>;
  entry.config = pluginConfig;

  pluginConfig.robot ??= {
    name: "local-robot",
    role: "monolith",
    host: "127.0.0.1",
    port: Number(process.env.CLAWORKS_GATEWAY_PORT || 18_800),
  };

  pluginConfig.data ??= {
    database_url: `sqlite://${join(homedir(), ".claworks", "robot.db")}`,
  };

  const packs = pluginConfig.packs ?? {};
  pluginConfig.packs = packs;

  const statePacks = join(homedir(), ".claworks", "packs");
  const sourceDir = opts?.packSourceDir ?? discoverPackSourceDir();
  const paths = new Set(
    [...(packs.paths ?? []), statePacks, sourceDir].filter(
      (p): p is string => typeof p === "string" && p.length > 0,
    ),
  );
  if (paths.size > (packs.paths?.length ?? 0)) {
    packs.paths = [...paths];
    actions.push(`packs.paths: ${[...paths].join(", ")}`);
    changed = true;
  }

  const installed = new Set([...(packs.installed ?? []), ...DEFAULT_CLAWORKS_PACK_IDS]);
  if (installed.size > (packs.installed?.length ?? 0)) {
    packs.installed = [...installed];
    actions.push(`packs.installed: ${[...installed].join(", ")}`);
    changed = true;
  }

  const layerConflict = detectPackLayerSystemConflict(packs.installed ?? []);
  if (layerConflict.conflict && layerConflict.message) {
    warnings.push(layerConflict.message);
  } else if (layerConflict.message) {
    warnings.push(layerConflict.message);
  }

  const productionMode =
    pluginConfig.production_mode === true || isClaworksProductionMode(pluginConfig);

  const connectors = (pluginConfig.connectors ?? {}) as Record<string, unknown>;
  if (opts?.enableEchoConnector !== false && !connectors.echo && !productionMode) {
    pluginConfig.connectors = {
      ...connectors,
      echo: { preset: "echo", enabled: true },
    };
    actions.push("connectors.echo: enabled (demo OT/events)");
    changed = true;
  }

  pluginConfig.im_bridge ??= {};
  if (pluginConfig.im_bridge.auto_on_message_received !== true) {
    pluginConfig.im_bridge.auto_on_message_received = true;
    actions.push("im_bridge.auto_on_message_received = true (IM 渠道 → EventKernel)");
    changed = true;
  }

  pluginConfig.notify ??= {};
  if (!pluginConfig.notify.default_channel) {
    pluginConfig.notify.default_channel = "feishu";
    actions.push("notify.default_channel = feishu");
    changed = true;
  }

  const notifyRepair = repairNotifyTargets(config, pluginConfig, {
    stateDir: defaultClaworksStateDir(),
  });
  if (notifyRepair.changed) {
    actions.push(...notifyRepair.actions);
    changed = true;
  }

  const otRepair = repairOtConnectorSimulateFlags(
    pluginConfig.connectors as Record<string, { simulate?: boolean; preset?: string }> | undefined,
    {
      productionMode:
        pluginConfig.production_mode === true || isClaworksProductionMode(pluginConfig),
    },
  );
  if (otRepair.changed) {
    pluginConfig.connectors = otRepair.connectors;
    actions.push(...otRepair.actions);
    changed = true;
  }

  if (productionMode) {
    const echoCfg = (pluginConfig.connectors as Record<string, { enabled?: boolean }>)?.echo;
    if (echoCfg && echoCfg.enabled !== false) {
      pluginConfig.connectors = {
        ...(pluginConfig.connectors as Record<string, unknown>),
        echo: { ...echoCfg, enabled: false },
      };
      actions.push("connectors.echo: disabled (demo OT, production)");
      changed = true;
    }
  }

  const seed = seedPacksToStateDir({
    sourceDir: sourceDir ?? undefined,
    packIds: packs.installed,
  });
  if (seed.linked.length > 0) {
    actions.push(`~/.claworks/packs linked: ${seed.linked.join(", ")}`);
    changed = true;
  }
  warnings.push(...seed.warnings);
  if (seed.missing.length > 0) {
    warnings.push(`Pack sources missing on disk: ${seed.missing.join(", ")}`);
  }

  return { changed, actions, warnings };
}

export function isClaworksRobotConfigPresent(config: Record<string, unknown>): boolean {
  const entry = (config.plugins as { entries?: Record<string, { enabled?: boolean }> } | undefined)
    ?.entries?.["claworks-robot"];
  return entry?.enabled !== false;
}

export function defaultClaworksStateDir(): string {
  return process.env.OPENCLAW_STATE_DIR?.trim() || join(homedir(), ".claworks");
}

export function discoverRobotMdExamplePath(cwd = process.cwd()): string | null {
  const candidates = [
    join(cwd, "contrib/examples/robot.md"),
    join(cwd, "..", "claworks", "contrib/examples/robot.md"),
    join(fileURLToPath(new URL("../../../..", import.meta.url)), "contrib/examples/robot.md"),
  ];
  for (const p of candidates) {
    if (existsSync(p)) {
      return resolve(p);
    }
  }
  return null;
}

/** Seed ~/.claworks/robot.md from contrib/examples when missing. */
export function seedRobotMdFromExample(opts?: { stateDir?: string; examplePath?: string }): {
  seeded: boolean;
  path: string;
  message: string | null;
} {
  const stateDir = opts?.stateDir?.trim() || defaultClaworksStateDir();
  const dest = join(stateDir, "robot.md");
  if (existsSync(dest)) {
    return { seeded: false, path: dest, message: null };
  }
  const example = opts?.examplePath?.trim() || discoverRobotMdExamplePath();
  if (!example || !existsSync(example)) {
    return {
      seeded: false,
      path: dest,
      message: "robot.md example not found — copy contrib/examples/robot.md manually",
    };
  }
  mkdirSync(stateDir, { recursive: true });
  copyFileSync(example, dest);
  return { seeded: true, path: dest, message: `robot.md seeded from ${example}` };
}

/**
 * Full claworks.json repair: gateway port, plugins/packs/connectors, kb_provider, robot.md seed.
 * Mutates `config` in place (same object returned).
 */
export function repairClaworksJsonConfig(
  config: Record<string, unknown>,
  opts?: {
    packSourceDir?: string | null;
    stateDir?: string;
    seedRobotMd?: boolean;
    enableEchoConnector?: boolean;
  },
): ProductConfigRepairResult & { robotMd?: ReturnType<typeof seedRobotMdFromExample> } {
  const actions: string[] = [];
  const warnings: string[] = [];
  let changed = false;

  const gateway = (config.gateway ?? {}) as Record<string, unknown>;
  config.gateway = gateway;
  const gwPort = gateway.port;
  if (
    typeof gwPort !== "number" ||
    gwPort === OPENCLAW_RESERVED_GATEWAY_PORT ||
    !Number.isFinite(gwPort) ||
    gwPort <= 0
  ) {
    gateway.port = CLAWORKS_STANDARD_GATEWAY_PORT;
    actions.push(
      `gateway.port -> ${CLAWORKS_STANDARD_GATEWAY_PORT} (ClaWorks 标准端口，避免占用 ${OPENCLAW_RESERVED_GATEWAY_PORT})`,
    );
    changed = true;
  }

  const pluginAllowRepair = repairProductPluginsAllow(config);
  actions.push(...pluginAllowRepair.actions);
  warnings.push(...pluginAllowRepair.warnings);
  if (pluginAllowRepair.changed) {
    changed = true;
  }

  const pluginRepair = repairClaworksRobotPluginConfig(config, {
    packSourceDir: opts?.packSourceDir,
    enableEchoConnector: opts?.enableEchoConnector,
  });
  actions.push(...pluginRepair.actions);
  warnings.push(...pluginRepair.warnings);
  if (pluginRepair.changed) {
    changed = true;
  }

  const plugins = config.plugins as {
    allow?: string[];
    entries?: Record<string, { config?: ClaworksRobotConfig }>;
  };
  const entry = plugins?.entries?.["claworks-robot"];
  const robotConfig = entry?.config;
  if (robotConfig?.robot?.port === OPENCLAW_RESERVED_GATEWAY_PORT) {
    robotConfig.robot.port = CLAWORKS_STANDARD_GATEWAY_PORT;
    actions.push(`robot.port -> ${CLAWORKS_STANDARD_GATEWAY_PORT}`);
    changed = true;
  }

  if (isPersonalWorkProfile()) {
    const personal = repairPersonalEnterpriseProfile(config);
    actions.push(...personal.actions);
    warnings.push(...personal.warnings);
    if (personal.changed) {
      changed = true;
    }
  }

  const enableVectorKb =
    process.env.CLAWORKS_VECTOR_KB === "1" ||
    process.env.CLAWORKS_PRODUCT_PROFILE?.trim() === "personal_work" ||
    process.env.CLAWORKS_INIT_PROFILE?.trim() === "enterprise" ||
    process.env.CLAWORKS_PRODUCT === "1" ||
    (plugins?.allow ?? []).includes("memory-core") ||
    (plugins?.allow ?? []).includes("memory-lancedb");
  if (enableVectorKb) {
    const vectorRepair = repairVectorKnowledgeBase(config);
    actions.push(...vectorRepair.actions);
    warnings.push(...vectorRepair.warnings);
    if (vectorRepair.changed) {
      changed = true;
    }
  } else if ((plugins?.allow ?? []).includes("memory-core") && robotConfig?.data) {
    if (!robotConfig.data.kb_provider) {
      robotConfig.data.kb_provider = "memory-core";
      actions.push("data.kb_provider = memory-core");
      changed = true;
    }
  }

  let robotMd: ReturnType<typeof seedRobotMdFromExample> | undefined;
  if (opts?.seedRobotMd !== false) {
    robotMd = seedRobotMdFromExample({ stateDir: opts?.stateDir });
    if (robotMd.seeded) {
      actions.push(robotMd.message ?? "robot.md seeded");
      changed = true;
    } else if (robotMd.message) {
      warnings.push(robotMd.message);
    }
  }

  return { changed, actions, warnings, robotMd };
}
