import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import * as jsonReader from "@openclaw/fs-safe/json";
import { describe, expect, it, vi } from "vitest";
import acpxPackage from "../package.json" with { type: "json" };
import { GENERATED_ADAPTER_ORPHAN_SCENARIO } from "./adapter-wrapper-script.test-support.js";
import { CODEX_ACP_PACKAGE, OPENCLAW_CODEX_CONFIG_ARG } from "./codex-adapter.js";
import { useAuthBridgeFixture } from "./codex-auth-bridge.test-support.js";
import { splitCommandParts, type AcpxAgentCommand } from "./command-line.js";
import { OPENCLAW_ACPX_LEASE_ID_ARG, OPENCLAW_GATEWAY_INSTANCE_ID_ARG } from "./process-lease.js";

vi.mock("@openclaw/fs-safe/json", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@openclaw/fs-safe/json")>()),
}));

const execFileAsync = promisify(execFile);
const WRAPPER_STDERR_LOG_MAX_CHARS = 256 * 1024;
const createWrapperFixture = useAuthBridgeFixture((codexBin) =>
  vi
    .spyOn(jsonReader, "tryReadJson")
    .mockResolvedValueOnce({ name: CODEX_ACP_PACKAGE, bin: codexBin }),
);
const apiKeyAuth = (key: string) => ({ OPENAI_API_KEY: key, tokens: null, last_refresh: null });
const chatGptAuth = {
  auth_mode: "chatgpt",
  tokens: { access_token: "existing-token" },
  last_refresh: null,
};

async function adapterFixture(source = "console.log('ok');\n") {
  const fixture = createWrapperFixture();
  const bin = path.join(fixture.root, "codex-acp-bin.js");
  await fs.writeFile(bin, source, "utf8");
  await fixture.prepare({}, bin);
  const authPath = path.join(fixture.stateDir, "acpx", "codex-home", "auth.json");
  return {
    ...fixture,
    authPath,
    writeAuth: (auth: unknown) =>
      fs.writeFile(authPath, `${JSON.stringify(auth)}\n`, { mode: 0o600 }),
    run: (env: NodeJS.ProcessEnv, args: string[] = []) =>
      execFileAsync(process.execPath, [fixture.generated.wrapperPath, ...args], {
        cwd: fixture.root,
        env,
      }),
  };
}

function expectWrapperCommand(command: AcpxAgentCommand | undefined, wrapperPath: string): void {
  expect(command).toEqual(expect.arrayContaining([process.execPath, wrapperPath]));
}

async function expectPathMissing(targetPath: string): Promise<void> {
  await expect(fs.access(targetPath)).rejects.toMatchObject({ code: "ENOENT" });
}

function runConfigured(wrapperPath: string, script: string, leaseId: string, maxBuffer?: number) {
  return execFileAsync(
    process.execPath,
    [
      wrapperPath,
      "--openclaw-run-configured",
      process.execPath,
      script,
      OPENCLAW_ACPX_LEASE_ID_ARG,
      leaseId,
      OPENCLAW_GATEWAY_INSTANCE_ID_ARG,
      "gateway-test",
    ],
    maxBuffer === undefined ? {} : { maxBuffer },
  );
}

async function captureGeneratedCodexWrapperStderr(
  source: string,
  expectedExitCode = 0,
): Promise<{ log: string; stateDir: string }> {
  const { root, stateDir, generated, prepare } = createWrapperFixture();
  const stderrScript = path.join(root, "emit-stderr.mjs");
  await fs.writeFile(stderrScript, source, "utf8");
  await prepare();

  const leaseId = "lease-unicode";
  const execution = runConfigured(
    generated.wrapperPath,
    stderrScript,
    leaseId,
    WRAPPER_STDERR_LOG_MAX_CHARS * 2,
  );
  if (expectedExitCode === 0) {
    await execution;
  } else {
    await expect(execution).rejects.toMatchObject({ code: expectedExitCode });
  }
  const log = await fs.readFile(
    path.join(stateDir, "acpx", `codex-acp-wrapper.stderr.${leaseId}.log`),
    "utf8",
  );
  return { log, stateDir };
}

describe("prepareAcpxCodexAuthConfig", () => {
  it("keeps generated wrappers usable when chmod is rejected by the state filesystem", async () => {
    const { generated: generatedCodex, generatedClaude, prepare } = createWrapperFixture();
    const chmodError = Object.assign(new Error("operation not permitted"), { code: "EPERM" });
    const chmodSpy = vi.spyOn(fs, "chmod").mockRejectedValue(chmodError);

    const resolved = await prepare();

    expect(chmodSpy).toHaveBeenCalledWith(generatedCodex.wrapperPath, 0o755);
    expect(chmodSpy).toHaveBeenCalledWith(generatedClaude.wrapperPath, 0o755);
    expectWrapperCommand(resolved.agents.codex, generatedCodex.wrapperPath);
    expectWrapperCommand(resolved.agents.claude, generatedClaude.wrapperPath);
    await fs.access(generatedCodex.wrapperPath);
    await fs.access(generatedClaude.wrapperPath);
  });

  it("launches codex after its captured adapter is removed", async () => {
    const packageName = "codex-acp";
    const { root, generated, prepare } = createWrapperFixture();
    const capturedBin = path.join(root, "captured-adapter.cjs");
    await fs.writeFile(capturedBin, "console.log('captured adapter');\n");
    await prepare({}, capturedBin);
    const wrapperPath = generated.wrapperPath;
    const packageDir = path.join(root, "node_modules", "@agentclientprotocol", packageName);
    const binDir = path.join(root, "node_modules", ".bin");
    await fs.mkdir(packageDir, { recursive: true });
    await fs.mkdir(binDir, { recursive: true });
    await fs.writeFile(
      path.join(packageDir, "package.json"),
      JSON.stringify({
        name: `@agentclientprotocol/${packageName}`,
        version: acpxPackage.dependencies["@agentclientprotocol/codex-acp"],
        bin: { [packageName]: "index.cjs" },
      }),
    );
    const fallbackBin = path.join(packageDir, "index.cjs");
    await fs.writeFile(fallbackBin, "#!/usr/bin/env node\nconsole.log('fallback adapter');\n", {
      mode: 0o755,
    });
    if (process.platform === "win32") {
      await fs.writeFile(
        path.join(binDir, `${packageName}.cmd`),
        `@"${process.execPath}" "${fallbackBin}" %*\r\n`,
      );
    } else {
      await fs.symlink(fallbackBin, path.join(binDir, packageName));
    }
    const options = {
      cwd: root,
      env: {
        ...process.env,
        npm_config_offline: "true",
        npm_config_cache: path.join(root, "cache"),
      },
    };
    const present = await execFileAsync(process.execPath, [wrapperPath], options);
    expect(present.stdout.trim()).toBe("captured adapter");
    await fs.rm(capturedBin);
    const reclaimed = await execFileAsync(process.execPath, [wrapperPath], options);
    expect(reclaimed.stdout.trim()).toBe("fallback adapter");
  });

  it.each(["before-orphan", "after-orphan"])(
    "keeps orphan cleanup owned when the direct child exits %s",
    async (exitOrder) => {
      const { root, generated, prepare } = createWrapperFixture();
      await prepare();
      const scenario = path.join(root, "orphan-scenario.mjs");
      await fs.writeFile(scenario, GENERATED_ADAPTER_ORPHAN_SCENARIO);
      const { stdout } = await execFileAsync(
        process.execPath,
        [scenario, generated.wrapperPath, exitOrder],
        {
          env: { PATH: process.env.PATH, HOME: root, USERPROFILE: root },
        },
      );
      expect(JSON.parse(stdout)).toEqual({
        initialSignals: [],
        orphanSignals: [[-42, "SIGTERM"]],
        finalSignals: [
          [-42, "SIGTERM"],
          [-42, "SIGKILL"],
        ],
        timerReferenced: true,
        timerStillArmedAfterChildClose: true,
        listenersRetainedBeforeEscalation: true,
        repeatSignalHandled: true,
        exitCode: 1,
        listenersRetired: true,
      });
    },
  );

  it("launches maintained Codex ACP with isolated CODEX_HOME and model overrides", async () => {
    const { stateDir, run } = await adapterFixture(
      "console.log(JSON.stringify({ argv: process.argv.slice(2), codexConfig: process.env.CODEX_CONFIG, codexHome: process.env.CODEX_HOME }));\n",
    );
    const { stdout } = await run(
      {
        ...process.env,
        CODEX_CONFIG: JSON.stringify({
          sandbox_mode: "workspace-write",
          model_providers: { custom: { base_url: "https://example.test/v1" } },
        }),
      },
      [
        "--openclaw-acpx-lease-id",
        "lease-1",
        "--openclaw-gateway-instance-id",
        "gateway-1",
        OPENCLAW_CODEX_CONFIG_ARG,
        JSON.stringify({ model_providers: { custom: { wire_api: "responses" } } }),
        OPENCLAW_CODEX_CONFIG_ARG,
        JSON.stringify({ model: "gpt-5.6-sol", model_reasoning_effort: "medium" }),
      ],
    );
    const launched = JSON.parse(stdout.trim()) as {
      argv?: unknown;
      codexConfig?: unknown;
      codexHome?: unknown;
    };
    expect(launched.argv).toStrictEqual([]);
    expect(JSON.parse(String(launched.codexConfig))).toEqual({
      sandbox_mode: "workspace-write",
      model_providers: {
        custom: { base_url: "https://example.test/v1", wire_api: "responses" },
      },
      model: "gpt-5.6-sol",
      model_reasoning_effort: "medium",
    });
    const expectedCodexHome = await fs.realpath(path.join(stateDir, "acpx", "codex-home"));
    expect(path.resolve(String(launched.codexHome))).toBe(expectedCodexHome);
  });

  it.each([
    { config: "not-json", override: "{}", diagnostic: "CODEX_CONFIG must be a valid JSON object" },
    { config: "{}", override: "[]", diagnostic: "invalid generated Codex ACP startup config" },
  ])(
    "rejects invalid startup configuration before launching the adapter: $diagnostic",
    async ({ config, override, diagnostic }) => {
      const { root, generated, prepare } = createWrapperFixture();
      process.env.CODEX_HOME = path.join(root, "empty-codex-home");
      const marker = path.join(root, "adapter-started");
      const installedBinPath = path.join(root, "codex-acp-bin.mjs");
      await fs.writeFile(
        installedBinPath,
        `import fs from "node:fs"; fs.writeFileSync(${JSON.stringify(marker)}, "started");`,
      );
      await prepare({}, installedBinPath);
      await expect(
        execFileAsync(
          process.execPath,
          [generated.wrapperPath, OPENCLAW_CODEX_CONFIG_ARG, override],
          {
            env: { ...process.env, CODEX_CONFIG: config },
          },
        ),
      ).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining(diagnostic) });
      await expectPathMissing(marker);
    },
  );

  it.each([
    ["creates missing auth", undefined, "", apiKeyAuth("sk-test-api-key")],
    ["preserves ChatGPT auth", chatGptAuth, "", chatGptAuth],
    [
      "updates API-key auth",
      apiKeyAuth("sk-old-api-key"),
      "sk-new-api-key",
      apiKeyAuth("sk-new-api-key"),
    ],
  ] as const)("%s", async (_name, existing, codexKey, expected) => {
    const { authPath, run, writeAuth } = await adapterFixture();
    if (existing) {
      await writeAuth(existing);
    }
    await run({ ...process.env, CODEX_API_KEY: codexKey, OPENAI_API_KEY: "sk-test-api-key" });
    expect(JSON.parse(await fs.readFile(authPath, "utf8"))).toEqual(expected);
    if (!existing && process.platform !== "win32") {
      expect((await fs.stat(authPath)).mode & 0o777).toBe(0o600);
    }
  });

  it("does not copy source Codex auth", async () => {
    const { root, generated, prepare, sourceConfig } = createWrapperFixture();
    const agentDir = path.join(root, "agent");
    const sourceCodexHome = await sourceConfig(
      [
        'model = "gpt-5.5-1"',
        'model_provider = "azure_foundry"',
        'model_reasoning_effort = "high"',
        'sandbox_mode = "workspace-write"',
        'notify = ["SkyComputerUseClient", "turn-ended"]',
        "[model_providers.azure_foundry]",
        'name = "Azure Foundry"',
        'base_url = "https://example.azure.com/openai/v1"',
        'wire_api = "responses"',
        'env_key = "AZURE_OPENAI_API_KEY"',
        'http_headers = { "api-key" = "inline-secret-key" }',
        'query_params = { "api-version" = "2026-01-01", "secret" = "inline-secret-param" }',
        'experimental_bearer_token = "inline-secret-bearer"',
        'auth = { command = "bash", args = ["-lc", "printf %s test-key"] }',
        "[model_providers.secret_only]",
        'experimental_bearer_token = "secret-only-token"',
        `[projects.${JSON.stringify(path.join(root, "project-with-model-key"))}]`,
        'model = "nested-project-model"',
      ].join("\n"),
    );
    await fs.writeFile(
      path.join(sourceCodexHome, "auth.json"),
      `${JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: "test-api-key" }, null, 2)}\n`,
    );
    process.env.OPENCLAW_AGENT_DIR = agentDir;

    const resolved = await prepare();

    expectWrapperCommand(resolved.agents.codex, generated.wrapperPath);
    const isolatedConfig = await fs.readFile(generated.configPath, "utf8");
    expect(isolatedConfig).toContain('model = "gpt-5.5-1"');
    expect(isolatedConfig).toContain('model_provider = "azure_foundry"');
    expect(isolatedConfig).toContain('model_reasoning_effort = "high"');
    expect(isolatedConfig).toContain('sandbox_mode = "workspace-write"');
    expect(isolatedConfig).toContain("[model_providers.azure_foundry]");
    expect(isolatedConfig).toContain('base_url = "https://example.azure.com/openai/v1"');
    expect(isolatedConfig).toContain('env_key = "AZURE_OPENAI_API_KEY"');
    expect(isolatedConfig).not.toMatch(
      /http_headers|query_params|experimental_bearer_token|\[model_providers\.azure_foundry\.auth\]|\[model_providers\.secret_only\]|nested-project-model|inline-secret|args = \["-lc", "printf %s test-key"\]|notify|SkyComputerUseClient/,
    );
    expect(isolatedConfig).toContain(`[projects.${JSON.stringify(path.resolve(root))}]`);
    expect(isolatedConfig).toContain('trust_level = "trusted"');
    expect(await fs.readFile(generated.wrapperPath, "utf8")).not.toContain(sourceCodexHome);
    await expectPathMissing(path.join(agentDir, "acp-auth", "codex-source", "auth.json"));
    await expectPathMissing(path.join(agentDir, "acp-auth", "codex", "auth.json"));
  });

  it.each(["inline map", "project tables"])(
    "copies only trusted Codex project declarations into the isolated Codex home (%s)",
    async (syntax) => {
      const { root, generated, prepare, sourceConfig } = createWrapperFixture();
      const explicitProject = path.join(root, "explicit project");
      const inlineProject = path.join(root, "inline-project");
      const mapProject = path.join(root, "map-project");
      const untrustedProject = path.join(root, "untrusted-project");
      const quotedProject = path.join(root, "quoted-project");
      const trustedEntries = [mapProject, inlineProject, explicitProject].map(
        (project) => `${JSON.stringify(project)} = { trust_level = "trusted" }`,
      );
      const untrustedEntry = `${JSON.stringify(untrustedProject)} = { trust_level = "untrusted" }`;
      const projects =
        syntax === "inline map"
          ? [`projects = { ${[...trustedEntries, untrustedEntry].join(", ")} }`]
          : [
              "[projects]",
              ...trustedEntries.slice(0, 2),
              untrustedEntry,
              `[projects.${JSON.stringify(explicitProject)}]`,
              'trust_level = "trusted"',
            ];
      await sourceConfig(
        [
          'notify = ["SkyComputerUseClient", "turn-ended"]',
          "notes = '''",
          `[projects.${JSON.stringify(quotedProject)}]`,
          'trust_level = "trusted"',
          "'''",
          ...projects,
          "",
        ].join("\n"),
      );

      await prepare();

      const isolatedConfig = await fs.readFile(generated.configPath, "utf8");
      for (const project of [root, explicitProject, inlineProject, mapProject]) {
        expect(isolatedConfig).toContain(`[projects.${JSON.stringify(path.resolve(project))}]`);
      }
      expect(isolatedConfig).not.toContain(untrustedProject);
      expect(isolatedConfig).not.toContain(quotedProject);
      expect(isolatedConfig).not.toMatch(/notify|SkyComputerUseClient/);
    },
  );

  it("rejects malformed source Codex config without publishing inferred trust", async () => {
    const { generated, prepare, sourceConfig } = createWrapperFixture();
    await sourceConfig('model = "unfinished');

    await expect(prepare()).rejects.toThrow(
      "Codex config.toml must be valid TOML before starting an ACP session.",
    );
    await expectPathMissing(generated.configPath);
  });

  it("captures Codex wrapper stderr in a stream-aware redacted per-lease log", async () => {
    const { log, stateDir } = await captureGeneratedCodexWrapperStderr(
      `const chunks = [
        "token=sk-test",
        "secret1234567890\\n",
        "Authorization: Bearer bearer-secret",
        "-token-1234567890\\n",
        '{"client_secret":"json-secret-1234567890","api_key":"json-api-key-1234567890"}\\n',
        "client-secret: kebab-secret-1234567890\\n",
        "standalone sk-live-secret",
        "1234567890\\n",
        "url=https://example.test/callback?token=query-secret",
        "-1234567890\\n",
        "github_pat_1234567890",
        "abcdefghijklmnopqrstuvwxyz\\n",
        "-----BEGIN PRIVATE KEY-----\\nprivate-secret-body\\n",
        "-----END PRIVATE KEY-----\\n",
        "tail-token=tail-secret-1234567890",
        "\\n-----BEGIN PRIVATE KEY-----\\ntruncated-private-secret",
      ];
      let index = 0;
      function writeNext() {
        if (index >= chunks.length) {
          process.exit(1);
          return;
        }
        process.stderr.write(chunks[index]);
        index += 1;
        setTimeout(writeNext, 5);
      }
      writeNext();`,
      1,
    );
    expect(log).toContain("token=[REDACTED]");
    expect(log).toContain("Authorization: Bearer [REDACTED]");
    expect(log).toContain('"client_secret":"[REDACTED]"');
    expect(log).toContain('"api_key":"[REDACTED]"');
    expect(log).toContain("client-secret: [REDACTED]");
    expect(log).toContain("standalone [REDACTED_OPENAI_KEY]");
    expect(log).toContain("?token=[REDACTED]");
    expect(log).toContain("[REDACTED_GITHUB_TOKEN]");
    expect(log).toContain("[REDACTED_PRIVATE_KEY]");
    expect(log).toContain("tail-token=[REDACTED]");
    expect(log).not.toMatch(
      /sk-testsecret1234567890|bearer-secret-token-1234567890|json-secret-1234567890|json-api-key-1234567890|kebab-secret-1234567890|query-secret-1234567890|github_pat_1234567890abcdefghijklmnopqrstuvwxyz|private-secret-body|truncated-private-secret|tail-secret-1234567890/,
    );
    await expectPathMissing(path.join(stateDir, "acpx", "codex-acp-wrapper.stderr.log"));
  });

  it("removes a previous per-lease stderr log when the adapter writes no stderr", async () => {
    const { root, stateDir, generated, prepare, config } = createWrapperFixture();
    const noisyScript = path.join(root, "noisy-adapter.mjs");
    const quietScript = path.join(root, "quiet-adapter.mjs");
    await fs.writeFile(noisyScript, 'process.stderr.write("previous diagnostics\\n");\n', "utf8");
    await fs.writeFile(quietScript, "process.exit(0);\n", "utf8");
    await prepare({
      pluginConfig: config(`${process.execPath} ${quietScript}`),
    });

    await runConfigured(generated.wrapperPath, noisyScript, "quiet-lease");
    const stderrLogPath = path.join(stateDir, "acpx", "codex-acp-wrapper.stderr.quiet-lease.log");
    await expect(fs.readFile(stderrLogPath, "utf8")).resolves.toBe("previous diagnostics\n");

    await runConfigured(generated.wrapperPath, quietScript, "quiet-lease");

    await expectPathMissing(stderrLogPath);
  });

  it.each([
    {
      name: "persisted UTF-16 line tail",
      source: `
      process.stderr.write("🚀\\n");
      process.stderr.write("a".repeat(256 * 1024 - 3) + "\\n");
    `,
      expected: `\n${"a".repeat(WRAPPER_STDERR_LOG_MAX_CHARS - 3)}\n`,
    },
    {
      name: "pending UTF-16 tail",
      source: `process.stderr.write("🚀" + "a".repeat(256 * 1024 - 1));`,
      expected: "a".repeat(WRAPPER_STDERR_LOG_MAX_CHARS - 1),
    },
    {
      name: "split UTF-8 and partial final sequence",
      source: `
      process.stderr.write(Buffer.from([0xf0, 0x9f]));
      setTimeout(() => {
        process.stderr.write(Buffer.from([0x9a, 0x80, 0x0a, 0xe2]));
      }, 50);
    `,
      expected: "🚀\n�",
    },
  ])("preserves $name", async ({ source, expected }) => {
    expect((await captureGeneratedCodexWrapperStderr(source)).log).toBe(expected);
  });

  it("does not normalize custom Claude commands that only mention the package name", async () => {
    const { prepare, config } = createWrapperFixture();
    const command =
      "node ./custom-claude-wrapper.mjs @agentclientprotocol/claude-agent-acp@0.31.4 --flag";
    const resolved = await prepare({
      pluginConfig: config(command, "claude"),
    });

    expect(resolved.agents.claude).toEqual(splitCommandParts(command));
  });
});
