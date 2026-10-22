import fs from "node:fs/promises";
import path from "node:path";
import { readConfigFileSnapshot } from "openclaw/plugin-sdk/health";
import type { MigrationPlan } from "openclaw/plugin-sdk/plugin-entry";
import type { OpenClawConfig } from "openclaw/plugin-sdk/provider-auth";
import { describe, expect, it, vi } from "vitest";
import { collectHermesProviders, collectHermesProviderSecretBindings } from "./config-providers.js";
import { buildConfigItems } from "./config.js";
import { resolveHermesModelRef } from "./model.js";
import { buildHermesMigrationProvider } from "./provider.js";
import { hermesCase, item } from "./test/hermes-case.js";
import { useHermesFixture } from "./test/migration-fixture.js";
import { writeFile } from "./test/provider-helpers.js";

const fixture = useHermesFixture(() => {
  vi.unstubAllEnvs();
});
const makeCase = () => hermesCase(fixture.paths.root);
const endpoint = (base_url: string, model: string, transport?: string) => ({
  base_url,
  models: [model],
  transport,
});
function providers(
  plan: MigrationPlan,
): NonNullable<NonNullable<OpenClawConfig["models"]>["providers"]> {
  return Object.assign(
    {},
    ...plan.items
      .filter((entry) => entry.id.startsWith("config:model-provider:"))
      .map((entry) => entry.details?.value),
  );
}
function manual(plan: MigrationPlan, ...ids: string[]) {
  for (const id of ids) {
    expect(item(plan, `manual:${id}`)?.kind).toBe("manual");
  }
}
function mcp(plan: MigrationPlan, name: string, value: object) {
  expect(item(plan, `config:mcp-server:${name}`)?.details?.value).toEqual({ [name]: value });
}

describe("Hermes config migration", () => {
  it("plans plugin config without touching unreadable credential storage", async () => {
    const h = makeCase();
    await h.write(
      "config.yaml",
      `
custom_providers: [ { name: local-llm, base_url: http://127.0.0.1:11434/v1, models: [ local-model ] } ]
memory: { provider: honcho, honcho: { project: hermes } }
`,
    );
    await h.write("memories/MEMORY.md", "memory line\n");
    const db = path.join(h.agentDir, "openclaw-agent.sqlite");
    await writeFile(db, "not a SQLite database\n");
    const plan = await h.plan();
    expect(item(plan, "config:memory-plugin:honcho")).toMatchObject({
      kind: "config",
      action: "merge",
      target: "plugins.entries.honcho",
    });
    expect(item(plan, "manual:memory-provider:honcho")).toMatchObject({
      kind: "manual",
      status: "skipped",
    });
    expect(providers(plan)["local-llm"]?.baseUrl).toBe("http://127.0.0.1:11434/v1");
    expect(plan.warnings).toEqual([
      "Some Hermes settings require manual review before they can be activated safely.",
    ]);
    expect(await fs.readFile(db, "utf8")).toBe("not a SQLite database\n");
  });

  it("applies mapped config through the runtime writer and validates the result", async () => {
    const h = makeCase();
    await h.write(
      "config.yaml",
      `
providers:
  openai:
    api: https://api.openai.example/v1
    key_env: OPENAI_API_KEY
    default_model: gpt-5.4
    transport: chat_completions
    models: [ gpt-5.4 ]
mcp_servers:
  time:
    enabled: false
    command: npx
    args: [ -y, mcp-server-time ]
    timeout: 45
    connect_timeout: 10
    supports_parallel_tool_calls: true
skills: { config: { ship-it: { mode: fast } } }
`,
    );
    await h.write("memories/MEMORY.md", "Imported memory\n");
    const result = await h.import();
    expect(result.summary.errors).toBe(0);
    expect(h.config.models?.providers?.openai?.apiKey).toBeUndefined();
    manual(result, "model-provider-key-env:openai");
    expect(h.config.mcp?.servers?.time).toEqual({
      enabled: false,
      command: "npx",
      args: ["-y", "mcp-server-time"],
      connectionTimeoutMs: 10_000,
      requestTimeoutMs: 45_000,
      supportsParallelToolCalls: true,
    });
    expect(h.config.skills?.entries?.["ship-it"]?.config?.mode).toBe("fast");
    expect(h.config.plugins?.slots?.memory).toBe("memory-core");
    const configPath = path.join(h.stateDir, "openclaw.json");
    await writeFile(configPath, JSON.stringify(h.config));
    vi.stubEnv("OPENCLAW_CONFIG_PATH", configPath);
    vi.stubEnv("OPENCLAW_STATE_DIR", h.stateDir);
    const snapshot = await readConfigFileSnapshot({
      observe: false,
      isolateEnv: true,
      pluginValidation: "core-only",
    });
    expect(snapshot.issues).toEqual([]);
    expect(snapshot.valid).toBe(true);
  });

  it("drops prototype-bearing provider, MCP and skill keys on apply", async () => {
    const h = makeCase();
    await h.write(
      "config.yaml",
      `
providers: { __proto__: { base_url: https://untrusted.example/v1, models: [ untrusted-model ] } }
mcp_servers: { constructor: { command: untrusted-command }, safe-server: { command: safe-command } }
skills: { config: { prototype: { mode: untrusted }, safe-skill: { mode: safe } } }
`,
    );
    expect((await h.import()).summary.errors).toBe(0);
    const models = h.config.models?.providers as Record<string, unknown>;
    const servers = h.config.mcp?.servers as Record<string, unknown>;
    const skills = h.config.skills?.entries as Record<string, unknown>;
    expect([
      Object.hasOwn(models, "__proto__"),
      Object.hasOwn(servers, "constructor"),
      Object.hasOwn(skills, "prototype"),
    ]).toEqual([false, false, false]);
    expect(Object.getPrototypeOf(models)).toBe(Object.prototype);
    expect(servers["safe-server"]).toMatchObject({ command: "safe-command" });
    expect(skills["safe-skill"]).toMatchObject({ config: { mode: "safe" } });
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });

  it("uses provider-bound runtime for CLI config writes", async () => {
    const h = makeCase();
    await h.write(
      "config.yaml",
      `
{ mcp_servers: { time: { command: npx, env: { OPENAI_API_KEY: short-dev-key } } } }
`,
    );
    const provider = buildHermesMigrationProvider({ runtime: h.runtime });
    expect((await provider.apply(h.context({ includeSecrets: true }))).summary.errors).toBe(0);
    expect(h.config.mcp?.servers?.time).toMatchObject({
      command: "npx",
      env: { OPENAI_API_KEY: "short-dev-key" },
    });
  });

  it("maps model-scoped endpoints and conservatively translates remote MCP policy", async () => {
    const h = makeCase();
    await h.write(
      "config.yaml",
      `
model:
  provider: custom
  default: vendor/current-model
  base_url: https://models.example/v1
  api_mode: anthropic_messages
  api_key: \${SCOPED_MODEL_KEY}
  context_length: 65536
  supports_vision: true
mcp_servers:
  remote:
    url: https://mcp.example/rpc
    client_cert: [ placeholder, placeholder ]
    ssl_verify: /tls/ca.pem
    auth: oauth
    oauth: { scope: read, client_id: placeholder, client_secret: placeholder }
    tools: { include: [ search ], exclude: [ danger ], resources: off, prompts: true }
    skip_preflight: true
    sampling: { enabled: true }
    lifecycle: { idle_timeout_seconds: "60", max_lifetime_seconds: 3600 }
    keepalive_interval: 10
  protected: { url: https://protected.example/rpc, client_cert: [ placeholder, placeholder, placeholder ] }
  utilities_only: { command: utilities-only, tools: { include: [], resources: false, prompts: true } }
  no_tools: { command: no-tools, tools: { include: [], resources: false, prompts: false } }
`,
    );
    const plan = await h.plan();
    expect(providers(plan).custom).toMatchObject({
      baseUrl: "https://models.example",
      api: "anthropic-messages",
      models: [{ id: "vendor/current-model", contextWindow: 65_536, input: ["text", "image"] }],
    });
    expect(providers(plan).custom?.apiKey).toBeUndefined();
    manual(plan, "model-provider-key-env:custom");
    expect(item(plan, "config:mcp-server:remote")?.details?.value).toEqual({
      remote: expect.objectContaining({
        url: "https://mcp.example/rpc",
        transport: "streamable-http",
        auth: "oauth",
        oauth: { scope: "read" },
        toolFilter: { include: ["search", "prompts_list", "prompts_get"] },
        [["client", "Cert"].join("")]: "placeholder",
        [["client", "Key"].join("")]: "placeholder",
      }),
    });
    mcp(plan, "protected", { url: "https://protected.example/rpc", transport: "streamable-http" });
    mcp(plan, "utilities_only", {
      command: "utilities-only",
      toolFilter: { include: ["prompts_list", "prompts_get"] },
    });
    mcp(plan, "no_tools", {
      command: "no-tools",
      toolFilter: { exclude: ["*"] },
    });
    manual(
      plan,
      ...[
        "tls-ca",
        "preflight",
        "sampling",
        "lifecycle",
        "keepalive",
        "oauth-login",
        "oauth-client",
      ].map((name) => `mcp-server-${name}:remote`),
      "mcp-server-client-cert-password:protected",
    );
  });

  it("resolves endpoint/header references while gating secret request options", async () => {
    const h = makeCase();
    await h.write(
      "config.yaml",
      `
providers:
  acme:
    api: \${ACME_BASE_URL}
    transport: openai_chat
    models: { acme-one: { max_output_tokens: 12345 } }
    extra_headers: { X-Environment: "\${ACME_HEADER}", X-Invalid: { nested: true }, X-Literal: literal-value }
    extra_body: { service_tier: flex }
`,
    );
    await h.write(
      ".env",
      "ACME_BASE_URL=https://acme.example.test/v1\nACME_HEADER=resolved-header-value\n",
    );
    const without = await h.plan({
      stateDir: path.join(h.root, "state-without-secrets"),
      workspaceDir: path.join(h.root, "workspace-without-secrets"),
    });
    expect(providers(without).acme).toMatchObject({
      baseUrl: "https://acme.example.test/v1",
      models: [{ maxTokens: 12_345 }],
    });
    expect(item(without, "config:model-provider:acme")?.sensitive).toBe(true);
    manual(without, "model-provider-headers:acme", "model-provider-extra-body:acme");
    const withSecrets = await h.plan({
      stateDir: path.join(h.root, "state-with-secrets"),
      workspaceDir: path.join(h.root, "workspace-with-secrets"),
      includeSecrets: true,
    });
    expect(providers(withSecrets).acme?.headers).toEqual({
      "X-Environment": "resolved-header-value",
      "X-Literal": "literal-value",
    });
    expect(item(withSecrets, "manual:model-provider-headers:acme")).toBeUndefined();
    manual(withSecrets, "model-provider-headers-invalid:acme");
  });

  it("reports unresolved endpoint references", async () => {
    const h = makeCase();
    await h.write(
      "config.yaml",
      "providers:\n  acme:\n    api: ${MISSING_ACME_URL}\n    models: [acme-one]\n",
    );
    const plan = await h.plan();
    expect(item(plan, "config:model-provider:acme")).toBeUndefined();
    manual(plan, "model-provider-endpoint-env:acme");
  });

  it.each([
    ["anthropic", "https://p.test/v1", "anthropic-messages", undefined],
    ["claude-proxy", "https://p.test/anthropic", "anthropic-messages", undefined],
    ["claude-v1-proxy", "https://p.test/anthropic/v1", "anthropic-messages", undefined],
    ["openai-direct", "https://api.openai.com/v1", "openai-responses", undefined],
    [
      "openai-codex",
      "https://chatgpt.com/backend-api/codex",
      "openai-chatgpt-responses",
      "codex_responses",
    ],
    ["xai-direct", "https://api.x.ai/v1", "openai-responses", "codex_responses"],
  ] as const)("infers %s protocol", async (name, url, api, transport) => {
    const h = makeCase();
    await h.write("config.yaml", { providers: { [name]: endpoint(url, "test-model", transport) } });
    const value = providers(await h.plan())[name === "openai-codex" ? "openai" : name];
    expect(value?.api).toBe(api);
    if (name === "claude-v1-proxy") {
      expect(value?.baseUrl).toBe("https://p.test/anthropic");
    }
  });

  it("keeps built-in overrides on canonical provider IDs", async () => {
    const h = makeCase();
    await h.write(
      "config.yaml",
      `
model: { provider: gemini, default: gemini-3.1-pro }
providers:
  copilot: { base_url: https://copilot.example.test/v1, transport: openai_chat }
  gemini: { base_url: https://gemini.example.test/v1, transport: openai_chat }
  kimi-coding: { base_url: https://kimi.example.test/v1, transport: openai_chat }
  kimi-coding-cn: { base_url: https://moonshot.example.test/v1, transport: openai_chat }
  opencode-zen: { base_url: https://opencode.example.test/v1, transport: openai_chat }
`,
    );
    const plan = await h.plan();
    expect(item(plan, "config:default-model")?.details?.model).toBe("google/gemini-3.1-pro");
    expect(Object.keys(providers(plan)).toSorted()).toEqual([
      "github-copilot",
      "google",
      "kimi",
      "moonshot",
      "opencode",
    ]);
    expect(
      Object.values(providers(plan)).every((value) => value.api === "openai-completions"),
    ).toBe(true);
  });

  it("isolates provider conflicts and blocks the dependent default model", async () => {
    const h = makeCase();
    await h.write(
      "config.yaml",
      `
model: { provider: existing, default: imported-model }
providers:
  existing: { base_url: https://new-existing.example.test/v1, transport: openai_chat }
  fresh: { base_url: https://fresh.example.test/v1, transport: openai_chat }
`,
    );
    h.config.models = {
      providers: {
        existing: {
          baseUrl: "https://old-existing.example.test/v1",
          api: "openai-completions",
          models: [],
        },
      },
    };
    const plan = await h.plan({ config: h.config });
    expect(
      ["config:model-provider:existing", "config:model-provider:fresh", "config:default-model"].map(
        (id) => item(plan, id)?.status,
      ),
    ).toEqual(["conflict", "planned", "conflict"]);
  });

  it.each([
    [
      "openai-api",
      "OPENAI_BASE_URL",
      "https://openai-proxy.example.test/v1",
      "openai",
      "openai-responses",
      "https://openai-proxy.example.test/v1",
    ],
    [
      "kimi-for-coding",
      "KIMI_BASE_URL",
      "https://api.kimi.com/coding/v1",
      "kimi",
      "anthropic-messages",
      "https://api.kimi.com/coding",
    ],
  ] as const)(
    "imports the selected %s environment endpoint",
    async (source, env, url, target, api, baseUrl) => {
      const h = makeCase();
      await h.write("config.yaml", { model: { provider: source, default: "imported-model" } });
      await h.write(".env", `${env}=${url}\n`);
      expect(providers(await h.plan())[target]).toMatchObject({
        api,
        baseUrl,
        models: [{ id: "imported-model", api, baseUrl }],
      });
    },
  );

  it("resolves MCP dotenv/inherited references with secret consent", async () => {
    const h = makeCase();
    vi.stubEnv("MCP_INHERITED", "inherited-placeholder");
    await h.write(
      ".env",
      "MCP_VALUE=placeholder\nMCP_URL=https://mcp.example.test/rpc\nmcp.value=dotted-placeholder\nMCP-VALUE=dashed-placeholder\n",
    );
    await h.write(
      "config.yaml",
      `
mcp_servers:
  resolved:
    url: \${MCP_URL}
    args: [ --value, "\${MCP_VALUE}" ]
    headers: { Authorization: "Bearer \${MCP_VALUE}", X-Dotted: "\${mcp.value}" }
    env: { DASHED: "\${env:MCP-VALUE}", INHERITED: "\${MCP_INHERITED}" }
  unresolved: { command: unresolved, env: { VALUE: "\${env:MISSING_VALUE}" } }
  missing-launch: { command: "\${env:MISSING_COMMAND}", enabled: true, args: [ --serve ] }
`,
    );
    const plan = await h.plan({ includeSecrets: true });
    mcp(plan, "resolved", {
      url: "https://mcp.example.test/rpc",
      args: ["--value", "placeholder"],
      transport: "streamable-http",
      headers: { Authorization: "Bearer placeholder", "X-Dotted": "dotted-placeholder" },
      env: { DASHED: "dashed-placeholder", INHERITED: "inherited-placeholder" },
    });
    expect(item(plan, "config:mcp-server:resolved")?.sensitive).toBe(true);
    mcp(plan, "unresolved", { command: "unresolved" });
    manual(
      plan,
      "mcp-server-unresolved-secrets:unresolved",
      "mcp-server-unresolved-secrets:missing-launch",
    );
    expect(item(plan, "config:mcp-server:missing-launch")).toBeUndefined();
    const without = await h.plan({
      stateDir: path.join(h.root, "state-without-secrets"),
      workspaceDir: path.join(h.root, "workspace-without-secrets"),
    });
    expect([
      item(without, "config:mcp-server:resolved"),
      item(without, "config:mcp-server:missing-launch"),
    ]).toEqual([undefined, undefined]);
    manual(without, "mcp-server-secrets:resolved", "mcp-server-secrets:missing-launch");
  });

  it("imports explicit built-in and custom provider endpoints", async () => {
    const h = makeCase();
    await h.write(
      "config.yaml",
      `
model:
  provider: kimi-for-coding
  default: kimi-k2.5
  base_url: https://proxy.example.test/v1
  api_mode: chat_completions
custom_providers: [ { name: My Local LLM, base_url: https://local.example.test/v1, models: [ local-model ] } ]
`,
    );
    const plan = await h.plan();
    expect(providers(plan).kimi).toMatchObject({
      baseUrl: "https://proxy.example.test/v1",
      models: [{ id: "kimi-k2.5" }],
    });
    expect(item(plan, "config:default-model")?.details?.model).toBe("kimi/kimi-k2.5");
    expect(providers(plan)["my-local-llm"]?.baseUrl).toBe("https://local.example.test/v1");
  });

  it("prefers current provider settings but merges legacy models", async () => {
    const h = makeCase();
    await h.write(
      "config.yaml",
      `
model: { provider: acme, default: current-model }
providers:
  acme:
    api: https://current.example.test/v1
    key_env: CURRENT_ACME_TOKEN
    transport: codex_responses
    models: [ current-model ]
custom_providers:
  - name: acme
    key_env: LEGACY_ACME_TOKEN
    base_url: https://legacy.example.test/v1
    models: [ legacy-model ]
`,
    );
    await h.write(".env", "CURRENT_ACME_TOKEN=placeholder\n");
    const plan = await h.plan({ includeSecrets: true });
    expect(providers(plan).acme).toMatchObject({
      api: "openai-responses",
      baseUrl: "https://current.example.test/v1",
      models: [{ id: "current-model" }, { id: "legacy-model" }],
    });
    expect(
      plan.items.some(
        (entry) => entry.kind === "manual" && entry.message?.includes("LEGACY_ACME_TOKEN") === true,
      ),
    ).toBe(false);
  });

  it.each([
    ["kimi-coding-cn", "moonshot", "https://api.moonshot.cn/v1"],
    ["alibaba", "qwen", "https://dashscope-intl.aliyuncs.com/compatible-mode/v1"],
    ["minimax-cn", "minimax", "https://api.minimaxi.com/anthropic"],
    ["alibaba-coding-plan", "qwen", undefined],
  ] as const)("preserves the implicit endpoint for %s", async (source, target, baseUrl) => {
    const h = makeCase();
    await h.write("config.yaml", { model: { provider: source, default: "imported-model" } });
    const plan = await h.plan();
    expect(item(plan, "config:default-model")?.details?.model).toBe(`${target}/imported-model`);
    expect(providers(plan)[target]?.baseUrl).toBe(baseUrl);
    expect(plan.items.some((entry) => entry.id.startsWith("config:model-provider:"))).toBe(
      baseUrl !== undefined,
    );
  });

  it("continues independent items after a late config conflict", async () => {
    const h = makeCase();
    await h.write(
      "config.yaml",
      "mcp_servers:\n  alpha:\n    command: alpha\n  beta:\n    command: beta\n",
    );
    await h.write("SOUL.md", "# Hermes soul\n");
    const ctx = h.context({ config: h.config, runtime: h.runtime });
    const plan = await h.provider.plan(ctx);
    h.config.mcp = { servers: { alpha: { command: "late" } } };
    const result = await h.provider.apply(ctx, plan);
    expect(
      ["config:mcp-server:alpha", "config:mcp-server:beta", "workspace:SOUL.md"].map(
        (id) => item(result, id)?.status,
      ),
    ).toEqual(["conflict", "migrated", "migrated"]);
    expect(h.config.mcp?.servers?.beta?.command).toBe("beta");
  });
});

describe("Hermes source encoding", () => {
  it.each([
    ["config.yaml", 'skills:\n  config:\n    proof:\n      label: "', '"\n'],
    [".env", 'OPENAI_API_KEY="', '"\n'],
    ["auth.json", '{"openai":{"access_token":"', '"}}'],
  ])("refuses invalid UTF-8 in %s before writing imported state", async (name, prefix, suffix) => {
    const h = makeCase();
    const sourcePath = path.join(fixture.paths.source, name);
    await writeFile(sourcePath, "");
    const bytes = Buffer.concat([Buffer.from(prefix), Buffer.from([0xff]), Buffer.from(suffix)]);
    await fs.writeFile(sourcePath, bytes);
    const config: OpenClawConfig = { gateway: { mode: "local" } };
    const before = structuredClone(config);
    await expect(h.import({ config })).rejects.toThrow(/UTF-8.*retry migration/s);
    expect(config).toEqual(before);
    expect(await fs.readFile(sourcePath)).toEqual(bytes);
  });

  it("imports repaired YAML without altering valid Unicode", async () => {
    const h = makeCase();
    const label = "café 中文 🦞 literal �";
    await h.write("config.yaml", { skills: { config: { proof: { label } } } });
    const result = await h.import();

    expect(item(result, "config:skill-entry:proof")?.status).toBe("migrated");
    expect(h.config.skills?.entries?.proof?.config?.label).toBe(label);
  });
});

function providerItems(raw: Record<string, unknown>) {
  return buildConfigItems({
    ctx: fixture.context(),
    config: { providers: { acme: { api: "https://models.example/v1", ...raw } } },
  });
}
function expectProvider(items: ReturnType<typeof providerItems>, acme: object) {
  expect(
    items.find((entry) => entry.id === "config:model-provider:acme")?.details?.value,
  ).toMatchObject({ acme });
}
describe("Hermes provider source contracts", () => {
  it.each(["constructor", "__proto__", "toString", "hasOwnProperty"])(
    "preserves prototype-like ID %s without inventing env mappings",
    (provider) => {
      const config = { model: { provider, default: "custom-model" } };
      expect(resolveHermesModelRef(config)).toBe(`${provider.toLowerCase()}/custom-model`);
      expect(collectHermesProviders(config)).toEqual([]);
    },
  );
  it.each([
    ["openai", "openai-completions"],
    ["responses", "openai-responses"],
    [" CHAT_COMPLETIONS ", "openai-completions"],
  ])("imports transport alias %s as %s", (transport, api) => {
    const items = providerItems({ transport, default_model: "acme-model" });
    expectProvider(items, { api, models: [{ id: "acme-model", api }] });
    expect(items.filter((entry) => entry.kind === "manual")).toEqual([]);
  });
  it("supports camelCase fields and canonical transport precedence", () => {
    const config = {
      providers: {
        acme: {
          baseUrl: "https://models.example/v1",
          apiMode: "messages",
          keyEnv: "ACME_TOKEN",
          defaultModel: "acme-model",
          contextLength: 262144,
        },
      },
    };
    expectProvider(
      buildConfigItems({
        ctx: fixture.context(),
        config,
        env: { ACME_TOKEN: "test-only-placeholder" },
      }),
      { api: "anthropic-messages", models: [{ id: "acme-model", contextWindow: 262144 }] },
    );
    expect(collectHermesProviderSecretBindings(config)).toEqual([
      { provider: "acme", envVar: "ACME_TOKEN" },
    ]);
    expectProvider(
      providerItems({ api_mode: "chat_completions", transport: "anthropic_messages" }),
      { api: "openai-completions" },
    );
  });
  it("preserves list metadata and removes catalog marker keys", () => {
    expectProvider(
      providerItems({
        context_length: 32768,
        models: [
          " plain-model ",
          { id: "vision-model", context_length: 65536, max_tokens: 4096, supports_vision: true },
          { name: "named-model", max_tokens: 2048 },
        ],
      }),
      {
        models: [
          { id: "plain-model", contextWindow: 32768 },
          { id: "vision-model", contextWindow: 65536, maxTokens: 4096, input: ["text", "image"] },
          { id: "named-model", contextWindow: 32768, maxTokens: 2048 },
        ],
      },
    );
    expectProvider(
      providerItems({
        models: {
          "acme-model": { context_length: 262144, max_tokens: 16384 },
          __discovered_model_catalog__: true,
          __explicit_model_allowlist__: true,
        },
      }),
      { models: [{ id: "acme-model", contextWindow: 262144, maxTokens: 16384 }] },
    );
  });
});
