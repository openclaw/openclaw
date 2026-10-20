import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as faultProxy from "../substrate/fault-proxy.js";
import type { MatrixQaCliSession } from "./scenario-runtime-cli.js";
import { runMatrixQaE2eeCliEncryptionSetupBootstrapFailureScenario } from "./scenario-runtime-e2ee-cli-account.js";
import { MATRIX_QA_ROOM_KEY_BACKUP_VERSION_ENDPOINT } from "./scenario-runtime-e2ee-shared.js";
import { createMatrixQaE2eeTestContext } from "./scenario-runtime-e2ee.test-helpers.js";

const mocks = vi.hoisted(() => ({ createRuntime: vi.fn() }));
vi.mock("./scenario-runtime-e2ee-cli-runtime.js", () => ({
  createMatrixQaCliE2eeSetupRuntime: mocks.createRuntime,
}));
// mock-isolation: Synthetic account login must not contact a live Matrix homeserver.
vi.mock("../substrate/client.js", () => ({
  createMatrixQaClient: () => ({
    registerWithToken: async () => ({
      ...account("OWNER", "account-test-token"),
      password: "test-password",
    }),
    loginWithPassword: async () => account("CLI", "cli-test-token"),
  }),
}));
const startRealProxy = faultProxy.startMatrixQaFaultProxy;

function account(deviceId: string, accessToken: string) {
  return { deviceId, accessToken, userId: "@owner:matrix-qa.test" };
}

let root: string;
let proxy: Awaited<ReturnType<typeof startRealProxy>>;
let closed: boolean;
let stopping: Promise<void> | undefined;
let proxyCleanupFailure: Error | undefined;
let beforeProxyStop: (() => Promise<void>) | undefined;
const dispose = vi.fn(async () => {});
async function run() {
  closed = false;
  return runMatrixQaE2eeCliEncryptionSetupBootstrapFailureScenario(
    createMatrixQaE2eeTestContext(),
  ).finally(() => expect(closed).toBe(true));
}

beforeEach(async () => {
  vi.resetAllMocks();
  stopping = undefined;
  proxyCleanupFailure = undefined;
  beforeProxyStop = undefined;
  root = await mkdtemp(path.join(os.tmpdir(), "matrix-cli-bootstrap-"));
  configureCli();
  vi.spyOn(faultProxy, "startMatrixQaFaultProxy").mockImplementation(async (params) => {
    proxy = await startRealProxy(params);
    return {
      ...proxy,
      stop: async () => {
        await beforeProxyStop?.();
        stopping = proxy.stop();
        await stopping;
        closed = true; // The real stop joins the server's close event, not a port probe.
        if (proxyCleanupFailure) {
          throw proxyCleanupFailure;
        }
      },
    };
  });
});
afterEach(async () => {
  await (stopping ?? (proxy && !closed ? proxy.stop() : undefined));
  await rm(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function configureCli(
  methods: string[] = ["POST"],
  bootstrapError = "Matrix room key backup is not usable",
  executionFailure?: Error,
) {
  const stdout = JSON.stringify({ success: false, bootstrap: { error: bootstrapError } });
  mocks.createRuntime.mockImplementation(async () => ({
    rootDir: root,
    dispose,
    start: (args: string[]): Pick<MatrixQaCliSession, "kill" | "wait"> => ({
      kill: () => {},
      wait: async () => {
        for (const method of methods) {
          const response = await fetch(
            `${proxy.baseUrl}${MATRIX_QA_ROOM_KEY_BACKUP_VERSION_ENDPOINT}`,
            { method, headers: { authorization: "Bearer cli-test-token" } },
          );
          await response.arrayBuffer();
        }
        if (executionFailure) {
          throw executionFailure;
        }
        return { args, exitCode: 7, stdout, stderr: "" };
      },
    }),
  }));
}

it("rejects CLI failure without POST evidence", async () => {
  configureCli(["GET"]);
  await expect(run()).rejects.toThrow("did not attempt faulted room-key backup creation");
  expect(dispose).toHaveBeenCalledOnce();
});

it("accepts POST plus backup failure and rejects an unrelated CLI failure", async () => {
  configureCli(["GET", "POST"]);
  await expect(run()).resolves.toMatchObject({
    artifacts: { bootstrapSuccess: false, faultHitCount: 2 },
  });
  configureCli(["POST"], "unrelated failure");
  await expect(run()).rejects.toThrow("unexpected reason");
});

it("does not accept partial failure JSON from a timed-out CLI", async () => {
  const failure = new Error("Matrix QA CLI command timed out after 1000ms");
  configureCli(["POST"], "Matrix room key backup is not usable", failure);
  await expect(run()).rejects.toBe(failure);
  expect(dispose).toHaveBeenCalledOnce();
});

it.each(["construction", "disposal", "undefined disposal"] as const)(
  "preserves %s failure through proxy cleanup",
  async (phase) => {
    const failure = phase === "disposal" ? new Error("CLI disposal failed") : undefined;
    proxyCleanupFailure =
      phase === "undefined disposal" ? undefined : new Error("proxy stop failed");
    if (phase === "construction") {
      mocks.createRuntime.mockRejectedValueOnce(failure);
    } else {
      dispose.mockRejectedValueOnce(failure);
    }
    await expect(run()).rejects.toEqual(
      proxyCleanupFailure
        ? expect.objectContaining({ cause: failure, errors: [failure, proxyCleanupFailure] })
        : undefined,
    );
  },
);

it("joins proxy cleanup before returning a CLI disposal failure", async () => {
  const disposalFailure = new Error("CLI disposal failed");
  const entered = createDeferred<void>();
  const release = createDeferred<void>();
  beforeProxyStop = async () => {
    entered.resolve();
    await release.promise;
  };
  dispose.mockRejectedValueOnce(disposalFailure);
  let settled = false;
  const operation = run().catch((error: unknown) => {
    settled = true;
    return error;
  });
  try {
    await entered.promise;
    await setImmediate();
    expect(settled).toBe(false);
  } finally {
    release.resolve();
    expect(await operation).toBe(disposalFailure);
  }
});
