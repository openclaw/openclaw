import fs from "node:fs";
import path from "node:path";

const command = process.argv[2];

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function write(file, contents) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
}

function writeJson(file, value) {
  write(file, `${JSON.stringify(value, null, 2)}\n`);
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function getConfig() {
  return readJson(requireEnv("OPENCLAW_CONFIG_PATH"));
}

function getCoverage() {
  const file = process.env.OPENCLAW_UPGRADE_SURVIVOR_CONFIG_COVERAGE_JSON;
  if (!file || !fs.existsSync(file)) {
    return null;
  }
  return readJson(file);
}

function acceptsIntent(coverage, id) {
  if (!coverage) {
    return true;
  }
  return Array.isArray(coverage.acceptedIntents) && coverage.acceptedIntents.includes(id);
}

function hasCoverage(coverage) {
  return !!coverage;
}

function seedState() {
  const stateDir = requireEnv("OPENCLAW_STATE_DIR");
  const workspace = requireEnv("OPENCLAW_TEST_WORKSPACE_DIR");

  write(
    path.join(workspace, "IDENTITY.md"),
    "# Upgrade Survivor\n\nThis workspace must survive package update and doctor repair.\n",
  );
  writeJson(path.join(workspace, ".openclaw", "workspace-state.json"), {
    version: 1,
    setupCompletedAt: "2026-04-01T00:00:00.000Z",
  });
  writeJson(path.join(stateDir, "agents", "main", "sessions", "legacy-session.json"), {
    id: "legacy-session",
    agentId: "main",
    title: "Existing user session",
  });

  const runtimeRoot = path.join(stateDir, "plugin-runtime-deps");
  for (const plugin of ["discord", "telegram", "whatsapp"]) {
    writeJson(path.join(runtimeRoot, plugin, ".openclaw-runtime-deps-stamp.json"), {
      version: 0,
      plugin,
      stale: true,
    });
    write(
      path.join(
        runtimeRoot,
        plugin,
        ".openclaw-runtime-deps-copy-stale",
        "node_modules",
        "stale-sentinel",
        "package.json",
      ),
      `${JSON.stringify({ name: "stale-sentinel", version: "0.0.0" }, null, 2)}\n`,
    );
  }

  writeJson(path.join(stateDir, "survivor-baseline.json"), {
    agents: ["main", "ops"],
    discordGuild: "222222222222222222",
    discordChannel: "333333333333333333",
    telegramGroup: "-1001234567890",
    whatsappGroup: "120363000000000000@g.us",
    workspaceIdentity: path.join(workspace, "IDENTITY.md"),
  });
}

function assertConfigSurvived() {
  const config = getConfig();
  const coverage = getCoverage();

  if (acceptsIntent(coverage, "update")) {
    assert(config.update?.channel === "stable", "update.channel was not preserved");
  }
  if (acceptsIntent(coverage, "gateway")) {
    assert(config.gateway?.auth?.mode === "token", "gateway auth mode was not preserved");
  }

  if (acceptsIntent(coverage, "models")) {
    assert(config.models?.providers?.openai, "OpenAI model provider missing");
  }

  if (acceptsIntent(coverage, "agents")) {
    const agents = config.agents?.list ?? [];
    assert(Array.isArray(agents), "agents.list missing after update/doctor");
    assert(
      agents.some((agent) => agent?.id === "main"),
      "main agent missing",
    );
    assert(
      agents.some((agent) => agent?.id === "ops"),
      "ops agent missing",
    );
    if (hasCoverage(coverage)) {
      assert(config.agents?.defaults?.contextTokens === 64000, "default contextTokens changed");
    } else {
      assert(
        agents.find((agent) => agent?.id === "main")?.contextTokens === 64000,
        "main agent contextTokens changed",
      );
    }
    assert(
      agents.find((agent) => agent?.id === "ops")?.fastModeDefault === true,
      "ops fastModeDefault changed",
    );
  }

  if (acceptsIntent(coverage, "skills")) {
    assert(config.skills?.allowBundled?.includes("memory"), "memory skill allowlist changed");
  }

  if (acceptsIntent(coverage, "plugins")) {
    const pluginAllow = config.plugins?.allow ?? [];
    assert(pluginAllow.includes("discord"), "discord plugin allow entry missing");
    assert(pluginAllow.includes("telegram"), "telegram plugin allow entry missing");
    assert(pluginAllow.includes("whatsapp"), "whatsapp plugin allow entry missing");
  }

  if (acceptsIntent(coverage, "discord-channel")) {
    const discord = config.channels?.discord;
    assert(discord?.enabled === true, "discord enabled flag changed");
    const discordAllowFrom = discord.allowFrom ?? discord.dm?.allowFrom;
    const discordDmPolicy = discord.dmPolicy ?? discord.dm?.policy;
    assert(discordDmPolicy === "allowlist", "discord DM policy changed");
    assert(
      Array.isArray(discordAllowFrom) && discordAllowFrom.includes("111111111111111111"),
      "discord allowFrom changed",
    );
    assert(
      discord.guilds?.["222222222222222222"]?.channels?.["333333333333333333"]?.requireMention ===
        true,
      "discord guild channel mention policy changed",
    );
    assert(discord.threadBindings?.idleHours === 72, "discord thread binding ttl changed");
  }

  if (acceptsIntent(coverage, "telegram-channel")) {
    const telegram = config.channels?.telegram;
    assert(telegram?.enabled === true, "telegram enabled flag changed");
    assert(
      telegram.groups?.["-1001234567890"]?.requireMention === true,
      "telegram group policy changed",
    );
  }

  if (acceptsIntent(coverage, "whatsapp-channel")) {
    const whatsapp = config.channels?.whatsapp;
    assert(whatsapp?.enabled === true, "whatsapp enabled flag changed");
    const whatsappGroup = whatsapp.groups?.["120363000000000000@g.us"];
    if (hasCoverage(coverage)) {
      assert(whatsappGroup?.requireMention === true, "whatsapp group policy changed");
    } else {
      assert(
        whatsappGroup?.systemPrompt === "Use the existing WhatsApp group prompt.",
        "whatsapp group policy changed",
      );
    }
  }
}

function assertStateSurvived() {
  const stateDir = requireEnv("OPENCLAW_STATE_DIR");
  const workspace = requireEnv("OPENCLAW_TEST_WORKSPACE_DIR");
  assert(fs.existsSync(path.join(workspace, "IDENTITY.md")), "workspace identity file missing");
  assert(
    fs.existsSync(path.join(stateDir, "agents", "main", "sessions", "legacy-session.json")),
    "legacy session file missing",
  );
  assert(
    fs.existsSync(path.join(stateDir, "plugin-runtime-deps", "discord")),
    "plugin runtime deps root missing",
  );
}

function assertStatusJson([file]) {
  const status = readJson(file);
  assert(status && typeof status === "object", "gateway status JSON was not an object");
  const text = JSON.stringify(status);
  assert(/running|connected|ok|ready/u.test(text), "gateway status did not report a healthy state");
}

if (command === "seed") {
  seedState();
} else if (command === "assert-config") {
  assertConfigSurvived();
} else if (command === "assert-state") {
  assertStateSurvived();
} else if (command === "assert-status-json") {
  assertStatusJson(process.argv.slice(3));
} else {
  throw new Error(`unknown upgrade-survivor assertion command: ${command ?? "<missing>"}`);
}
