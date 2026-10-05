import { inspect as inspectValue } from "node:util";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { SpawnResult } from "openclaw/plugin-sdk/process-runtime";
import { describe, expect, it, vi } from "vitest";
import {
  isUnrecognizedLease,
  runCrabboxCommand,
  stopCrabboxLease,
} from "./crabbox-worker-command.js";

const commandLog = vi.hoisted(() => vi.fn());
vi.mock("openclaw/plugin-sdk/logging-core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/logging-core")>()),
  createSubsystemLogger: () => ({ info: commandLog }),
}));

it("records settled CLI facts before preserving caller cancellation and unknown remote effects", async () => {
  commandLog.mockReset();
  const pending = createDeferred<SpawnResult>();
  const controller = new AbortController();
  const reason = new Error("private-caller-reason");
  const request = runCrabboxCommand({
    action: "node runtime preparation",
    args: ["run", "private-argv"],
    binary: "crabbox",
    timeoutMs: 1000,
    signal: controller.signal,
    diagnostics: { operationId: "operation-1", leaseId: "cbx_1", stage: "runtime-preparation" },
    runCommand: () => pending.promise,
  });
  const outcome = request.catch((error: unknown) => error);
  try {
    expect(commandLog).toHaveBeenCalledWith(
      "crabbox command",
      expect.objectContaining({ disposition: "runner_invoked", remoteEffects: "unknown" }),
    );
    controller.abort(reason);
  } finally {
    pending.resolve({
      ...absentResult,
      pid: 17,
      code: 0,
      stderr: "private-stderr",
      stdout: "private-stdout",
    });
    await outcome;
  }
  expect(await outcome).toBe(reason);
  expect(commandLog).toHaveBeenCalledWith(
    "crabbox command",
    expect.objectContaining({
      disposition: "runner_settled",
      provisionStage: "runtime-preparation",
      pid: 17,
      exitCode: 0,
      termination: "exit",
      callerAborted: true,
      remoteEffects: "unknown",
    }),
  );
  const records = commandLog.mock.calls.map(([, fields]) => fields);
  expect(records.every((record) => record.commandId === records[0].commandId)).toBe(true);
  expect(JSON.stringify(records)).not.toContain("private-");
});

it("retains bounded setup timing under host command custody without remote identity or output", async () => {
  commandLog.mockReset();
  await runCrabboxCommand({
    action: "profile setup",
    args: ["run"],
    binary: "crabbox",
    timeoutMs: 1000,
    diagnostics: { operationId: "operation-1", leaseId: "cbx_1", stage: "profile-setup" },
    runCommand: async (_argv, options) => {
      const send = (text: string, stream: "stderr" | "stdout" = "stderr") =>
        options.onOutputChunk?.(Buffer.from(text), stream);
      send("TEAMCLAW_SETUP_V1 stage=node_probe outcome=sta");
      send(
        "rted elapsedMs=0\nTEAMCLAW_SETUP_V1 stage=node_probe outcome=succeeded exit=0 elapsedMs=12\n",
      );
      send("TEAMCLAW_SETUP_V1 stage=azure_identity outcome=failed exit=1 elapsedMs=23\n");
      send("TEAMCLAW_SETUP_V1 stage=env_load outcome=succeeded\n");
      send("TEAMCLAW_SETUP_V1 stage=secret_value outcome=succeeded elapsedMs=12\n");
      send("TEAMCLAW_SETUP_V1 stage=node_probe outcome=succeeded elapsedMs=2147483648\n");
      send(
        "TEAMCLAW_SETUP_V1 stage=node_probe outcome=succeeded elapsedMs=1 token=private-token\n",
      );
      send("TEAMCLAW_SETUP_V1 stage=node_probe outcome=succeeded elapsedMs=1\n", "stdout");
      send(
        'CRABBOX_WORKER_STAGE:{"leaseId":"cbx_1","stage":"installation","elapsedMs":7,"totalElapsedMs":9,"outcome":"completed"}\n',
      );
      return { stdout: "", stderr: "", code: 0, signal: null, killed: false, termination: "exit" };
    },
  });
  const records = commandLog.mock.calls.map(([, fields]) => fields);
  const events = records.filter((record) => record.disposition === "remote_milestone");
  expect(
    events.map((event) => [event.stage, event.outcome, event.elapsedMs, event.totalElapsedMs]),
  ).toEqual([
    ["setup-node_probe", "started", 0, undefined],
    ["setup-node_probe", "completed", 12, undefined],
    ["setup-azure_identity", "failed", 23, undefined],
    ["setup-env_load", "completed", undefined, undefined],
    ["worker-installation", "completed", 7, 9],
  ]);
  expect(
    events.every(
      (event) =>
        event.leaseId === "cbx_1" &&
        event.operationId === "operation-1" &&
        event.commandId === records[0].commandId,
    ),
  ).toBe(true);
  expect(JSON.stringify(events)).not.toContain("private-token");
});

const LEASE_ID = "cbx_0123456789ab";
const readError = `coordinator GET /v1/leases/${LEASE_ID}: http 404: {"error":"not_found"}`;
const releaseError = `coordinator POST /v1/leases/${LEASE_ID}/release: http 404: {"error":"not_found"}`;
const absentOutput = `warning: could not inspect lease before release: ${readError}\n${releaseError}`;
const absentResult: SpawnResult = {
  stdout: "",
  stderr: absentOutput,
  code: 1,
  signal: null,
  killed: false,
  termination: "exit",
};

const leaseTimeout = `Get "https://coordinator.example/v1/leases/${LEASE_ID}?providerMetadata=authoritative": context deadline exceeded`;
const transportFailure = { ...absentResult, stderr: leaseTimeout };

describe("Crabbox coordinator timeouts", () => {
  it.each([
    { name: "lease read", result: {}, transient: true },
    {
      name: "CLI retry and joined deadline",
      result: {
        stderr: `coordinator read retry 1/4 reason=timeout\ncontext deadline exceeded\n${leaseTimeout}`,
      },
      transient: true,
    },
    {
      name: "heartbeat",
      result: {
        stderr: leaseTimeout
          .replace("Get", "Post")
          .replace("?providerMetadata=authoritative", "/heartbeat"),
      },
      transient: true,
    },
    { name: "bare deadline", result: { stderr: "context deadline exceeded" }, transient: false },
    {
      name: "retry diagnostic alone",
      result: { stderr: "coordinator read retry 1/4 reason=timeout" },
      transient: false,
    },
    { name: "script stdout", result: { stdout: "installing packages" }, transient: false },
    { name: "script stderr", result: { stderr: `${leaseTimeout}\napt failed` }, transient: false },
    {
      name: "bootstrap phase",
      result: { stdout: "CRABBOX_PHASE:openclaw-bootstrap-start" },
      transient: false,
    },
    {
      name: "authentication",
      result: { stderr: `${leaseTimeout}\nauthentication failed` },
      transient: false,
    },
    {
      name: "other endpoint",
      result: { stderr: leaseTimeout.replace("/leases/", "/runs/") },
      transient: false,
    },
    {
      name: "process timeout",
      result: { termination: "timeout" as const, code: null },
      transient: false,
    },
    { name: "successful exit", result: { code: 0 }, transient: false },
  ])("retries only coordinator failures: $name", async ({ result, transient }) => {
    const failure = { ...transportFailure, ...result };
    const runCommand = vi
      .fn()
      .mockResolvedValueOnce(failure)
      .mockResolvedValue({ ...absentResult, code: 0, stderr: "" });
    const stopped = stopCrabboxLease({
      binary: "crabbox",
      id: LEASE_ID,
      provider: "aws",
      runCommand,
      warn: vi.fn(),
      sleep: async () => {},
    });
    if (transient || failure.code === 0) {
      await expect(stopped).resolves.toBeUndefined();
    } else {
      await expect(stopped).rejects.toThrow();
    }
    expect(runCommand).toHaveBeenCalledTimes(transient ? 2 : 1);
  });

  it.each(["released", "absent", "timeout"])("retries stop until %s", async (outcome) => {
    const releaseTimeout = `warning: could not inspect lease before release: context deadline exceeded\n${leaseTimeout}\nPost "https://coordinator.example/v1/leases/${LEASE_ID}/release": context deadline exceeded`;
    const runCommand = vi
      .fn()
      .mockResolvedValueOnce({ ...transportFailure, stderr: releaseTimeout })
      .mockResolvedValue(
        outcome === "released"
          ? { ...absentResult, code: 0, stderr: "" }
          : outcome === "absent"
            ? absentResult
            : { ...transportFailure, stderr: releaseTimeout },
      );
    const warn = vi.fn();
    const sleep = vi.fn(async (_ms: number) => {});
    const stopped = stopCrabboxLease({
      binary: "crabbox",
      id: LEASE_ID,
      provider: "aws",
      runCommand,
      warn,
      sleep,
    });
    if (outcome === "timeout") {
      await expect(stopped).rejects.toThrow(/Post .*context deadline exceeded.*after 3 attempts/s);
    } else {
      await expect(stopped).resolves.toBeUndefined();
    }
    expect(runCommand).toHaveBeenCalledTimes(outcome === "timeout" ? 3 : 2);
    expect(warn).toHaveBeenCalledTimes(outcome === "absent" ? 1 : 0);
    expect(runCommand.mock.calls.every(([argv]) => argv.at(-1) === LEASE_ID)).toBe(true);
  });

  it.each([false, true])(
    "keeps the stop deadline and diagnostic, process timeout=%s",
    async (processTimeout) => {
      let elapsedMs = 0;
      const now = vi.spyOn(Date, "now").mockImplementation(() => elapsedMs);
      const timeouts: number[] = [];
      const sleep = vi.fn(async (ms: number) => {
        elapsedMs += ms;
      });
      try {
        await expect(
          stopCrabboxLease({
            binary: "crabbox",
            id: LEASE_ID,
            provider: "aws",
            warn: vi.fn(),
            sleep,
            runCommand: async (_argv, options) => {
              timeouts.push(options.timeoutMs);
              elapsedMs += timeouts.length === 1 ? 60_000 : options.timeoutMs;
              return processTimeout && timeouts.length > 1
                ? { ...absentResult, code: null, termination: "timeout", stderr: "" }
                : transportFailure;
            },
          }),
        ).rejects.toThrow(/Get .*context deadline exceeded.*after 2 attempts/s);
        expect(timeouts).toHaveLength(2);
        expect(timeouts[1]).toBe(timeouts[0]! - 61_000);
        expect(sleep).toHaveBeenCalledTimes(1);
      } finally {
        now.mockRestore();
      }
    },
  );
});
it.each(["output capture failed", "cleanup could not confirm process exit", "spawn ENOENT"])(
  "reports the runner failure without retaining private error data: %s",
  async (message) => {
    const token = "synthetic-command-secret-0123456789";
    const cause = Object.assign(
      new Error(`${message} token=${token}`, {
        cause: new Error(`nested token=${token}`),
      }),
      { stdout: token, stderr: token },
    );
    const error = await runCrabboxCommand({
      action: "warmup",
      args: ["warmup"],
      binary: "crabbox",
      timeoutMs: 1_000,
      runCommand: async () => {
        throw cause;
      },
    }).catch((rejection: unknown) => rejection);
    expect(error).toMatchObject({
      message: expect.stringContaining(`Crabbox warmup execution failed: ${message}`),
    });
    for (let current: unknown = error; current instanceof Error; current = current.cause) {
      expect(current.message).not.toContain(token);
    }
    expect(inspectValue(error, { depth: null })).not.toContain(token);
    expect(error).not.toHaveProperty("cause");
    expect(error).toHaveProperty(
      "message",
      expect.not.stringContaining("synthetic-command-secret"),
    );
  },
);

describe("Crabbox lease absence classification", () => {
  it.each<{
    name: string;
    result?: Partial<SpawnResult>;
    absent: boolean;
    inspect?: boolean;
  }>([
    { name: "matching coordinator read and release 404/not_found", absent: true },
    {
      name: "absolute coordinator URLs",
      result: { stderr: absentOutput.replaceAll("/v1/", "https://coordinator.example/v1/") },
      absent: true,
    },
    {
      // Crabbox 0.67 inspect adds a query string to the lease read.
      name: "authoritative metadata query on the inspect read",
      result: {
        stderr: readError.replace(`${LEASE_ID}:`, `${LEASE_ID}?providerMetadata=authoritative:`),
      },
      absent: false,
      inspect: true,
    },
    {
      name: "authoritative metadata query on the stop read",
      result: {
        stderr: absentOutput.replace(`${LEASE_ID}:`, `${LEASE_ID}?providerMetadata=authoritative:`),
      },
      absent: true,
    },
    {
      name: "query on a different lease read",
      result: {
        stderr: `coordinator GET /v1/leases/cbx_other?providerMetadata=authoritative: http 404: {"error":"not_found"}\n${releaseError}`,
      },
      absent: false,
    },
    {
      name: "diagnostics split across streams",
      result: { stderr: `${readError}\n`, stdout: releaseError },
      absent: true,
    },
    {
      name: "release 503 after a read 404",
      result: { stderr: `${readError}\n${releaseError.replace("404", "503")}` },
      absent: false,
      inspect: true,
    },
    {
      name: "read-only 404",
      result: { stderr: readError },
      absent: false,
      inspect: true,
    },
    {
      name: "release-only 404",
      result: { stderr: releaseError },
      absent: false,
    },
    {
      name: "truncated release body",
      result: { stderr: absentOutput.slice(0, -2) },
      absent: false,
      inspect: true,
    },
    {
      name: "unexplained 404 response",
      result: { stderr: absentOutput.replaceAll('"not_found"', '"route_missing"') },
      absent: false,
      inspect: true,
    },
    {
      name: "missing requested identifier",
      result: { stderr: absentOutput.replaceAll(LEASE_ID, "cbx_other") },
      absent: false,
    },
    {
      name: "release names a different lease",
      result: { stderr: `${readError}\n${releaseError.replace(LEASE_ID, "cbx_other")}` },
      absent: false,
      inspect: true,
    },
    {
      name: "requested identifier is only a prefix",
      result: { stderr: absentOutput.replaceAll(LEASE_ID, `${LEASE_ID}_other`) },
      absent: false,
    },
    {
      name: "timeout despite complete absence output",
      result: { termination: "timeout", code: null, killed: true },
      absent: false,
    },
    {
      name: "signal despite complete absence output",
      result: { termination: "signal", code: null, signal: "SIGTERM" },
      absent: false,
    },
    {
      name: "unknown exit code",
      result: { code: null },
      absent: false,
    },
    ...["auth", "authentication", "authorization", "credentials", "permission", "token"].map(
      (word) => ({
        name: `${word} diagnostic`,
        result: { stdout: `${word} failure for ${LEASE_ID}` },
        absent: false,
      }),
    ),
    ...[
      `lease/server not found: ${LEASE_ID}`,
      `unikraftcloud lease ${LEASE_ID} no longer exists`,
      `unknown lease: ${LEASE_ID}`,
    ].map((stderr) => ({ name: stderr, result: { code: 4, stderr }, absent: true })),
    {
      name: "direct provider absence with a different exit code",
      result: { code: 1, stderr: `lease/server not found: ${LEASE_ID}` },
      absent: false,
    },
    {
      name: "missing local claim without verified remote absence",
      result: {
        code: 1,
        stderr: `lease ${LEASE_ID} has no local claim; if an earlier stop verified absence, nothing remains to do; otherwise check the ID, provider, and provider inventory before recovery`,
      },
      absent: false,
    },
    {
      name: "W&B missing claim without an inventory observation",
      result: {
        code: 4,
        stderr: `wandb sandbox "${LEASE_ID}" has no matching local ownership claim`,
      },
      absent: false,
      inspect: true,
    },
    {
      name: "unclaimed sandbox is not confirmed absent",
      result: { code: 4, stderr: `cubesandbox sandbox "${LEASE_ID}" is not claimed by Crabbox` },
      absent: false,
      inspect: true,
    },
    {
      name: "coder recognition alone does not confirm stop",
      result: { code: 5, stderr: `coder workspace "${LEASE_ID}" not found` },
      absent: false,
      inspect: true,
    },
  ])("$name", async ({ result: overrides, absent, inspect }) => {
    const result = { ...absentResult, ...overrides };
    expect(isUnrecognizedLease(result, LEASE_ID, "inspect")).toBe(inspect ?? absent);
    expect(isUnrecognizedLease(result, LEASE_ID, "stop")).toBe(absent);
    const warn = vi.fn();
    const stop = stopCrabboxLease({
      binary: "crabbox",
      id: LEASE_ID,
      provider: "hetzner",
      runCommand: async () => result,
      warn,
    });
    if (absent) {
      await expect(stop).resolves.toBeUndefined();
      expect(warn).toHaveBeenCalledExactlyOnceWith(
        `Crabbox lease ${LEASE_ID} (provider hetzner) is absent; treating stop as already released`,
      );
    } else {
      await expect(stop).rejects.toThrow(
        result.termination === "exit"
          ? `Crabbox stop failed with exit code ${result.code ?? "unknown"}`
          : `Crabbox stop did not exit normally (${result.termination})`,
      );
      expect(warn).not.toHaveBeenCalled();
    }
  });
});
