import os from "node:os";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import { withInstallationTarget } from "../infra/installation-target-context.js";
import { looksLikeSecretSentinel, resolveSecretSentinel } from "../secrets/sentinel.js";
import * as secretStore from "../secrets/store/secret-store.js";
import { createDeferredCore } from "../shared/deferred.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db.js";
import { createWorkerPlacementTools } from "../worker/worker-placement-tools.js";
import {
  type CapturedEnvironment,
  environmentSandbox,
  sandboxExecSpec,
} from "./bash-tools.exec-env.test-support.js";
import { prepareCoreToolPolicy } from "./prepared-tool-surface.js";

const { mocks, EGRESS_ENV } = vi.hoisted(() => {
  const proxyUrl = ["http://openclaw:", "fixture-password", "@127.0.0.1:19090"].join("");
  return {
    EGRESS_ENV: {
      HTTPS_PROXY: proxyUrl,
      HTTP_PROXY: proxyUrl,
      NODE_USE_ENV_PROXY: "1",
      NODE_EXTRA_CA_CERTS: "/state/secret-egress/root-ca.pem",
      SSL_CERT_FILE: "/state/secret-egress/root-ca.pem",
      CURL_CA_BUNDLE: "/state/secret-egress/root-ca.pem",
      REQUESTS_CA_BUNDLE: "/state/secret-egress/root-ca.pem",
      GIT_SSL_CAINFO: "/state/secret-egress/root-ca.pem",
    },
    mocks: {
      shellPath: vi.fn<() => string | null>(() => null),
      egressActive: false,
      gatewayParams: [] as CapturedEnvironment[],
      nodeHostParams: [] as CapturedEnvironment[],
      spawnInputs: [] as Array<{ env?: Record<string, string> }>,
      proxyBindings: [] as Array<unknown>,
    },
  };
});

vi.mock("../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: () => null,
  getGlobalHookRunnerRegistry: () => null,
}));

// mock-isolation: Record synthetic proxy bindings without starting a credential-bearing proxy.
vi.mock("../secrets/egress-proxy/registry.js", () => ({
  isSecretEgressProxyActive: () => mocks.egressActive,
  registerSecretEgressProxyProcess: (bindings: unknown) => {
    mocks.proxyBindings.push(bindings);
    return {
      revoke: () => {},
      env: { ...EGRESS_ENV },
    };
  },
}));

// mock-isolation: Keep the host login shell out of secret-store environment fixtures.
vi.mock("../infra/shell-env.js", async () => ({
  ...(await import("./bash-tools.exec-env.test-support.js")).shellEnvironmentMock(),
  getShellPathFromLoginShell: mocks.shellPath,
}));
// mock-isolation: Capture Gateway execution parameters without running host commands.
vi.mock("./bash-tools.exec-host-gateway.js", async () =>
  (await import("./bash-tools.exec-env.test-support.js")).gatewayEnvironmentMock(mocks),
);
// mock-isolation: Capture node execution parameters without contacting a node.
vi.mock("./bash-tools.exec-host-node.js", async () =>
  (await import("./bash-tools.exec-env.test-support.js")).nodeEnvironmentMock(mocks),
);
// mock-isolation: Record secret-bearing spawn inputs without launching subprocesses.
vi.mock("../process/supervisor/index.js", async () =>
  (await import("./bash-tools.exec-env.test-support.js")).supervisorEnvironmentMock(mocks),
);

let createExecTool: typeof import("./bash-tools.exec-run.js").createExecTool;
let createLazyExecTool: typeof import("./lazy-exec-tool.js").createLazyExecTool;

const lazyTool = (host: "gateway" | "node" = "gateway") =>
  createLazyExecTool({ host, security: "full", ask: "off" });
const execute = (
  tool: ReturnType<typeof createLazyExecTool>,
  callId: string,
  command = "echo ok",
) => tool.execute(callId, { command, yieldMs: 120_000 });

const tempDirs = createTempDirTracker();
async function writeEntries(
  env: Record<string, string>,
  secrets: Array<{ name: string; value: string; allowedHosts?: string[] }> = [],
) {
  const entries = [
    ...Object.entries(env).map(([name, value]) => ({ name, value, kind: "env" as const })),
    ...secrets.map((entry) => ({ ...entry, kind: "secret" as const })),
  ];
  for (const entry of entries) {
    await secretStore.writeSecretStoreEntry({
      scope: { kind: "team" },
      ...entry,
      updatedBy: "test",
    });
  }
}

it.each(["gateway", "node"] as const)(
  "retains a lazy tool's local target outside its construction scope and fences %s",
  async (host) => {
    const target = {
      stateDir: "/fixture/diagnosed",
      configPath: "/fixture/custom.json",
      defaultWorkspaceDir: "/fixture/default-workspace",
    };
    const tool = withInstallationTarget(target, () => lazyTool(host));
    const run = execute(tool, "target-probe");
    if (host === "gateway") {
      await run;
      expect(mocks.spawnInputs.at(-1)?.env).toMatchObject({
        OPENCLAW_STATE_DIR: target.stateDir,
        OPENCLAW_CONFIG_PATH: target.configPath,
        OPENCLAW_WORKSPACE_DIR: target.defaultWorkspaceDir,
      });
      const ordinary = lazyTool(host);
      await withInstallationTarget(target, () => execute(ordinary, "ordinary-probe"));
      for (const key of ["OPENCLAW_STATE_DIR", "OPENCLAW_WORKSPACE_DIR"]) {
        expect(mocks.spawnInputs.at(-1)?.env?.[key]).toBe(process.env[key]);
      }
    } else {
      await expect(run).rejects.toThrow("saved prompt");
      expect(mocks.nodeHostParams).toEqual([]);
      expect(mocks.spawnInputs).toEqual([]);
    }
  },
);
afterEach(async () => {
  vi.restoreAllMocks();
  await closeOpenClawStateDatabaseAsync();
  vi.unstubAllEnvs();
  tempDirs.cleanup();
});
beforeAll(async () => {
  ({ createExecTool } = await import("./bash-tools.exec-run.js"));
  ({ createLazyExecTool } = await import("./lazy-exec-tool.js"));
});

beforeEach(() => {
  mocks.shellPath.mockReset().mockReturnValue(null);
  vi.stubEnv("OPENCLAW_STATE_DIR", tempDirs.make("openclaw-exec-store-env-"));
  vi.stubEnv("AWS_REGION", undefined);
  mocks.egressActive = false;
  mocks.gatewayParams.length = 0;
  mocks.nodeHostParams.length = 0;
  mocks.spawnInputs.length = 0;
  mocks.proxyBindings.length = 0;
});

type ExecParams = Parameters<ReturnType<typeof createExecTool>["execute"]>[1];
const runGateway = (params: ExecParams) =>
  createExecTool({ host: "gateway", security: "full", ask: "off" }).execute("exec", {
    yieldMs: 120_000,
    ...params,
  });

it("strips malformed XML arg-value suffixes from exec command and routing options", async () => {
  const workdir = tempDirs.make("openclaw-exec-xml-");
  const tool = createExecTool({ host: "gateway", security: "full", ask: "off" });
  const malformedArgs = {
    command: "echo ok</arg_value>>",
    workdir: `${workdir}</arg_value>>`,
    host: "gateway</arg_value>>",
    ask: "off</arg_value>>",
    node: "node-1</arg_value>>",
    yieldMs: 120_000,
  } as unknown as ExecParams;
  expect(await tool.prepareBeforeToolCallParams?.(malformedArgs, {})).toMatchObject({
    command: "echo ok",
    workdir,
    host: "gateway",
    ask: "off",
    node: "node-1",
  });
  await expect(tool.execute("call-xml-conflict", malformedArgs)).rejects.toThrow(
    'exec node="node-1" conflicts with host="gateway"',
  );
  const result = await tool.execute("call-xml-suffix", { ...malformedArgs, node: undefined });
  expect(result.content.find((entry) => entry.type === "text")?.text.trim()).toBe("ok");
});

it("rejects the unsupported cwd alias before command execution", async () => {
  await expect(runGateway({ command: "echo ok", cwd: os.tmpdir() } as never)).rejects.toThrow(
    'exec parameter "cwd" is unsupported; use "workdir" instead',
  );
});

it.runIf(process.platform !== "win32")("merges login-shell PATH for host=gateway", async () => {
  vi.stubEnv("OPENCLAW_EXEC_SHELL_SNAPSHOT", "0");
  vi.stubEnv("PATH", "/usr/bin");
  mocks.shellPath.mockReturnValue("/custom/bin:/opt/bin");
  await runGateway({ command: "echo $PATH" });
  expect(mocks.spawnInputs[0]?.env?.PATH?.split(/[:\s]+/).filter(Boolean)).toEqual([
    "/custom/bin",
    "/opt/bin",
    "/usr/bin",
  ]);
  expect(mocks.shellPath).toHaveBeenCalledTimes(1);
});

it("runs exact no-pager requests with empty rather than executable pager values", async () => {
  await runGateway({ command: "echo GIT_PAGER PAGER", env: { GIT_PAGER: "cat", PAGER: "cat" } });
  expect(mocks.spawnInputs[0]?.env).toMatchObject({ GIT_PAGER: "", PAGER: "" });
});

it.each([
  [{ PATH: "/explicit/bin" }, /Security Violation: Custom 'PATH' variable is forbidden/],
  [{ LD_DEBUG: "1" }, /Security Violation: Environment variable 'LD_DEBUG' is forbidden/],
  [
    { HTTPS_PROXY: "http://proxy.example.test:8080", NODE_TLS_REJECT_UNAUTHORIZED: "0" },
    /Security Violation: blocked override keys: HTTPS_PROXY, NODE_TLS_REJECT_UNAUTHORIZED\./,
  ],
] satisfies Array<[NonNullable<ExecParams["env"]>, RegExp]>)(
  "blocks unsafe host overrides %j before reading login PATH",
  async (env, error) => {
    if (process.platform === "win32" && "PATH" in env) {
      return;
    }
    await expect(runGateway({ command: "echo $PATH", env })).rejects.toThrow(error);
    expect(mocks.shellPath).not.toHaveBeenCalled();
  },
);

it.runIf(process.platform !== "win32")(
  "strips dangerous inherited env vars from host execution",
  async () => {
    vi.stubEnv("SSLKEYLOGFILE", "/tmp/openclaw-ssl-keys.log");
    await runGateway({ command: "printf '%s' \"${SSLKEYLOGFILE:-}\"" });
    expect(mocks.spawnInputs[0]?.env).not.toHaveProperty("SSLKEYLOGFILE");
  },
);

it("rejects /approve nested in shell wrappers", async () => {
  await expect(
    runGateway({
      command: "sudo -u root OPENCLAW_APPROVE=1 bash -lc '/approve abc123 allow-once'",
    }),
  ).rejects.toThrow(/exec cannot run \/approve commands/);
});

it("reuses a lazy exec instance's store snapshot and refreshes it for a new run", async () => {
  await writeEntries({ AWS_REGION: "us-west-2" }, [
    { name: "INTERNAL_VALUE", value: "not-for-subprocesses" },
  ]);
  const tool = lazyTool();

  await execute(tool, "code-mode-first", "echo one");
  await writeEntries({ AWS_REGION: "eu-west-1" });
  await execute(tool, "code-mode-nested", "echo two");

  expect(mocks.gatewayParams).toHaveLength(2);
  for (const params of mocks.gatewayParams) {
    expect(params.env.AWS_REGION).toBe("us-west-2");
    expect(params.env).not.toHaveProperty("INTERNAL_VALUE");
  }
  await execute(lazyTool(), "code-mode-next-run", "echo three");
  expect(mocks.gatewayParams.at(-1)?.env.AWS_REGION).toBe("eu-west-1");
});

it("runs worker placement exec without reading or projecting its scratch secret store", async () => {
  await writeEntries({ AWS_REGION: "synthetic-worker-store-value" });
  const workspaceDir = tempDirs.make("worker-exec-store-env-");
  const read = vi.spyOn(secretStore, "readSecretStoreExecEnvironment");
  const tools = createWorkerPlacementTools({
    policy: prepareCoreToolPolicy({}),
    cwd: workspaceDir,
    containmentRoot: workspaceDir,
    execAuthority: { host: "gateway", security: "full", ask: "off" },
    agentId: "main",
    sessionKey: "worker:store-env",
    sessionId: "store-env",
    runId: "worker-store-env",
  });
  const exec = tools.find((tool) => tool.name === "exec");
  if (!exec) {
    throw new Error("Worker placement exec tool is unavailable");
  }

  const result = await execute(exec, "worker-store-env");

  expect(result.details).toMatchObject({ status: "completed", exitCode: 0 });
  expect(mocks.spawnInputs).toHaveLength(1);
  expect(mocks.spawnInputs[0]?.env).not.toHaveProperty("AWS_REGION");
  expect(read).not.toHaveBeenCalled();
});

it("refuses a cancelled exec after its store read without cancelling the run's shared snapshot", async () => {
  await writeEntries({ AWS_REGION: "us-west-2" });
  const replyReady = createDeferredCore();
  const releaseReply = createDeferredCore();
  const readStore = secretStore.readSecretStoreExecEnvironment;
  const read = vi
    .spyOn(secretStore, "readSecretStoreExecEnvironment")
    .mockImplementationOnce(async (params) => {
      const environment = await readStore(params);
      replyReady.resolve();
      await releaseReply.promise;
      return environment;
    });
  const tool = createExecTool({ host: "gateway", security: "full", ask: "off" });
  const controller = new AbortController();
  const execution = tool
    .execute("cancelled-store-read", { command: "echo cancelled" }, controller.signal)
    .then(
      (value) => ({ status: "completed" as const, value }),
      (error: unknown) => ({ status: "rejected" as const, error }),
    );
  void execution.then((outcome) => {
    replyReady.reject(
      outcome.status === "rejected"
        ? outcome.error
        : new Error("Exec completed before the store reply"),
    );
  });
  try {
    await replyReady.promise;
    controller.abort(new Error("synthetic exec cancellation"));
    releaseReply.resolve();
    expect(await execution).toMatchObject({
      status: "rejected",
      error: expect.objectContaining({ message: "synthetic exec cancellation" }),
    });
    expect(mocks.gatewayParams).toEqual([]);
    expect(mocks.spawnInputs).toEqual([]);

    const later = await tool.execute("shared-store-read", { command: "echo later" });
    expect(later.details).toMatchObject({ status: "completed", exitCode: 0 });
    expect(mocks.spawnInputs).toHaveLength(1);
    expect(mocks.spawnInputs[0]?.env?.AWS_REGION).toBe("us-west-2");
    expect(read).toHaveBeenCalledOnce();
  } finally {
    releaseReply.resolve();
    await execution;
  }
});

it("ignores protected store entries without replacing inherited network settings", async () => {
  vi.stubEnv("PATH", "/inherited/bin");
  vi.stubEnv("HTTPS_PROXY", "http://inherited-proxy.test:8080");
  vi.stubEnv("NODE_EXTRA_CA_CERTS", "/inherited/ca.pem");
  await writeEntries({
    PATH: "/store/bin",
    HTTPS_PROXY: "http://store-proxy.test:8080",
    NODE_EXTRA_CA_CERTS: "/store/ca.pem",
  });
  const result = await execute(lazyTool(), "call-protected-store-env");

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

it.each(["gateway", "sandbox"] as const)(
  "applies enabled secret egress only to gateway exec (%s)",
  async (host) => {
    vi.stubEnv("OPENCLAW_SECRET_SENTINELS", "false");
    await writeEntries({ AWS_REGION: "us-west-2" }, [
      {
        name: "SERVICE_API_KEY",
        value: "enabled-secret",
        allowedHosts: ["API.EXAMPLE.COM"],
      },
    ]);
    mocks.egressActive = true;
    let sandboxEnv: Record<string, string> | undefined;
    const sandbox = environmentSandbox({
      containerName: "store-env-sandbox",
      containerWorkdir: "/workspace",
      buildExecSpec: async (input) => {
        sandboxEnv = { ...input.env };
        return sandboxExecSpec(input.command);
      },
    });
    const tool = createExecTool({
      host,
      security: "full",
      ask: "off",
      cwd: process.cwd(),
      sandbox: host === "sandbox" ? sandbox : undefined,
      operationalRunInstance: { instanceId: "instance-1", runId: "run-1" },
      config: { secrets: { egressProxy: { enabled: true } } },
    });
    await execute(tool, `call-egress-enabled-${host}`);
    const env = (host === "gateway" ? mocks.spawnInputs.at(-1)?.env : sandboxEnv) ?? {};
    if (host === "gateway") {
      expect(env.AWS_REGION).toBe("us-west-2");
      expect(looksLikeSecretSentinel(env.SERVICE_API_KEY ?? "")).toBe(true);
      expect(resolveSecretSentinel(env.SERVICE_API_KEY ?? "")).toBe("enabled-secret");
      expect(env).toMatchObject(EGRESS_ENV);
      expect(JSON.stringify(env)).not.toContain("enabled-secret");
      const binding = expect.objectContaining({
        name: "SERVICE_API_KEY",
        allowedHosts: ["api.example.com"],
        sentinel: env.SERVICE_API_KEY,
      });
      expect(mocks.proxyBindings).toEqual([[binding]]);
      return;
    }

    expect(env).not.toHaveProperty("AWS_REGION");
    expect(env).not.toHaveProperty("SERVICE_API_KEY");
    expect(JSON.stringify(env).includes("oc-sent-v2.")).toBe(false);
    for (const [key, value] of Object.entries(EGRESS_ENV)) {
      expect(env[key]).not.toBe(value);
    }
    expect(mocks.proxyBindings).toEqual([]);
  },
);
