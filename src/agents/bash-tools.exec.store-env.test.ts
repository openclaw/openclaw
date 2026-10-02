/** Store-backed exec environment tests cover run snapshots, precedence, and security filtering. */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import { withInstallationTarget } from "../infra/installation-target-context.js";
import { looksLikeSecretSentinel, resolveSecretSentinel } from "../secrets/sentinel.js";
import { writeSecretStoreEntry } from "../secrets/store/secret-store.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import type { ExecuteNodeHostCommandParams } from "./bash-tools.exec-host-node.types.js";
import { createRunExit } from "./bash-tools.exec-runtime.test-support.js";
import type { BashSandboxConfig } from "./bash-tools.shared.js";

const mocks = vi.hoisted(() => ({
  egressActive: false,
  proxyUrl: ["http://openclaw:", "fixture-password", "@127.0.0.1:19090"].join(""),
  gatewayParams: [] as Array<{
    env: Record<string, string>;
    requestedEnv?: Record<string, string>;
  }>,
  nodeHostParams: [] as Array<{
    env: Record<string, string>;
    requestedEnv?: Record<string, string>;
  }>,
  spawnInputs: [] as Array<{ env?: Record<string, string> }>,
  proxyBindings: [] as Array<unknown>,
}));

vi.mock("../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: () => null,
  getGlobalHookRunnerRegistry: () => null,
}));

vi.mock("../secrets/egress-proxy/registry.js", () => ({
  isSecretEgressProxyActive: () => mocks.egressActive,
  registerSecretEgressProxyProcess: (bindings: unknown) => {
    mocks.proxyBindings.push(bindings);
    return {
      revoke: () => {},
      env: {
        HTTPS_PROXY: mocks.proxyUrl,
        HTTP_PROXY: mocks.proxyUrl,
        NODE_USE_ENV_PROXY: "1",
        NODE_EXTRA_CA_CERTS: "/state/secret-egress/root-ca.pem",
        SSL_CERT_FILE: "/state/secret-egress/root-ca.pem",
        CURL_CA_BUNDLE: "/state/secret-egress/root-ca.pem",
        REQUESTS_CA_BUNDLE: "/state/secret-egress/root-ca.pem",
        GIT_SSL_CAINFO: "/state/secret-egress/root-ca.pem",
      },
    };
  },
}));

vi.mock("../infra/shell-env.js", () => ({
  getShellEnvAppliedKeys: vi.fn(() => []),
  getShellPathFromLoginShell: vi.fn(() => null),
  resolveShellEnvFallbackTimeoutMs: vi.fn(() => 0),
  shouldDeferShellEnvFallback: vi.fn(() => false),
  shouldEnableShellEnvFallback: vi.fn(() => false),
}));

vi.mock("./bash-tools.exec-host-gateway.js", () => ({
  processGatewayAllowlist: vi.fn(
    async (params: { env: Record<string, string>; requestedEnv?: Record<string, string> }) => {
      mocks.gatewayParams.push({
        env: { ...params.env },
        requestedEnv: params.requestedEnv ? { ...params.requestedEnv } : undefined,
      });
      return {};
    },
  ),
}));

vi.mock("./bash-tools.exec-host-node.js", () => ({
  executeNodeHostCommand: vi.fn(
    async (params: Pick<ExecuteNodeHostCommandParams, "env" | "requestedEnv">) => {
      mocks.nodeHostParams.push({
        env: { ...params.env },
        requestedEnv: params.requestedEnv ? { ...params.requestedEnv } : undefined,
      });
      return {
        content: [{ type: "text", text: "node ok" }],
        details: {
          status: "completed",
          exitCode: 0,
          durationMs: 0,
          aggregated: "node ok",
        },
      };
    },
  ),
}));

vi.mock("../process/supervisor/index.js", () => ({
  getProcessSupervisor: () => ({
    spawn: async (input: { env?: Record<string, string>; onStdout?: (chunk: string) => void }) => {
      mocks.spawnInputs.push({ env: input.env ? { ...input.env } : undefined });
      input.onStdout?.("ok\n");
      return {
        activity: { resultSettled: true, lastOutputAtMs: Date.now() },
        runId: "mock-run",
        startedAtMs: Date.now(),
        stdin: undefined,
        wait: async () => createRunExit({ durationMs: 0 }),
        cancel: vi.fn(),
      };
    },
    cancel: vi.fn(),
    cancelScope: vi.fn(),
  }),
}));

let createExecTool: typeof import("./bash-tools.exec-run.js").createExecTool;
let createLazyExecTool: typeof import("./lazy-exec-tool.js").createLazyExecTool;

type StoreEntry = {
  name: string;
  value: string;
  kind: "env" | "secret";
  allowedHosts?: string[];
};

type StoreEnvHost = "gateway" | "sandbox" | "node";

const EGRESS_ENV = {
  HTTPS_PROXY: mocks.proxyUrl,
  HTTP_PROXY: mocks.proxyUrl,
  NODE_USE_ENV_PROXY: "1",
  NODE_EXTRA_CA_CERTS: "/state/secret-egress/root-ca.pem",
  SSL_CERT_FILE: "/state/secret-egress/root-ca.pem",
  CURL_CA_BUNDLE: "/state/secret-egress/root-ca.pem",
  REQUESTS_CA_BUNDLE: "/state/secret-egress/root-ca.pem",
  GIT_SSL_CAINFO: "/state/secret-egress/root-ca.pem",
} as const;

const tempDirs = createTempDirTracker();
function writeEntries(entries: StoreEntry[]) {
  for (const entry of entries) {
    writeSecretStoreEntry({ scope: { kind: "team" }, ...entry, updatedBy: "test" });
  }
}

async function captureStoreExecEnvironment(params: {
  host: StoreEnvHost;
  callId: string;
  config?: { secrets: { egressProxy: { enabled: boolean } } };
}): Promise<Record<string, string>> {
  let sandboxEnv: Record<string, string> | undefined;
  const sandbox: BashSandboxConfig | undefined =
    params.host === "sandbox"
      ? {
          containerName: "store-env-sandbox",
          workspaceDir: process.cwd(),
          containerWorkdir: "/workspace",
          buildExecSpec: async (input) => {
            sandboxEnv = { ...input.env };
            return {
              argv: ["remote-shell", input.command],
              env: {},
              stdinMode: "pipe-open" as const,
            };
          },
        }
      : undefined;
  const tool = createExecTool({
    host: params.host,
    security: "full",
    ask: "off",
    cwd: process.cwd(),
    sandbox,
    operationalRunInstance: { instanceId: "instance-1", runId: "run-1" },
    config: params.config,
  });
  await tool.execute(params.callId, { command: "echo ok", yieldMs: 120_000 });
  if (params.host === "gateway") {
    return mocks.spawnInputs.at(-1)?.env ?? {};
  }
  if (params.host === "node") {
    return mocks.nodeHostParams.at(-1)?.env ?? {};
  }
  return sandboxEnv ?? {};
}

describe("exec store environment", () => {
  it.each(["gateway", "node"] as const)(
    "retains a lazy tool's local target outside its construction scope and fences %s",
    async (host) => {
      const target = {
        stateDir: "/fixture/diagnosed",
        configPath: "/fixture/custom.json",
        defaultWorkspaceDir: "/fixture/default-workspace",
      };
      const tool = withInstallationTarget(target, () =>
        createLazyExecTool({
          host,
          security: "full",
          ask: "off",
        }),
      );
      const run = tool.execute("target-probe", { command: "echo ok", yieldMs: 120_000 });
      if (host === "gateway") {
        await run;
        expect(mocks.spawnInputs.at(-1)?.env).toMatchObject({
          OPENCLAW_STATE_DIR: target.stateDir,
          OPENCLAW_CONFIG_PATH: target.configPath,
          OPENCLAW_WORKSPACE_DIR: target.defaultWorkspaceDir,
        });
        const ordinary = createLazyExecTool({ host, security: "full", ask: "off" });
        await withInstallationTarget(target, () =>
          ordinary.execute("ordinary-probe", { command: "echo ok", yieldMs: 120_000 }),
        );
        expect(mocks.spawnInputs.at(-1)?.env?.OPENCLAW_STATE_DIR).toBe(
          process.env.OPENCLAW_STATE_DIR,
        );
        expect(mocks.spawnInputs.at(-1)?.env?.OPENCLAW_WORKSPACE_DIR).toBe(
          process.env.OPENCLAW_WORKSPACE_DIR,
        );
      } else {
        await expect(run).rejects.toThrow("saved prompt");
        expect(mocks.nodeHostParams).toEqual([]);
        expect(mocks.spawnInputs).toEqual([]);
      }
    },
  );
  afterEach(() => {
    closeOpenClawStateDatabaseForTest();
    vi.unstubAllEnvs();
    tempDirs.cleanup();
  });
  beforeAll(async () => {
    ({ createExecTool } = await import("./bash-tools.exec-run.js"));
    ({ createLazyExecTool } = await import("./lazy-exec-tool.js"));
  });

  beforeEach(() => {
    vi.stubEnv("OPENCLAW_STATE_DIR", tempDirs.make("openclaw-exec-store-env-"));
    vi.stubEnv("AWS_REGION", undefined);
    mocks.egressActive = false;
    mocks.gatewayParams.length = 0;
    mocks.nodeHostParams.length = 0;
    mocks.spawnInputs.length = 0;
    mocks.proxyBindings.length = 0;
  });

  it("applies store env on every call to a lazy exec instance", async () => {
    writeEntries([
      { name: "AWS_REGION", value: "us-west-2", kind: "env" },
      { name: "INTERNAL_VALUE", value: "not-for-subprocesses", kind: "secret" },
    ]);
    const tool = createLazyExecTool({ host: "gateway", security: "full", ask: "off" });

    await tool.execute("code-mode-first", { command: "echo one", yieldMs: 120_000 });
    await tool.execute("code-mode-nested", { command: "echo two", yieldMs: 120_000 });

    expect(mocks.gatewayParams).toHaveLength(2);
    for (const params of mocks.gatewayParams) {
      expect(params.env.AWS_REGION).toBe("us-west-2");
      expect(params.env).not.toHaveProperty("INTERNAL_VALUE");
    }
  });

  it("ignores protected store entries without replacing inherited network settings", async () => {
    vi.stubEnv("PATH", "/inherited/bin");
    vi.stubEnv("HTTPS_PROXY", "http://inherited-proxy.test:8080");
    vi.stubEnv("NODE_EXTRA_CA_CERTS", "/inherited/ca.pem");
    writeEntries([
      { name: "PATH", value: "/store/bin", kind: "env" },
      { name: "HTTPS_PROXY", value: "http://store-proxy.test:8080", kind: "env" },
      { name: "NODE_EXTRA_CA_CERTS", value: "/store/ca.pem", kind: "env" },
    ]);
    const tool = createLazyExecTool({ host: "gateway", security: "full", ask: "off" });

    const result = await tool.execute("call-protected-store-env", {
      command: "echo ok",
      yieldMs: 120_000,
    });

    expect(mocks.gatewayParams[0]?.env).toMatchObject({
      PATH: "/inherited/bin",
      HTTPS_PROXY: "http://inherited-proxy.test:8080",
      NODE_EXTRA_CA_CERTS: "/inherited/ca.pem",
    });
    expect(mocks.gatewayParams[0]?.requestedEnv).toBeUndefined();
    expect(result.content[0]).toMatchObject({
      type: "text",
      text: expect.stringMatching(/HTTPS_PROXY, NODE_EXTRA_CA_CERTS, PATH/u),
    });
  });

  it.each(["gateway", "sandbox", "node"] as const)(
    "applies enabled secret egress only to gateway exec (%s)",
    async (host) => {
      vi.stubEnv("OPENCLAW_SECRET_SENTINELS", "false");
      writeEntries([
        { name: "AWS_REGION", value: "us-west-2", kind: "env" },
        {
          name: "SERVICE_API_KEY",
          value: "enabled-secret",
          kind: "secret",
          allowedHosts: ["API.EXAMPLE.COM"],
        },
      ]);
      mocks.egressActive = true;
      const env = await captureStoreExecEnvironment({
        host,
        callId: `call-egress-enabled-${host}`,
        config: { secrets: { egressProxy: { enabled: true } } },
      });
      if (host === "gateway") {
        expect(env.AWS_REGION).toBe("us-west-2");
        expect(looksLikeSecretSentinel(env.SERVICE_API_KEY ?? "")).toBe(true);
        expect(resolveSecretSentinel(env.SERVICE_API_KEY ?? "")).toBe("enabled-secret");
        expect(env).toMatchObject(EGRESS_ENV);
        const childEnv = mocks.spawnInputs.at(-1)?.env;
        expect(childEnv?.SERVICE_API_KEY).toBe(env.SERVICE_API_KEY);
        expect(JSON.stringify(childEnv)).not.toContain("enabled-secret");
        expect(JSON.stringify(env)).not.toContain("enabled-secret");
        expect(mocks.proxyBindings).toEqual([
          [
            expect.objectContaining({
              name: "SERVICE_API_KEY",
              allowedHosts: ["api.example.com"],
              sentinel: env.SERVICE_API_KEY,
            }),
          ],
        ]);
        return;
      }

      expect(env).not.toHaveProperty("AWS_REGION");
      expect(env).not.toHaveProperty("SERVICE_API_KEY");
      expect(JSON.stringify(env)).not.toContain("oc-sent-v2.");
      for (const [key, value] of Object.entries(EGRESS_ENV)) {
        expect(env[key]).not.toBe(value);
      }
      expect(mocks.proxyBindings).toEqual([]);
    },
  );
});
