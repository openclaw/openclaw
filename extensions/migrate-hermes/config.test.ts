import fs from "node:fs/promises";
import path from "node:path";
import { readConfigFileSnapshot } from "openclaw/plugin-sdk/health";
import type { OpenClawConfig } from "openclaw/plugin-sdk/provider-auth";
import { describe, expect, it, vi } from "vitest";
import { buildHermesMigrationProvider } from "./provider.js";
import { useHermesFixture } from "./test/migration-fixture.js";
import { makeConfigRuntime, writeFile } from "./test/provider-helpers.js";

const migrationProvider = buildHermesMigrationProvider();

const fixture = useHermesFixture(() => {
  vi.unstubAllEnvs();
});
const makeTestContext = fixture.context;

async function writeConfig(value: unknown) {
  await writeFile(
    path.join(fixture.paths.source, "config.yaml"),
    typeof value === "string" ? value : JSON.stringify(value),
  );
}

function endpoint(base_url: string, model: string, transport?: string) {
  return { base_url, models: [model], transport };
}

function chatEndpoint(base_url: string) {
  return { base_url, transport: "openai_chat" };
}

function itemById<T extends { id: string }>(items: T[], id: string): T | undefined {
  return items.find((item) => item.id === id);
}

function expectManual(items: Array<{ id: string; kind: string }>, id: string) {
  expect(itemById(items, id)?.kind).toBe("manual");
}

function modelProviderValues(
  items: Array<{ id: string; details?: { value?: unknown } }>,
): NonNullable<NonNullable<OpenClawConfig["models"]>["providers"]> {
  return Object.assign(
    {},
    ...items
      .filter((item) => item.id.startsWith("config:model-provider:"))
      .map((item) => item.details?.value),
  );
}

describe("Hermes migration config mapping", () => {
  it("plans plugin-owned config when target credential storage is unreadable", async () => {
    const { source, workspaceDir, agentDir } = fixture.paths;
    await writeConfig({
      model: { provider: "custom:acme", default: "vendor/custom-v1" },
      providers: {
        acme: {
          api: "https://api.acme.example/v1",
          key_env: "ACME_TOKEN",
          default_model: "vendor/custom-v1",
          transport: "codex_responses",
          models: { "vendor/custom-v1": { context_length: 262144, max_tokens: 16384 } },
        },
      },
      custom_providers: [
        { name: "local-llm", base_url: "http://127.0.0.1:11434/v1", models: ["local-model"] },
      ],
      memory: { provider: "honcho", honcho: { project: "hermes" } },
      skills: { config: { "ship-it": { mode: "fast" } } },
      mcp_servers: {
        time: {
          enabled: false,
          command: "npx",
          args: ["-y", "mcp-server-time"],
          timeout: 45,
          connect_timeout: 10,
          supports_parallel_tool_calls: true,
        },
      },
    });
    await writeFile(path.join(source, "memories", "MEMORY.md"), "memory line\n");

    const credentialPath = path.join(agentDir, "openclaw-agent.sqlite");
    const unreadableCredentials = "not a SQLite database\n";
    await writeFile(credentialPath, unreadableCredentials);
    const plan = await migrationProvider.plan(makeTestContext({ workspaceDir }));

    const memoryPlugin = itemById(plan.items, "config:memory-plugin:honcho");
    expect(memoryPlugin).toMatchObject({
      kind: "config",
      action: "merge",
      target: "plugins.entries.honcho",
    });

    const manualMemory = itemById(plan.items, "manual:memory-provider:honcho");
    expect(manualMemory).toMatchObject({ kind: "manual", status: "skipped" });

    const modelProviderValue = modelProviderValues(plan.items);
    expect(modelProviderValue?.acme?.baseUrl).toBe("https://api.acme.example/v1");
    expect(modelProviderValue?.acme?.apiKey).toBeUndefined();
    expect(modelProviderValue?.acme?.api).toBe("openai-responses");
    expect(modelProviderValue?.acme?.models).toEqual([
      expect.objectContaining({
        id: "vendor/custom-v1",
        contextWindow: 262_144,
        maxTokens: 16_384,
        api: "openai-responses",
      }),
    ]);
    expect(modelProviderValue?.["local-llm"]?.baseUrl).toBe("http://127.0.0.1:11434/v1");

    const mcpServers = itemById(plan.items, "config:mcp-server:time");
    expect(mcpServers?.details?.value).toEqual({
      time: {
        enabled: false,
        command: "npx",
        args: ["-y", "mcp-server-time"],
        connectionTimeoutMs: 10_000,
        requestTimeoutMs: 45_000,
        supportsParallelToolCalls: true,
      },
    });

    const skillEntry = itemById(plan.items, "config:skill-entry:ship-it");
    expect(skillEntry?.details).toEqual({
      path: ["skills", "entries", "ship-it"],
      value: { config: { mode: "fast" } },
    });
    expect(plan.warnings).toEqual([
      "Some Hermes settings require manual review before they can be activated safely.",
    ]);
    expect(await fs.readFile(credentialPath, "utf8")).toBe(unreadableCredentials);
  });

  it("applies mapped config items through the migration runtime config writer", async () => {
    const { source, workspaceDir, stateDir } = fixture.paths;
    const config = { agents: { defaults: { workspace: workspaceDir } } } as OpenClawConfig;
    await writeConfig({
      providers: {
        openai: {
          api: "https://api.openai.example/v1",
          key_env: "OPENAI_API_KEY",
          default_model: "gpt-5.4",
          transport: "chat_completions",
          models: ["gpt-5.4"],
        },
      },
      mcp_servers: { time: { command: "npx" } },
      skills: { config: { "ship-it": { mode: "fast" } } },
    });
    await writeFile(path.join(source, "memories", "MEMORY.md"), "Imported memory\n");

    const result = await migrationProvider.apply(
      makeTestContext({ runtime: makeConfigRuntime(config) }),
    );

    expect(result.summary.errors).toBe(0);
    expect(config.models?.providers?.openai?.apiKey).toBeUndefined();
    expect(result.items).toContainEqual(
      expect.objectContaining({ id: "manual:model-provider-key-env:openai", kind: "manual" }),
    );
    expect(config.mcp?.servers?.time?.command).toBe("npx");
    expect(config.skills?.entries?.["ship-it"]?.config?.mode).toBe("fast");
    expect(config.plugins?.slots?.memory).toBe("memory-core");
    const configPath = path.join(stateDir, "openclaw.json");
    await writeFile(configPath, JSON.stringify(config));
    vi.stubEnv("OPENCLAW_CONFIG_PATH", configPath);
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    const snapshot = await readConfigFileSnapshot({
      observe: false,
      isolateEnv: true,
      pluginValidation: "core-only",
    });
    expect(snapshot.issues).toEqual([]);
    expect(snapshot.valid).toBe(true);
  });

  it("drops prototype-bearing provider, MCP, and skill keys during apply", async () => {
    const { workspaceDir } = fixture.paths;
    const config = { agents: { defaults: { workspace: workspaceDir } } } as OpenClawConfig;
    await writeConfig({
      providers: {
        ["__proto__"]: { base_url: "https://untrusted.example/v1", models: ["untrusted-model"] },
      },
      mcp_servers: {
        constructor: { command: "untrusted-command" },
        "safe-server": { command: "safe-command" },
      },
      skills: { config: { prototype: { mode: "untrusted" }, "safe-skill": { mode: "safe" } } },
    });

    const result = await migrationProvider.apply(
      makeTestContext({ runtime: makeConfigRuntime(config) }),
    );

    expect(result.summary.errors).toBe(0);
    const providers = config.models?.providers as Record<string, unknown>;
    const servers = config.mcp?.servers as Record<string, unknown>;
    const skills = config.skills?.entries as Record<string, unknown>;
    expect(Object.hasOwn(providers, "__proto__")).toBe(false);
    expect(Object.hasOwn(servers, "constructor")).toBe(false);
    expect(Object.hasOwn(skills, "prototype")).toBe(false);
    expect(Object.getPrototypeOf(providers)).toBe(Object.prototype);
    expect((servers["safe-server"] as { command?: string }).command).toBe("safe-command");
    expect((skills["safe-skill"] as { config?: { mode?: string } }).config?.mode).toBe("safe");
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });

  it("uses the provider runtime for CLI-applied config items", async () => {
    const { workspaceDir } = fixture.paths;
    const config: Record<string, unknown> = { agents: { defaults: { workspace: workspaceDir } } };
    await writeConfig({
      mcp_servers: { time: { command: "npx", env: { OPENAI_API_KEY: "short-dev-key" } } },
    });

    const runtimeProvider = buildHermesMigrationProvider({ runtime: makeConfigRuntime(config) });
    const result = await runtimeProvider.apply(makeTestContext({ includeSecrets: true }));

    expect(result.summary.errors).toBe(0);
    const mcp = config.mcp as
      | { servers?: { time?: { command?: unknown; env?: { OPENAI_API_KEY?: unknown } } } }
      | undefined;
    expect(mcp?.servers?.time?.command).toBe("npx");
    expect(mcp?.servers?.time?.env?.OPENAI_API_KEY).toBe("short-dev-key");
  });

  it("translates current Hermes model-scoped providers and MCP semantics", async () => {
    const { workspaceDir } = fixture.paths;
    const tlsFieldName = ["client", "cert"].join("_");
    const tlsPaths = ["placeholder", "placeholder"];
    const oauthConfig = {
      scope: "read",
      [["client", "id"].join("_")]: "placeholder",
      [["client", "secret"].join("_")]: "placeholder",
    };
    await writeConfig({
      model: {
        provider: "custom",
        default: "vendor/current-model",
        base_url: "https://models.example/v1",
        api_mode: "anthropic_messages",
        api_key: "${SCOPED_MODEL_KEY}",
        context_length: 65_536,
        supports_vision: true,
      },
      mcp_servers: {
        remote: {
          url: "https://mcp.example/rpc",
          [tlsFieldName]: tlsPaths,
          ssl_verify: "/tls/ca.pem",
          auth: "oauth",
          oauth: oauthConfig,
          tools: { include: ["search"], exclude: ["danger"], resources: "off", prompts: true },
          skip_preflight: true,
          sampling: { enabled: true },
          lifecycle: { idle_timeout_seconds: "60", max_lifetime_seconds: 3600 },
          keepalive_interval: 10,
        },
        protected: {
          url: "https://protected.example/rpc",
          [tlsFieldName]: [...tlsPaths, "placeholder"],
        },
        utilities_only: {
          command: "utilities-only",
          tools: { include: [], resources: false, prompts: true },
        },
        no_tools: {
          command: "no-tools",
          tools: { include: [], resources: false, prompts: false },
        },
      },
    });

    const plan = await migrationProvider.plan(makeTestContext({ workspaceDir }));
    const providers = modelProviderValues(plan.items);
    expect(providers?.custom).toMatchObject({
      baseUrl: "https://models.example",
      api: "anthropic-messages",
      models: [
        expect.objectContaining({
          id: "vendor/current-model",
          contextWindow: 65_536,
          input: ["text", "image"],
        }),
      ],
    });
    expect(providers?.custom?.apiKey).toBeUndefined();
    expectManual(plan.items, "manual:model-provider-key-env:custom");

    const remoteValue = itemById(plan.items, "config:mcp-server:remote")?.details?.value as
      | { remote?: Record<string, unknown> }
      | undefined;
    expect(remoteValue?.remote).toEqual(
      expect.objectContaining({
        url: "https://mcp.example/rpc",
        transport: "streamable-http",
        auth: "oauth",
        oauth: { scope: "read" },
        toolFilter: { include: ["search", "prompts_list", "prompts_get"] },
      }),
    );
    expect(remoteValue?.remote?.[["client", "Cert"].join("")]).toBe(tlsPaths[0]);
    expect(remoteValue?.remote?.[["client", "Key"].join("")]).toBe(tlsPaths[1]);
    expect(itemById(plan.items, "config:mcp-server:protected")?.details?.value).toEqual({
      protected: { url: "https://protected.example/rpc", transport: "streamable-http" },
    });
    expect(itemById(plan.items, "config:mcp-server:utilities_only")?.details?.value).toEqual({
      utilities_only: {
        command: "utilities-only",
        toolFilter: { include: ["prompts_list", "prompts_get"] },
      },
    });
    expect(itemById(plan.items, "config:mcp-server:no_tools")?.details?.value).toEqual({
      no_tools: { command: "no-tools", toolFilter: { exclude: ["*"] } },
    });
    for (const id of [
      "manual:mcp-server-tls-ca:remote",
      "manual:mcp-server-preflight:remote",
      "manual:mcp-server-sampling:remote",
      "manual:mcp-server-lifecycle:remote",
      "manual:mcp-server-keepalive:remote",
      "manual:mcp-server-oauth-login:remote",
      "manual:mcp-server-oauth-client:remote",
      ["manual:mcp-server-client-cert-password", "protected"].join(":"),
    ]) {
      expect(itemById(plan.items, id)?.kind).toBe("manual");
    }
  });

  it("resolves provider endpoint refs and preserves supported request options", async () => {
    const { root, source } = fixture.paths;
    const endpointEnv = ["ACME", "BASE", "URL"].join("_");
    const headerEnv = ["ACME", "HEADER"].join("_");
    await writeConfig({
      providers: {
        acme: {
          api: `\${${endpointEnv}}`,
          transport: "openai_chat",
          models: { "acme-one": { max_output_tokens: 12_345 } },
          extra_headers: {
            "X-Environment": `\${${headerEnv}}`,
            "X-Invalid": { nested: true },
            "X-Literal": "literal-value",
          },
          extra_body: { service_tier: "flex" },
        },
      },
    });
    await writeFile(
      path.join(source, ".env"),
      `${endpointEnv}=https://acme.example.test/v1\n${headerEnv}=resolved-header-value\n`,
    );

    const withoutSecrets = await migrationProvider.plan(
      makeTestContext({
        stateDir: path.join(root, "state-without-secrets"),
        workspaceDir: path.join(root, "workspace-without-secrets"),
      }),
    );
    const withoutSecretsProviders = modelProviderValues(withoutSecrets.items);
    expect(withoutSecretsProviders.acme).toMatchObject({
      baseUrl: "https://acme.example.test/v1",
      models: [expect.objectContaining({ maxTokens: 12_345 })],
    });
    expect(itemById(withoutSecrets.items, "config:model-provider:acme")?.sensitive).toBe(true);
    expectManual(withoutSecrets.items, "manual:model-provider-headers:acme");
    expectManual(withoutSecrets.items, "manual:model-provider-extra-body:acme");

    const withSecrets = await migrationProvider.plan(
      makeTestContext({
        stateDir: path.join(root, "state-with-secrets"),
        workspaceDir: path.join(root, "workspace-with-secrets"),
        includeSecrets: true,
      }),
    );
    const withSecretsProviders = modelProviderValues(withSecrets.items);
    expect(withSecretsProviders.acme?.headers).toEqual({
      "X-Environment": "resolved-header-value",
      "X-Literal": "literal-value",
    });
    expect(itemById(withSecrets.items, "manual:model-provider-headers:acme")).toBeUndefined();
    expectManual(withSecrets.items, "manual:model-provider-headers-invalid:acme");
  });

  it("reports unresolved provider endpoint environment references", async () => {
    await writeConfig(
      "providers:\n  acme:\n    api: ${MISSING_ACME_URL}\n    models: [acme-one]\n",
    );

    const plan = await migrationProvider.plan(makeTestContext());

    expect(itemById(plan.items, "config:model-provider:acme")).toBeUndefined();
    expectManual(plan.items, "manual:model-provider-endpoint-env:acme");
  });

  it("infers Hermes provider protocols from provider and endpoint contracts", async () => {
    await writeConfig({
      providers: {
        anthropic: endpoint("https://anthropic-proxy.example.test/v1", "claude-proxy-model"),
        "claude-proxy": endpoint("https://proxy.example.test/anthropic", "claude-test"),
        "claude-v1-proxy": endpoint("https://proxy.example.test/anthropic/v1", "claude-v1-test"),
        "openai-direct": endpoint("https://api.openai.com/v1", "gpt-5.4"),
        "openai-codex": endpoint(
          "https://chatgpt.com/backend-api/codex",
          "gpt-5.6",
          "codex_responses",
        ),
        "xai-direct": endpoint("https://api.x.ai/v1", "grok-4.1-fast", "codex_responses"),
      },
    });

    const plan = await migrationProvider.plan(makeTestContext());
    const providers = modelProviderValues(plan.items);
    expect(providers?.anthropic?.api).toBe("anthropic-messages");
    expect(providers?.["claude-proxy"]?.api).toBe("anthropic-messages");
    expect(providers?.["claude-v1-proxy"]?.api).toBe("anthropic-messages");
    expect(providers?.["claude-v1-proxy"]?.baseUrl).toBe("https://proxy.example.test/anthropic");
    expect(providers?.["openai-direct"]?.api).toBe("openai-responses");
    expect(providers?.openai?.api).toBe("openai-chatgpt-responses");
    expect(providers?.["xai-direct"]?.api).toBe("openai-responses");
  });

  it("keeps built-in Hermes provider overrides on OpenClaw's canonical provider IDs", async () => {
    await writeConfig({
      model: { provider: "gemini", default: "gemini-3.1-pro" },
      providers: {
        copilot: chatEndpoint("https://copilot.example.test/v1"),
        gemini: chatEndpoint("https://gemini.example.test/v1"),
        "kimi-coding": chatEndpoint("https://kimi.example.test/v1"),
        "kimi-coding-cn": chatEndpoint("https://moonshot.example.test/v1"),
        "opencode-zen": chatEndpoint("https://opencode.example.test/v1"),
      },
    });

    const plan = await migrationProvider.plan(makeTestContext());
    const providers = modelProviderValues(plan.items);
    expect(itemById(plan.items, "config:default-model")?.details?.model).toBe(
      "google/gemini-3.1-pro",
    );
    expect(Object.keys(providers).toSorted()).toEqual([
      "github-copilot",
      "google",
      "kimi",
      "moonshot",
      "opencode",
    ]);
    expect(
      Object.values(providers).every((provider) => provider.api === "openai-completions"),
    ).toBe(true);
  });

  it("isolates model provider conflicts", async () => {
    const { workspaceDir } = fixture.paths;
    await writeConfig({
      model: { provider: "existing", default: "imported-model" },
      providers: {
        existing: chatEndpoint("https://new-existing.example.test/v1"),
        fresh: chatEndpoint("https://fresh.example.test/v1"),
      },
    });

    const plan = await migrationProvider.plan(
      makeTestContext({
        config: {
          agents: { defaults: { workspace: workspaceDir } },
          models: {
            providers: {
              existing: {
                baseUrl: "https://old-existing.example.test/v1",
                api: "openai-completions",
                models: [],
              },
            },
          },
        },
      }),
    );

    expect(itemById(plan.items, "config:model-provider:existing")?.status).toBe("conflict");
    expect(itemById(plan.items, "config:model-provider:fresh")?.status).toBe("planned");
    expect(itemById(plan.items, "config:default-model")?.status).toBe("conflict");
  });

  it.each([
    {
      sourceProvider: "openai-api",
      envName: "OPENAI_BASE_URL",
      envValue: "https://openai-proxy.example.test/v1",
      targetProvider: "openai",
      expectedApi: "openai-responses",
      expectedBaseUrl: "https://openai-proxy.example.test/v1",
    },
    {
      sourceProvider: "kimi-for-coding",
      envName: "KIMI_BASE_URL",
      envValue: "https://api.kimi.com/coding/v1",
      targetProvider: "kimi",
      expectedApi: "anthropic-messages",
      expectedBaseUrl: "https://api.kimi.com/coding",
    },
  ])(
    "imports $envName as the selected $sourceProvider endpoint",
    async ({ sourceProvider, envName, envValue, targetProvider, expectedApi, expectedBaseUrl }) => {
      const { source } = fixture.paths;
      await writeConfig(
        ["model:", `  provider: ${sourceProvider}`, "  default: imported-model", ""].join("\n"),
      );
      await writeFile(path.join(source, ".env"), `${envName}=${envValue}\n`);

      const plan = await migrationProvider.plan(makeTestContext());
      const providers = modelProviderValues(plan.items);

      expect(providers?.[targetProvider]).toMatchObject({
        api: expectedApi,
        baseUrl: expectedBaseUrl,
      });
      expect(providers?.[targetProvider]?.models).toEqual([
        expect.objectContaining({
          id: "imported-model",
          api: expectedApi,
          baseUrl: expectedBaseUrl,
        }),
      ]);
    },
  );

  it("resolves MCP environment references with source dotenv precedence and secret consent", async () => {
    const { root, source } = fixture.paths;
    const mcpEnvName = ["MCP", "VALUE"].join("_");
    const mcpUrlName = ["MCP", "URL"].join("_");
    const dottedEnvName = ["mcp", "value"].join(".");
    const dashedEnvName = ["MCP", "VALUE"].join("-");
    const inheritedEnvName = ["MCP", "INHERITED"].join("_");
    vi.stubEnv(inheritedEnvName, "inherited-placeholder");
    await writeFile(
      path.join(source, ".env"),
      `${mcpEnvName}=placeholder\n${mcpUrlName}=https://mcp.example.test/rpc\n${dottedEnvName}=dotted-placeholder\n${dashedEnvName}=dashed-placeholder\n`,
    );
    await writeConfig({
      mcp_servers: {
        resolved: {
          url: `\${${mcpUrlName}}`,
          args: ["--value", `\${${mcpEnvName}}`],
          headers: {
            Authorization: `Bearer \${${mcpEnvName}}`,
            "X-Dotted": `\${${dottedEnvName}}`,
          },
          env: { DASHED: `\${env:${dashedEnvName}}`, INHERITED: `\${${inheritedEnvName}}` },
        },
        unresolved: { command: "unresolved", env: { VALUE: "${env:MISSING_VALUE}" } },
        "missing-launch": { command: "${env:MISSING_COMMAND}", enabled: true, args: ["--serve"] },
      },
    });

    const plan = await migrationProvider.plan(makeTestContext({ includeSecrets: true }));
    expect(itemById(plan.items, "config:mcp-server:resolved")?.details?.value).toEqual({
      resolved: {
        url: "https://mcp.example.test/rpc",
        args: ["--value", "placeholder"],
        transport: "streamable-http",
        headers: { Authorization: "Bearer placeholder", "X-Dotted": "dotted-placeholder" },
        env: { DASHED: "dashed-placeholder", INHERITED: "inherited-placeholder" },
      },
    });
    expect(itemById(plan.items, "config:mcp-server:resolved")?.sensitive).toBe(true);
    expect(itemById(plan.items, "config:mcp-server:unresolved")?.details?.value).toEqual({
      unresolved: { command: "unresolved" },
    });
    expectManual(plan.items, "manual:mcp-server-unresolved-secrets:unresolved");
    expect(itemById(plan.items, "config:mcp-server:missing-launch")).toBeUndefined();
    expectManual(plan.items, "manual:mcp-server-unresolved-secrets:missing-launch");

    const withoutSecrets = await migrationProvider.plan(
      makeTestContext({
        stateDir: path.join(root, "state-without-secrets"),
        workspaceDir: path.join(root, "workspace-without-secrets"),
      }),
    );
    expect(itemById(withoutSecrets.items, "config:mcp-server:resolved")).toBeUndefined();
    expectManual(withoutSecrets.items, "manual:mcp-server-secrets:resolved");
    expect(itemById(withoutSecrets.items, "config:mcp-server:missing-launch")).toBeUndefined();
    expectManual(withoutSecrets.items, "manual:mcp-server-secrets:missing-launch");
  });

  it("imports a model-scoped endpoint even when Hermes names a built-in provider", async () => {
    await writeConfig({
      model: {
        provider: "kimi-for-coding",
        default: "kimi-k2.5",
        base_url: "https://proxy.example.test/v1",
        api_mode: "chat_completions",
      },
      custom_providers: [
        { name: "My Local LLM", ...endpoint("https://local.example.test/v1", "local-model") },
      ],
    });

    const plan = await migrationProvider.plan(makeTestContext());
    const providers = modelProviderValues(plan.items);
    expect(providers?.kimi).toMatchObject({
      baseUrl: "https://proxy.example.test/v1",
      models: [expect.objectContaining({ id: "kimi-k2.5" })],
    });
    expect(itemById(plan.items, "config:default-model")?.details?.model).toBe("kimi/kimi-k2.5");
    expect(providers?.["my-local-llm"]?.baseUrl).toBe("https://local.example.test/v1");
  });

  it("keeps current providers entries ahead of matching legacy custom providers", async () => {
    const { source } = fixture.paths;
    const envVar = ["CURRENT", "ACME", "TOKEN"].join("_");
    const legacyEnvVar = ["LEGACY", "ACME", "TOKEN"].join("_");
    await writeConfig({
      model: { provider: "acme", default: "current-model" },
      providers: {
        acme: {
          api: "https://current.example.test/v1",
          key_env: envVar,
          transport: "codex_responses",
          models: ["current-model"],
        },
      },
      custom_providers: [
        {
          name: "acme",
          key_env: legacyEnvVar,
          ...endpoint("https://legacy.example.test/v1", "legacy-model"),
        },
      ],
    });
    await writeFile(path.join(source, ".env"), `${envVar}=placeholder\n`);

    const plan = await migrationProvider.plan(makeTestContext({ includeSecrets: true }));
    const providers = modelProviderValues(plan.items);
    expect(providers?.acme).toMatchObject({
      api: "openai-responses",
      baseUrl: "https://current.example.test/v1",
      models: [
        expect.objectContaining({ id: "current-model" }),
        expect.objectContaining({ id: "legacy-model" }),
      ],
    });
    expect(
      plan.items.some(
        (item) => item.kind === "manual" && item.message?.includes(legacyEnvVar) === true,
      ),
    ).toBe(false);
  });

  it("preserves the Hermes Moonshot China endpoint while aligning provider auth", async () => {
    await writeConfig("model:\n  provider: kimi-coding-cn\n  default: kimi-k2.5\n");

    const plan = await migrationProvider.plan(makeTestContext());
    const providers = modelProviderValues(plan.items);
    expect(itemById(plan.items, "config:default-model")?.details?.model).toBe("moonshot/kimi-k2.5");
    expect(providers?.moonshot?.baseUrl).toBe("https://api.moonshot.cn/v1");
  });

  it("continues independent items after one late config conflict", async () => {
    const { source } = fixture.paths;
    const config: Record<string, unknown> = {};
    await writeConfig("mcp_servers:\n  alpha:\n    command: alpha\n  beta:\n    command: beta\n");
    await writeFile(path.join(source, "SOUL.md"), "# Hermes soul\n");
    const runtime = makeConfigRuntime(config);
    const runtimeProvider = buildHermesMigrationProvider({ runtime });
    const ctx = makeTestContext({ config, runtime });
    const plan = await runtimeProvider.plan(ctx);
    config.mcp = { servers: { alpha: { command: "late" } } };

    const result = await runtimeProvider.apply(ctx, plan);
    expect(itemById(result.items, "config:mcp-server:alpha")?.status).toBe("conflict");
    expect(itemById(result.items, "config:mcp-server:beta")?.status).toBe("migrated");
    expect(itemById(result.items, "workspace:SOUL.md")?.status).toBe("migrated");
    expect(
      (config.mcp as { servers?: { beta?: { command?: string } } }).servers?.beta?.command,
    ).toBe("beta");
  });
});
