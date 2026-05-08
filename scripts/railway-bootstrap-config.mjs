#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const DEFAULT_TEMPLATE_CONFIG_PATH = join(REPO_ROOT, "railway.openclaw.config.json");
const DEFAULT_PERSONA_TEMPLATE_PATH = join(
  REPO_ROOT,
  "deploy",
  "railway",
  "workspaces",
  "discord-jester",
  "AGENTS.md",
);
const DEFAULT_DISCORD_AGENT_ID = "discord-jester";
const DEFAULT_DISCORD_AGENT_NAME = "Grumbleghast";
const DEFAULT_MAIN_AGENT_ID = "main";
const DEFAULT_MODEL_PROFILE_PRIMARY_MAP = Object.freeze({
  "codex-plan": "openai-codex/gpt-5.4",
  "openrouter-free": "openrouter/cognitivecomputations/dolphin-mistral-24b-venice-edition:free",
});
const DEFAULT_RAILWAY_PLUGIN_INSTALLS = Object.freeze([
  { id: "claw-messenger", spec: "@emotion-machine/claw-messenger" },
  { id: "openclaw-mem0", spec: "clawhub:@mem0/openclaw-mem0" },
  { id: "lobster", spec: "clawhub:@openclaw/lobster" },
]);
const DEFAULT_RAILWAY_SKILLS = Object.freeze(["gog", "web-search", "github", "weather"]);
const DEFAULT_CHECKIN_TIMEZONE = "UTC";
const DEFAULT_CHECKIN_TIMES = ["09:15", "13:15", "18:15", "22:15"];
const DEFAULT_CHECKIN_PROMPT = [
  "Post one short in-character Discord message as Grumbleghast.",
  "If there is an obvious recent theme in the room, riff on it briefly.",
  "If not, post a funny, self-contained non sequitur.",
  "Keep it to 1-2 sentences, theatrical and grumpy, not helpful or formal.",
  "If nothing amusing comes to mind, reply with NO_REPLY.",
].join(" ");
const MANAGED_CHECKIN_JOB_ID_PREFIX = "railway-discord-checkin";
const MANAGED_CHECKIN_JOB_NAME_PREFIX = "Discord Check-in";

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function parseCsvEnv(value) {
  if (typeof value !== "string") {
    return [];
  }
  const seen = new Set();
  const entries = [];
  for (const rawPart of value.split(",")) {
    const part = rawPart.trim();
    if (!part || seen.has(part)) {
      continue;
    }
    seen.add(part);
    entries.push(part);
  }
  return entries;
}

function parseBooleanEnv(value, fallback) {
  if (typeof value !== "string" || value.trim() === "") {
    return fallback;
  }
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  return fallback;
}

function normalizeOptionalString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function updateModelPrimary(modelConfig, primary) {
  if (!primary) {
    return modelConfig;
  }
  if (modelConfig && typeof modelConfig === "object" && !Array.isArray(modelConfig)) {
    return {
      ...modelConfig,
      primary,
    };
  }
  return {
    primary,
  };
}

function updateModelFallbacks(modelConfig, fallbacks) {
  if (!Array.isArray(fallbacks) || fallbacks.length === 0) {
    return modelConfig;
  }
  if (modelConfig && typeof modelConfig === "object" && !Array.isArray(modelConfig)) {
    return {
      ...modelConfig,
      fallbacks,
    };
  }
  return {
    fallbacks,
  };
}

function readJsonFile(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function writeJsonFile(filePath, value) {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function ensureArray(value) {
  return Array.isArray(value) ? value : [];
}

function ensureObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function findAgent(config, agentId = DEFAULT_DISCORD_AGENT_ID) {
  return ensureArray(config?.agents?.list).find((entry) => entry?.id === agentId) ?? null;
}

function ensureStringArray(value) {
  return Array.isArray(value) ? value.filter((entry) => typeof entry === "string" && entry.trim()) : [];
}

function resolveDefaultModelProfile(env = process.env) {
  const rawProfile = normalizeOptionalString(env.OPENCLAW_DEFAULT_MODEL_PROFILE);
  if (!rawProfile) {
    return null;
  }
  const normalized = rawProfile.toLowerCase();
  return DEFAULT_MODEL_PROFILE_PRIMARY_MAP[normalized] ? normalized : null;
}

function resolveDefaultPrimaryModelOverride(env = process.env) {
  const explicitPrimary = normalizeOptionalString(env.OPENCLAW_DEFAULT_MODEL_PRIMARY);
  if (explicitPrimary) {
    return explicitPrimary;
  }
  const profile = resolveDefaultModelProfile(env);
  return profile ? (DEFAULT_MODEL_PROFILE_PRIMARY_MAP[profile] ?? null) : null;
}

function resolveDefaultFallbackModelsOverride(env = process.env) {
  const explicitFallbacks = parseCsvEnv(env.OPENCLAW_DEFAULT_MODEL_FALLBACKS);
  if (explicitFallbacks.length > 0) {
    return explicitFallbacks;
  }
  const backup = normalizeOptionalString(env.OPENCLAW_DEFAULT_MODEL_BACKUP);
  return backup ? [backup] : null;
}

function resolveHeartbeatModelOverride(env = process.env) {
  return normalizeOptionalString(env.OPENCLAW_DEFAULT_HEARTBEAT_MODEL);
}

function applyDefaultModelOverrides(config, env = process.env) {
  const nextPrimary = resolveDefaultPrimaryModelOverride(env);
  const nextFallbacks = resolveDefaultFallbackModelsOverride(env);
  const nextHeartbeatModel = resolveHeartbeatModelOverride(env);
  if (!nextPrimary && !nextFallbacks && !nextHeartbeatModel) {
    return;
  }
  config.agents = ensureObject(config.agents);
  config.agents.defaults = ensureObject(config.agents.defaults);
  config.agents.defaults.model = updateModelPrimary(config.agents.defaults.model, nextPrimary);
  config.agents.defaults.model = updateModelFallbacks(config.agents.defaults.model, nextFallbacks);
  if (nextHeartbeatModel) {
    config.agents.defaults.heartbeat = ensureObject(config.agents.defaults.heartbeat);
    config.agents.defaults.heartbeat.model = nextHeartbeatModel;
  }
}

function ensureDiscordAgent(config, templateConfig, agentId = DEFAULT_DISCORD_AGENT_ID) {
  const existingAgent = findAgent(config, agentId);
  if (existingAgent) {
    return existingAgent;
  }
  const templateAgent = findAgent(templateConfig, agentId);
  if (!templateAgent) {
    return null;
  }
  config.agents = ensureObject(config.agents);
  const list = ensureArray(config.agents.list);
  const nextAgent = cloneJson(templateAgent);
  list.push(nextAgent);
  config.agents.list = list;
  return nextAgent;
}

function resolveDiscordGuildRouteBindingKey(binding, agentId = DEFAULT_DISCORD_AGENT_ID) {
  if (binding?.agentId !== agentId || binding?.match?.channel !== "discord") {
    return null;
  }
  return normalizeOptionalString(binding?.match?.guildId);
}

function ensureTemplateDiscordBindings(config, templateConfig, agentId = DEFAULT_DISCORD_AGENT_ID) {
  const templateBindings = ensureArray(templateConfig?.bindings);
  if (templateBindings.length === 0) {
    return;
  }
  const nextBindings = ensureArray(config.bindings);
  const seenGuildIds = new Set(
    nextBindings
      .map((binding) => resolveDiscordGuildRouteBindingKey(binding, agentId))
      .filter(Boolean),
  );
  for (const binding of templateBindings) {
    const guildId = resolveDiscordGuildRouteBindingKey(binding, agentId);
    if (!guildId || seenGuildIds.has(guildId)) {
      continue;
    }
    nextBindings.push(cloneJson(binding));
    seenGuildIds.add(guildId);
  }
  config.bindings = nextBindings;
}

function ensureTemplateDiscordGuilds(config, templateConfig) {
  const templateGuilds = ensureObject(templateConfig?.channels?.discord?.guilds);
  if (Object.keys(templateGuilds).length === 0) {
    return;
  }
  config.channels = ensureObject(config.channels);
  const existingDiscord = ensureObject(config.channels.discord);
  const existingGuilds = ensureObject(existingDiscord.guilds);
  config.channels.discord = {
    ...existingDiscord,
    guilds: {
      ...templateGuilds,
      ...existingGuilds,
    },
  };
}

function ensureMainAgentLobsterTool(config) {
  const agent = findAgent(config, DEFAULT_MAIN_AGENT_ID);
  if (!agent) {
    return;
  }
  agent.tools = ensureObject(agent.tools);
  const alsoAllow = new Set(ensureStringArray(agent.tools.alsoAllow));
  alsoAllow.add("lobster");
  agent.tools.alsoAllow = [...alsoAllow];
}

function applyMem0PluginConfig(config, env = process.env) {
  const mem0ApiKey = normalizeOptionalString(env.MEM0_API_KEY);
  if (!mem0ApiKey) {
    return;
  }
  config.plugins = ensureObject(config.plugins);
  config.plugins.entries = ensureObject(config.plugins.entries);
  config.plugins.entries["openclaw-mem0"] = {
    enabled: true,
    config: {
      mode: "platform",
      apiKey: "${MEM0_API_KEY}",
      userId: "default",
      autoCapture: true,
      autoRecall: true,
    },
  };
}

function parseCheckinTimes(value) {
  const rawTimes = parseCsvEnv(value);
  const times = rawTimes.length > 0 ? rawTimes : DEFAULT_CHECKIN_TIMES;
  const normalized = [];
  const seen = new Set();
  for (const rawTime of times) {
    const match = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(rawTime);
    if (!match) {
      continue;
    }
    const hour = Number(match[1]);
    const minute = Number(match[2]);
    const normalizedTime = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
    if (seen.has(normalizedTime)) {
      continue;
    }
    seen.add(normalizedTime);
    normalized.push(normalizedTime);
  }
  return normalized;
}

function buildDiscordCheckinSpec(params = {}) {
  const env = params.env ?? process.env;
  const rawChannelId = normalizeOptionalString(env.OPENCLAW_DISCORD_CHECKIN_CHANNEL_ID);
  if (!rawChannelId) {
    return null;
  }
  // "last" means post to whichever Discord channel the bot was most recently active in.
  const channelId = rawChannelId === "last" ? null : rawChannelId;
  const timezone =
    normalizeOptionalString(env.OPENCLAW_DISCORD_CHECKIN_TIMEZONE) ??
    normalizeOptionalString(env.TZ) ??
    DEFAULT_CHECKIN_TIMEZONE;
  const times = parseCheckinTimes(env.OPENCLAW_DISCORD_CHECKIN_TIMES);
  if (times.length === 0) {
    return null;
  }
  const prompt = normalizeOptionalString(env.OPENCLAW_DISCORD_CHECKIN_PROMPT) ?? DEFAULT_CHECKIN_PROMPT;
  return {
    channelId,
    timezone,
    times,
    prompt,
    accountId: normalizeOptionalString(env.OPENCLAW_DISCORD_ACCOUNT_ID),
  };
}

function buildDiscordCheckinJobs(params = {}) {
  const env = params.env ?? process.env;
  const spec = params.spec ?? buildDiscordCheckinSpec({ env });
  if (!spec) {
    return [];
  }
  const nowMs =
    typeof params.nowMs === "number" && Number.isFinite(params.nowMs) ? params.nowMs : Date.now();
  return spec.times.map((time, index) => {
    const [hour, minute] = time.split(":");
    return {
      id: `${MANAGED_CHECKIN_JOB_ID_PREFIX}-${index + 1}`,
      agentId: DEFAULT_DISCORD_AGENT_ID,
      name: `${MANAGED_CHECKIN_JOB_NAME_PREFIX} ${index + 1}`,
      description: `Managed Railway Discord check-in at ${time} ${spec.timezone}`,
      enabled: true,
      createdAtMs: nowMs,
      updatedAtMs: nowMs,
      schedule: {
        kind: "cron",
        expr: `${Number(minute)} ${Number(hour)} * * *`,
        tz: spec.timezone,
      },
      sessionTarget: "isolated",
      wakeMode: "next-heartbeat",
      payload: {
        kind: "agentTurn",
        message: spec.prompt,
      },
      delivery: {
        mode: "announce",
        channel: "discord",
        ...(spec.channelId ? { to: `channel:${spec.channelId}` } : {}),
        ...(spec.accountId ? { accountId: spec.accountId } : {}),
      },
      state: {},
    };
  });
}

function mergeManagedCronJobs(params = {}) {
  const env = params.env ?? process.env;
  const store = cloneJson(params.store ?? { version: 1, jobs: [] });
  const managedJobs = buildDiscordCheckinJobs({ env, nowMs: params.nowMs, spec: params.spec });
  const unmanagedJobs = ensureArray(store.jobs).filter(
    (job) => !(typeof job?.id === "string" && job.id.startsWith(`${MANAGED_CHECKIN_JOB_ID_PREFIX}-`)),
  );
  store.version = 1;
  store.jobs = [...unmanagedJobs];
  for (const managedJob of managedJobs) {
    const existingJob = ensureArray(params.store?.jobs).find((job) => job?.id === managedJob.id);
    if (existingJob) {
      store.jobs.push({
        ...managedJob,
        createdAtMs:
          typeof existingJob.createdAtMs === "number" && Number.isFinite(existingJob.createdAtMs)
            ? existingJob.createdAtMs
            : managedJob.createdAtMs,
        updatedAtMs: managedJob.updatedAtMs,
      });
      continue;
    }
    store.jobs.push(managedJob);
  }
  return store;
}

function resolveCronStorePath(config, stateDir) {
  const configuredPath = normalizeOptionalString(config?.cron?.store);
  return configuredPath || join(stateDir, "cron", "jobs.json");
}

// When the auth command writes a minimal config (no agents.list), rebuild from
// the template so structural sections aren't lost, but carry over auth credentials.
function resolveBootstrapBase(existingConfig, templateConfig) {
  if (!existingConfig) {
    return templateConfig;
  }
  if (ensureArray(existingConfig?.agents?.list).length > 0) {
    return existingConfig;
  }
  const base = cloneJson(templateConfig);
  if (existingConfig.auth) {
    base.auth = existingConfig.auth;
  }
  const existingModels = existingConfig?.agents?.defaults?.models;
  if (existingModels && typeof existingModels === "object" && !Array.isArray(existingModels)) {
    base.agents = ensureObject(base.agents);
    base.agents.defaults = ensureObject(base.agents.defaults);
    base.agents.defaults.models = {
      ...existingModels,
      ...ensureObject(base.agents.defaults.models),
    };
  }
  return base;
}

export function buildRailwayBootstrapConfig(params = {}) {
  const env = params.env ?? process.env;
  const templateConfig = cloneJson(
    params.templateConfig ?? readJsonFile(DEFAULT_TEMPLATE_CONFIG_PATH),
  );
  const baseConfig = cloneJson(params.baseConfig ?? templateConfig);
  const nextConfig = baseConfig;
  const guildId = env.OPENCLAW_DISCORD_GUILD_ID?.trim();
  const allowedUserIds = parseCsvEnv(env.OPENCLAW_DISCORD_ALLOWED_USER_IDS);
  const checkinSpec = buildDiscordCheckinSpec({ env });
  const allowedChannelIds = [
    ...new Set([
      ...parseCsvEnv(env.OPENCLAW_DISCORD_CHANNEL_IDS),
      ...(checkinSpec?.channelId ? [checkinSpec.channelId] : []),
    ]),
  ];
  const requireMention = parseBooleanEnv(env.OPENCLAW_DISCORD_REQUIRE_MENTION, true);
  const automaticGroupReplies = parseBooleanEnv(
    env.OPENCLAW_DISCORD_AUTOMATIC_GROUP_REPLIES,
    true,
  );
  const discordTokenEnv = env.OPENCLAW_DISCORD_TOKEN_ENV?.trim() || "DISCORD_BOT_TOKEN";
  const discordAgentName = env.OPENCLAW_DISCORD_AGENT_NAME?.trim() || null;
  applyDefaultModelOverrides(nextConfig, env);
  ensureMainAgentLobsterTool(nextConfig);
  applyMem0PluginConfig(nextConfig, env);

  if (guildId) {
    ensureDiscordAgent(nextConfig, templateConfig);
  }
  ensureTemplateDiscordBindings(nextConfig, templateConfig);
  ensureTemplateDiscordGuilds(nextConfig, templateConfig);

  const agent = findAgent(nextConfig);
  if (agent && discordAgentName) {
    agent.name = discordAgentName;
  }

  if (!guildId) {
    return nextConfig;
  }

  const guildConfig = {
    requireMention,
  };
  if (allowedUserIds.length > 0) {
    guildConfig.users = allowedUserIds;
  }
  if (allowedChannelIds.length > 0) {
    guildConfig.channels = Object.fromEntries(
      allowedChannelIds.map((channelId) => [channelId, { allow: true, requireMention }]),
    );
  }

  nextConfig.bindings = ensureArray(nextConfig.bindings).filter(
    (binding) =>
      !(
        binding?.agentId === DEFAULT_DISCORD_AGENT_ID &&
        binding?.match?.channel === "discord" &&
        binding?.match?.guildId === guildId
      ),
  );
  nextConfig.bindings.push({
    agentId: DEFAULT_DISCORD_AGENT_ID,
    match: {
      channel: "discord",
      guildId,
    },
  });

  nextConfig.channels = ensureObject(nextConfig.channels);
  const existingDiscord = ensureObject(nextConfig.channels.discord);
  const existingGuilds = ensureObject(existingDiscord.guilds);
  const nextGuildEntry = {
    ...ensureObject(existingGuilds[guildId]),
    ...guildConfig,
  };
  if (allowedChannelIds.length > 0) {
    nextGuildEntry.channels = guildConfig.channels;
  }
  if (allowedUserIds.length > 0) {
    nextGuildEntry.users = allowedUserIds;
  }
  nextConfig.channels.discord = {
    ...existingDiscord,
    enabled: true,
    dmPolicy: "pairing",
    groupPolicy: "allowlist",
    token: {
      source: "env",
      provider: "default",
      id: discordTokenEnv,
    },
    guilds: {
      ...existingGuilds,
      [guildId]: nextGuildEntry,
    },
  };

  if (automaticGroupReplies) {
    nextConfig.messages = ensureObject(nextConfig.messages);
    nextConfig.messages.groupChat = ensureObject(nextConfig.messages.groupChat);
    nextConfig.messages.groupChat.visibleReplies = "automatic";
  }

  return nextConfig;
}

export function resolveDiscordWorkspacePath(config, agentId = DEFAULT_DISCORD_AGENT_ID) {
  const agent = findAgent(config, agentId);
  return typeof agent?.workspace === "string" && agent.workspace.trim() ? agent.workspace : null;
}

export function resolveMainWorkspacePath(config, agentId = DEFAULT_MAIN_AGENT_ID) {
  const agent = findAgent(config, agentId);
  return typeof agent?.workspace === "string" && agent.workspace.trim() ? agent.workspace : null;
}

function formatCliFailure(result, args) {
  const stderr = typeof result?.stderr === "string" ? result.stderr.trim() : "";
  const stdout = typeof result?.stdout === "string" ? result.stdout.trim() : "";
  const details = stderr || stdout || `exit ${result?.status ?? "unknown"}`;
  return `openclaw ${args.join(" ")} failed: ${details}`;
}

function runOpenClawCli(args, params = {}) {
  const env = params.env ?? process.env;
  const cwd = params.cwd ?? REPO_ROOT;
  const runner = params.runner;
  if (typeof runner === "function") {
    return runner({ args, cwd, env });
  }
  const result = spawnSync(process.execPath, [join(REPO_ROOT, "openclaw.mjs"), ...args], {
    cwd,
    env,
    encoding: "utf8",
  });
  if (result.error) {
    throw result.error;
  }
  return result;
}

function parseJsonCommandOutput(result, args) {
  const stdout = typeof result?.stdout === "string" ? result.stdout.trim() : "";
  if (result?.status !== 0) {
    throw new Error(formatCliFailure(result, args));
  }
  if (!stdout) {
    throw new Error(`openclaw ${args.join(" ")} returned no JSON output`);
  }
  return JSON.parse(stdout);
}

function ensureWorkspaceDir(workspacePath) {
  if (!workspacePath) {
    return;
  }
  mkdirSync(workspacePath, { recursive: true });
}

export function bootstrapRailwayManagedInstalls(params = {}) {
  const env = params.env ?? process.env;
  const config = params.config ?? null;
  const enabled = parseBooleanEnv(env.OPENCLAW_RAILWAY_BOOTSTRAP_INSTALLS, true);
  if (!enabled) {
    return {
      installedPlugins: [],
      installedSkills: [],
      skipped: true,
    };
  }

  const runner = params.runner;
  const pluginListResult = runOpenClawCli(["plugins", "list", "--json"], { env, runner });
  const pluginReport = parseJsonCommandOutput(pluginListResult, ["plugins", "list", "--json"]);
  const installedPluginIds = new Set(
    ensureArray(pluginReport?.plugins)
      .map((plugin) => normalizeOptionalString(plugin?.id))
      .filter(Boolean),
  );

  const installedPlugins = [];
  for (const plugin of DEFAULT_RAILWAY_PLUGIN_INSTALLS) {
    if (installedPluginIds.has(plugin.id)) {
      continue;
    }
    const installArgs = ["plugins", "install", plugin.spec];
    const result = runOpenClawCli(installArgs, { env, runner });
    if (result?.status !== 0) {
      throw new Error(formatCliFailure(result, installArgs));
    }
    installedPlugins.push(plugin.id);
  }

  const mainWorkspacePath =
    normalizeOptionalString(params.mainWorkspacePath) ??
    normalizeOptionalString(resolveMainWorkspacePath(config));
  const installedSkills = [];
  if (mainWorkspacePath) {
    ensureWorkspaceDir(mainWorkspacePath);
    for (const skill of DEFAULT_RAILWAY_SKILLS) {
      const skillPath = join(mainWorkspacePath, "skills", skill, "SKILL.md");
      if (existsSync(skillPath)) {
        continue;
      }
      const installArgs = ["skills", "install", skill];
      const result = runOpenClawCli(installArgs, {
        cwd: mainWorkspacePath,
        env,
        runner,
      });
      if (result?.status !== 0) {
        throw new Error(formatCliFailure(result, installArgs));
      }
      installedSkills.push(skill);
    }
  }

  return {
    installedPlugins,
    installedSkills,
    skipped: false,
  };
}

export function seedRailwayBootstrapFiles(params = {}) {
  const env = params.env ?? process.env;
  const stateDir = env.OPENCLAW_STATE_DIR?.trim() || "/data/.openclaw";
  const configPath = env.OPENCLAW_CONFIG_PATH?.trim() || join(stateDir, "openclaw.json");
  const personaTemplateText =
    params.personaTemplateText ?? readFileSync(DEFAULT_PERSONA_TEMPLATE_PATH, "utf8");
  const templateConfig = params.templateConfig ?? readJsonFile(DEFAULT_TEMPLATE_CONFIG_PATH);
  const existingConfig = existsSync(configPath) ? readJsonFile(configPath) : null;
  const nextConfig = buildRailwayBootstrapConfig({
    env,
    baseConfig: params.baseConfig ?? resolveBootstrapBase(existingConfig, templateConfig),
    templateConfig,
  });

  let wroteConfig = false;
  if (!existingConfig || JSON.stringify(existingConfig) !== JSON.stringify(nextConfig)) {
    writeJsonFile(configPath, nextConfig);
    wroteConfig = true;
  }

  const activeConfig = wroteConfig ? nextConfig : (existingConfig ?? nextConfig);
  const workspacePath = resolveDiscordWorkspacePath(activeConfig);
  const mainWorkspacePath = resolveMainWorkspacePath(activeConfig);
  const discordEnabled = activeConfig?.channels?.discord?.enabled === true && Boolean(workspacePath);
  let wrotePersona = false;
  if (workspacePath) {
    const agentsPath = join(workspacePath, "AGENTS.md");
    if (!existsSync(agentsPath)) {
      mkdirSync(workspacePath, { recursive: true });
      writeFileSync(agentsPath, personaTemplateText, "utf8");
      wrotePersona = true;
    }
  }

  if (mainWorkspacePath) {
    ensureWorkspaceDir(mainWorkspacePath);
  }

  const cronStorePath = resolveCronStorePath(activeConfig, stateDir);
  const existingCronStore = existsSync(cronStorePath) ? readJsonFile(cronStorePath) : { version: 1, jobs: [] };
  const nextCronStore = mergeManagedCronJobs({
    env,
    store: existingCronStore,
    spec: discordEnabled ? buildDiscordCheckinSpec({ env }) : null,
  });
  let wroteCronStore = false;
  if (JSON.stringify(existingCronStore) !== JSON.stringify(nextCronStore)) {
    writeJsonFile(cronStorePath, nextCronStore);
    wroteCronStore = true;
  }

  const installResult = bootstrapRailwayManagedInstalls({
    env,
    config: activeConfig,
    mainWorkspacePath,
    runner: params.runner,
  });

  return {
    configPath,
    cronStorePath,
    workspacePath,
    mainWorkspacePath,
    wroteConfig,
    wroteCronStore,
    wrotePersona,
    installedPlugins: installResult.installedPlugins,
    installedSkills: installResult.installedSkills,
    skippedInstalls: installResult.skipped,
  };
}

function isDirectInvocation() {
  return process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
}

if (isDirectInvocation()) {
  const result = seedRailwayBootstrapFiles();
  if (result.wroteConfig) {
    console.log(`[railway-bootstrap] seeded config: ${result.configPath}`);
  }
  if (result.wroteCronStore) {
    console.log(`[railway-bootstrap] seeded cron jobs: ${result.cronStorePath}`);
  }
  if (result.wrotePersona && result.workspacePath) {
    console.log(`[railway-bootstrap] seeded persona: ${join(result.workspacePath, "AGENTS.md")}`);
  }
  for (const pluginId of result.installedPlugins) {
    console.log(`[railway-bootstrap] installed plugin: ${pluginId}`);
  }
  for (const skillName of result.installedSkills) {
    console.log(`[railway-bootstrap] installed skill: ${skillName}`);
  }
}
