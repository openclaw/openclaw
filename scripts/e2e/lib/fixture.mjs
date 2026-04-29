import fs from "node:fs";
import path from "node:path";

const [command, ...args] = process.argv.slice(2);
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const write = (file, contents) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
};
const writeJson = (file, value) => write(file, json(value));
const requireArg = (value, name) => {
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
};
const assert = (condition, message) => {
  if (!condition) {
    throw new Error(message);
  }
};

function writePluginManifest(file, id) {
  writeJson(file, { id, configSchema: { type: "object", properties: {} } });
}

function writePluginDemo([dir]) {
  write(
    path.join(requireArg(dir, "dir"), "index.js"),
    'module.exports = { id: "demo-plugin", name: "Demo Plugin", description: "Docker E2E demo plugin", register(api) { api.registerTool(() => null, { name: "demo_tool" }); api.registerGatewayMethod("demo.ping", async () => ({ ok: true })); api.registerCli(() => {}, { commands: ["demo"] }); api.registerService({ id: "demo-service", start: () => {} }); }, };\n',
  );
  writePluginManifest(path.join(dir, "openclaw.plugin.json"), "demo-plugin");
}

function writePlugin([dir, id, version, method, name]) {
  for (const [value, label] of [
    [dir, "dir"],
    [id, "id"],
    [version, "version"],
    [method, "method"],
    [name, "name"],
  ]) {
    requireArg(value, label);
  }
  writeJson(path.join(dir, "package.json"), {
    name: `@openclaw/${id}`,
    version,
    openclaw: { extensions: ["./index.js"] },
  });
  write(
    path.join(dir, "index.js"),
    `module.exports = { id: ${JSON.stringify(id)}, name: ${JSON.stringify(name)}, register(api) { api.registerGatewayMethod(${JSON.stringify(method)}, async () => ({ ok: true })); }, };\n`,
  );
  writePluginManifest(path.join(dir, "openclaw.plugin.json"), id);
}

function writeClaudeBundle([root]) {
  root = requireArg(root, "root");
  writeJson(path.join(root, ".claude-plugin", "plugin.json"), { name: "claude-bundle-e2e" });
  write(
    path.join(root, "commands", "office-hours.md"),
    "---\ndescription: Help with architecture and rollout planning\n---\nAct as an engineering advisor.\n\nFocus on:\n$ARGUMENTS\n",
  );
}

function writePluginMarketplace([root]) {
  root = requireArg(root, "root");
  writeJson(path.join(root, ".claude-plugin", "marketplace.json"), {
    name: "Fixture Marketplace",
    version: "1.0.0",
    plugins: [
      {
        name: "marketplace-shortcut",
        version: "0.0.1",
        description: "Shortcut install fixture",
        source: "./plugins/marketplace-shortcut",
      },
      {
        name: "marketplace-direct",
        version: "0.0.1",
        description: "Explicit marketplace fixture",
        source: { type: "path", path: "./plugins/marketplace-direct" },
      },
    ],
  });
  writeJson(path.join(process.env.HOME, ".claude", "plugins", "known_marketplaces.json"), {
    "claude-fixtures": {
      installLocation: root,
      source: { type: "github", repo: "openclaw/fixture-marketplace" },
    },
  });
}

function writeConfig(kind) {
  const configPath = requireArg(process.env.OPENCLAW_CONFIG_PATH, "OPENCLAW_CONFIG_PATH");
  const port = Number(process.env.PORT ?? 18789);
  const config =
    kind === "config-reload"
      ? {
          gateway: {
            port,
            auth: {
              mode: "token",
              token: { source: "env", provider: "default", id: "GATEWAY_AUTH_TOKEN_REF" },
            },
            channelHealthCheckMinutes: 1,
            controlUi: { enabled: false },
            reload: { mode: "hybrid", debounceMs: 0 },
          },
        }
      : kind === "browser-cdp"
        ? {
            gateway: {
              port,
              auth: {
                mode: "token",
                token: requireArg(process.env.OPENCLAW_GATEWAY_TOKEN, "OPENCLAW_GATEWAY_TOKEN"),
              },
              controlUi: { enabled: false },
            },
            browser: {
              enabled: true,
              defaultProfile: "docker-cdp",
              ssrfPolicy: { allowedHostnames: ["127.0.0.1"] },
              profiles: {
                "docker-cdp": {
                  cdpUrl: `http://127.0.0.1:${Number(process.env.CDP_PORT ?? 19222)}`,
                  color: "#FF4500",
                },
              },
            },
          }
        : null;
  writeJson(configPath, requireArg(config, "known config kind"));
}

function writeOpenAiWebSearchMinimalConfig() {
  writeJson(path.join(process.env.OPENCLAW_STATE_DIR, "openclaw.json"), {
    agents: {
      defaults: {
        model: { primary: "openai/gpt-5" },
        models: {
          "openai/gpt-5": {
            params: { transport: "sse", openaiWsWarmup: false },
          },
        },
      },
    },
    models: {
      providers: {
        openai: {
          api: "openai-responses",
          baseUrl: "http://api.openai.com/v1",
          apiKey: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
          request: { allowPrivateNetwork: true },
          models: [
            {
              id: "gpt-5",
              name: "gpt-5",
              api: "openai-responses",
              reasoning: true,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 128000,
              contextTokens: 96000,
              maxTokens: 4096,
            },
          ],
        },
      },
    },
    tools: { web: { search: { enabled: true, maxResults: 3 } } },
    plugins: { enabled: true, allow: ["openai"], entries: { openai: { enabled: true } } },
    gateway: { auth: { mode: "token", token: process.env.OPENCLAW_GATEWAY_TOKEN } },
  });
}

function writeOpenWebUiConfig([openaiApiKey]) {
  const batchPath = requireArg(
    process.env.OPENCLAW_CONFIG_BATCH_PATH,
    "OPENCLAW_CONFIG_BATCH_PATH",
  );
  writeJson(batchPath, [
    { path: "models.providers.openai.apiKey", value: requireArg(openaiApiKey, "OpenAI API key") },
    {
      path: "models.providers.openai.baseUrl",
      value: (process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").trim(),
    },
    { path: "models.providers.openai.models", value: [] },
    { path: "gateway.controlUi.enabled", value: false },
    { path: "gateway.mode", value: "local" },
    { path: "gateway.bind", value: "lan" },
    { path: "gateway.auth.mode", value: "token" },
    { path: "gateway.auth.token", value: process.env.OPENCLAW_GATEWAY_TOKEN },
    { path: "gateway.http.endpoints.chatCompletions.enabled", value: true },
    { path: "agents.defaults.model.primary", value: process.env.OPENCLAW_OPENWEBUI_MODEL },
  ]);
}

function writeOpenWebUiWorkspace() {
  const workspace =
    process.env.OPENCLAW_WORKSPACE_DIR || path.join(process.env.HOME, ".openclaw", "workspace");
  write(
    path.join(workspace, "IDENTITY.md"),
    "# Identity\n\n- Name: OpenClaw\n- Purpose: Open WebUI Docker compatibility smoke test assistant.\n",
  );
  writeJson(path.join(workspace, ".openclaw", "workspace-state.json"), {
    version: 1,
    setupCompletedAt: "2026-01-01T00:00:00.000Z",
  });
  fs.rmSync(path.join(workspace, "BOOTSTRAP.md"), { force: true });
}

function writeAgentsDeleteConfig() {
  const stateDir = requireArg(process.env.OPENCLAW_STATE_DIR, "OPENCLAW_STATE_DIR");
  const sharedWorkspace = requireArg(process.env.SHARED_WORKSPACE, "SHARED_WORKSPACE");
  fs.mkdirSync(sharedWorkspace, { recursive: true });
  writeJson(path.join(stateDir, "openclaw.json"), {
    agents: {
      list: [
        { id: "main", workspace: sharedWorkspace },
        { id: "ops", workspace: sharedWorkspace },
      ],
    },
  });
}

function assertAgentsDeleteResult([outputPath]) {
  let parsed;
  try {
    parsed = readJson(requireArg(outputPath, "outputPath"));
  } catch (error) {
    console.error("agents delete --json did not emit valid JSON:");
    console.error(fs.readFileSync(outputPath, "utf8").trim());
    throw error;
  }
  for (const [actual, expected, label] of [
    [parsed.agentId, "ops", "agentId"],
    [parsed.workspace, process.env.SHARED_WORKSPACE, "workspace"],
    [parsed.workspaceRetained, true, "workspaceRetained"],
    [parsed.workspaceRetainedReason, "shared", "workspaceRetainedReason"],
  ]) {
    assert(actual === expected, `${label} mismatch: ${JSON.stringify(actual)}`);
  }
  assert(
    Array.isArray(parsed.workspaceSharedWith) && parsed.workspaceSharedWith.includes("main"),
    "missing shared-with main marker",
  );
  assert(fs.existsSync(process.env.SHARED_WORKSPACE), "shared workspace was removed");
  const remaining =
    readJson(path.join(process.env.OPENCLAW_STATE_DIR, "openclaw.json"))?.agents?.list ?? [];
  assert(Array.isArray(remaining), "agents list missing after delete");
  assert(!remaining.some((entry) => entry?.id === "ops"), "deleted agent remained in config");
  assert(
    remaining.some((entry) => entry?.id === "main"),
    "main agent missing after delete",
  );
  console.log("agents delete shared workspace smoke ok");
}

const commands = {
  "plugin-demo": writePluginDemo,
  plugin: writePlugin,
  "plugin-manifest": ([file, id]) =>
    writePluginManifest(requireArg(file, "file"), requireArg(id, "id")),
  "claude-bundle": writeClaudeBundle,
  marketplace: writePluginMarketplace,
  "config-reload": () => writeConfig("config-reload"),
  "browser-cdp": () => writeConfig("browser-cdp"),
  "openai-web-search-minimal-config": writeOpenAiWebSearchMinimalConfig,
  "openwebui-config": writeOpenWebUiConfig,
  "openwebui-workspace": writeOpenWebUiWorkspace,
  "agents-delete-config": writeAgentsDeleteConfig,
  "agents-delete-assert": assertAgentsDeleteResult,
};

(
  commands[command] ??
  (() => {
    throw new Error(`unknown fixture command: ${command}`);
  })
)(args);
