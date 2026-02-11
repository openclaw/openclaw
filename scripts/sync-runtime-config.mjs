#!/usr/bin/env node

/**
 * Synchronize runtime env vars into /data/openclaw.json on startup.
 *
 * Runs before the gateway starts. Idempotent — re-running converges to the
 * same config state. Only writes if changes are detected.
 *
 * Design:
 * - Additive: only sets fields owned by env-driven config
 * - Preserves explicit user overrides already in the file
 * - Non-fatal: exits 0 even on error so gateway always starts
 */

import fs from "node:fs";

function trim(value) {
  return String(value ?? "").trim();
}

function readConfig(configPath) {
  try {
    return JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch {
    return {};
  }
}

function ensureObject(target, key) {
  if (typeof target[key] !== "object" || target[key] === null || Array.isArray(target[key])) {
    target[key] = {};
  }
  return target[key];
}

function ensureArray(target, key) {
  if (!Array.isArray(target[key])) {
    target[key] = [];
  }
  return target[key];
}

function providerFromModel(model) {
  const m = trim(model);
  return m.includes("/") ? m.slice(0, m.indexOf("/")) : "";
}

function toUniqueStrings(values) {
  const seen = new Set();
  return values.filter((v) => {
    if (typeof v !== "string") return false;
    const n = trim(v);
    if (!n || seen.has(n)) return false;
    seen.add(n);
    return true;
  });
}

// Provider priority order — first available becomes primary.
const PROVIDERS = [
  {
    provider: "anthropic",
    envVar: "ANTHROPIC_API_KEY",
    profileKey: "anthropic:default",
    primaryModel: "anthropic/claude-sonnet-4-5",
    fallbackModels: ["anthropic/claude-haiku-4-5"],
  },
  {
    provider: "openai-codex",
    envVar: "OPENAI_API_KEY",
    profileKey: "openai-codex:default",
    primaryModel: "openai-codex/gpt-5.3-codex",
    fallbackModels: ["openai-codex/gpt-5.2-codex"],
  },
  {
    provider: "openai",
    envVar: "OPENAI_API_KEY",
    profileKey: "openai:default",
    primaryModel: "openai/gpt-5.2",
    fallbackModels: ["openai/gpt-4o"],
  },
  {
    provider: "google",
    envVar: "GOOGLE_API_KEY",
    profileKey: "google:default",
    primaryModel: "google/gemini-3-pro-preview",
    fallbackModels: [],
  },
];

const PROVIDERS_BY_NAME = new Map(PROVIDERS.map((p) => [p.provider, p]));

try {
  const stateDir = trim(process.env.OPENCLAW_STATE_DIR) || "/data";
  const configPath = trim(process.env.OPENCLAW_CONFIG_FILE) || `${stateDir}/openclaw.json`;

  if (!fs.existsSync(configPath)) {
    console.log(`[sync-config] No config at ${configPath}; creating minimal default.`);
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(configPath, "{}\n");
  }

  const config = readConfig(configPath);
  const original = JSON.stringify(config);

  // --- Workspace ---
  const desiredWorkspace = trim(process.env.OPENCLAW_WORKSPACE_DIR) || `${stateDir}/workspace`;
  const agents = ensureObject(config, "agents");
  const defaults = ensureObject(agents, "defaults");
  if (defaults.workspace !== desiredWorkspace) {
    defaults.workspace = desiredWorkspace;
    console.log(`[sync-config] Set agents.defaults.workspace=${desiredWorkspace}`);
  }

  // --- Auth profiles from API keys ---
  const auth = ensureObject(config, "auth");
  const profiles = ensureObject(auth, "profiles");
  const availableProviders = [];
  const seenEnvVars = new Set();

  for (const pc of PROVIDERS) {
    if (!trim(process.env[pc.envVar])) continue;
    // Avoid double-counting providers that share an env var (openai + openai-codex).
    if (seenEnvVars.has(pc.envVar)) continue;
    seenEnvVars.add(pc.envVar);
    availableProviders.push(pc.provider);

    const existing = profiles[pc.profileKey];
    if (!existing || existing.mode !== "token" || existing.provider !== pc.provider) {
      profiles[pc.profileKey] = { mode: "token", provider: pc.provider };
      console.log(`[sync-config] Set auth.profiles.${pc.profileKey}`);
    }
  }

  // --- Model selection ---
  if (availableProviders.length > 0) {
    const model = ensureObject(defaults, "model");
    const currentPrimary = trim(model.primary);
    const currentProvider = providerFromModel(currentPrimary);

    // Only reset primary if it points to a provider with no key.
    if (!currentPrimary || !availableProviders.includes(currentProvider)) {
      const preferred = PROVIDERS_BY_NAME.get(availableProviders[0]);
      if (preferred && model.primary !== preferred.primaryModel) {
        model.primary = preferred.primaryModel;
        console.log(`[sync-config] Set agents.defaults.model.primary=${preferred.primaryModel}`);
      }
    }

    // Build fallbacks from other available providers.
    const activePrimaryProvider = providerFromModel(model.primary);
    const recommended = toUniqueStrings(
      availableProviders
        .filter((p) => p !== activePrimaryProvider)
        .flatMap((p) => {
          const pc = PROVIDERS_BY_NAME.get(p);
          return pc ? [pc.primaryModel, ...pc.fallbackModels] : [];
        })
        .filter((m) => providerFromModel(m) !== activePrimaryProvider),
    );

    const existing = Array.isArray(model.fallbacks) ? model.fallbacks : [];
    const filtered = toUniqueStrings(
      existing.filter((m) => {
        const p = providerFromModel(m);
        return p && availableProviders.includes(p) && m !== model.primary;
      }),
    );

    // Merge missing providers into fallbacks.
    const fbProviders = new Set(filtered.map(providerFromModel).filter(Boolean));
    const missing = recommended.filter((m) => !fbProviders.has(providerFromModel(m)));
    const merged = toUniqueStrings([...filtered, ...missing]);

    if (JSON.stringify(existing) !== JSON.stringify(merged)) {
      model.fallbacks = merged;
      console.log(`[sync-config] Set agents.defaults.model.fallbacks=${JSON.stringify(merged)}`);
    }
  }

  // --- Agent defaults from env ---
  const thinkingDefault = trim(process.env.OPENCLAW_THINKING_DEFAULT);
  if (thinkingDefault && defaults.thinkingDefault !== thinkingDefault) {
    defaults.thinkingDefault = thinkingDefault;
    console.log(`[sync-config] Set agents.defaults.thinkingDefault=${thinkingDefault}`);
  }

  const maxConcurrent = trim(process.env.OPENCLAW_MAX_CONCURRENT);
  if (maxConcurrent && defaults.maxConcurrent !== Number(maxConcurrent)) {
    defaults.maxConcurrent = Number(maxConcurrent);
    console.log(`[sync-config] Set agents.defaults.maxConcurrent=${maxConcurrent}`);
  }

  // Context pruning
  const pruningMode = trim(process.env.OPENCLAW_CONTEXT_PRUNING_MODE);
  if (pruningMode) {
    const pruning = ensureObject(defaults, "contextPruning");
    if (pruning.mode !== pruningMode) {
      pruning.mode = pruningMode;
      console.log(`[sync-config] Set agents.defaults.contextPruning.mode=${pruningMode}`);
    }
    const ttl = trim(process.env.OPENCLAW_CONTEXT_PRUNING_TTL);
    if (ttl && pruning.ttl !== ttl) {
      pruning.ttl = ttl;
      console.log(`[sync-config] Set agents.defaults.contextPruning.ttl=${ttl}`);
    }
  }

  // Compaction
  const compactionMode = trim(process.env.OPENCLAW_COMPACTION_MODE);
  if (compactionMode) {
    const compaction = ensureObject(defaults, "compaction");
    if (compaction.mode !== compactionMode) {
      compaction.mode = compactionMode;
      console.log(`[sync-config] Set agents.defaults.compaction.mode=${compactionMode}`);
    }
  }

  // Heartbeat
  const heartbeatEvery = trim(process.env.OPENCLAW_HEARTBEAT_EVERY);
  if (heartbeatEvery) {
    const heartbeat = ensureObject(defaults, "heartbeat");
    if (heartbeat.every !== heartbeatEvery) {
      heartbeat.every = heartbeatEvery;
      console.log(`[sync-config] Set agents.defaults.heartbeat.every=${heartbeatEvery}`);
    }
  }

  // --- Gateway ---
  const gatewayToken = trim(process.env.OPENCLAW_GATEWAY_TOKEN);
  if (gatewayToken) {
    const gateway = ensureObject(config, "gateway");
    const gwAuth = ensureObject(gateway, "auth");
    if (gwAuth.mode !== "token" || gwAuth.token !== gatewayToken) {
      gwAuth.mode = "token";
      gwAuth.token = gatewayToken;
      console.log("[sync-config] Set gateway.auth.token from OPENCLAW_GATEWAY_TOKEN");
    }
  }

  // --- Telegram ---
  const telegramToken = trim(process.env.TELEGRAM_BOT_TOKEN);
  if (telegramToken) {
    const channels = ensureObject(config, "channels");
    const tg = ensureObject(channels, "telegram");
    if (tg.enabled !== true) {
      tg.enabled = true;
      console.log("[sync-config] Set channels.telegram.enabled=true");
    }
    const plugins = ensureObject(config, "plugins");
    const entries = ensureObject(plugins, "entries");
    const tgPlugin = ensureObject(entries, "telegram");
    if (tgPlugin.enabled !== true) {
      tgPlugin.enabled = true;
      console.log("[sync-config] Set plugins.entries.telegram.enabled=true");
    }
  }

  // --- Discord ---
  const discordToken = trim(process.env.DISCORD_BOT_TOKEN);
  const discordGuildId = trim(process.env.DISCORD_GUILD_ID);
  if (discordToken && discordGuildId) {
    const channels = ensureObject(config, "channels");
    const dc = ensureObject(channels, "discord");
    if (dc.enabled !== true) {
      dc.enabled = true;
      console.log("[sync-config] Set channels.discord.enabled=true");
    }
    const plugins = ensureObject(config, "plugins");
    const entries = ensureObject(plugins, "entries");
    const dcPlugin = ensureObject(entries, "discord");
    if (dcPlugin.enabled !== true) {
      dcPlugin.enabled = true;
      console.log("[sync-config] Set plugins.entries.discord.enabled=true");
    }
  }

  // --- Write ---
  const updated = JSON.stringify(config);
  if (updated !== original) {
    fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
    console.log(`[sync-config] Config updated at ${configPath}`);
  } else {
    console.log("[sync-config] Config already matches desired state.");
  }
} catch (err) {
  // Non-fatal — gateway must always start.
  console.error(`[sync-config] Warning: ${err.message}`);
}
