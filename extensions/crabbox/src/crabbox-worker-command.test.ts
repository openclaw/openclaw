import { syncBuiltinESMExports } from "node:module";
import timers from "node:timers/promises";
import { inspect as inspectValue } from "node:util";
import type { SpawnResult } from "openclaw/plugin-sdk/process-runtime";
import { afterEach, expect, it, vi } from "vitest";
import { commandResult } from "../../test-support/command-result.test-support.js";
import * as processRunner from "./crabbox-process.js";
import {
  isUnrecognizedLease,
  runCrabboxCommand,
  runCrabboxCommandWithCoordinatorRetry,
  stopCrabboxLease,
} from "./crabbox-worker-command.js";

const LEASE_ID = "cbx_0123456789ab";
const readError = `coordinator GET /v1/leases/${LEASE_ID}: http 404: {"error":"not_found"}`;
const releaseError = `coordinator POST /v1/leases/${LEASE_ID}/release: http 404: {"error":"not_found"}`;
const absentOutput = `warning: could not inspect lease before release: ${readError}\n${releaseError}`;
const absentResult: SpawnResult = commandResult({ stderr: absentOutput, code: 1 });

const leaseTimeout = `Get "https://coordinator.example/v1/leases/${LEASE_ID}?providerMetadata=authoritative": context deadline exceeded`;
const transportFailure = { ...absentResult, stderr: leaseTimeout };

afterEach(() => {
  vi.restoreAllMocks();
  syncBuiltinESMExports();
});

const stopLease = (warn = vi.fn(), provider = "aws") =>
  stopCrabboxLease({ binary: "crabbox", id: LEASE_ID, provider, warn });
const retryStop = (signal?: AbortSignal) =>
  runCrabboxCommandWithCoordinatorRetry({
    action: "stop",
    args: ["stop", "--id", LEASE_ID],
    binary: "crabbox",
    timeoutMs: 5_000,
    signal,
  });
function mockSleep(sleep: (ms: number) => Promise<void>) {
  vi.spyOn(timers, "setTimeout").mockImplementation(async (milliseconds, value) => {
    await sleep(milliseconds ?? 1);
    return value;
  });
  syncBuiltinESMExports();
}

it.each<[name: string, result: Partial<SpawnResult>, transient: boolean]>([
  ["lease read", {}, true],
  [
    "CLI retry and joined deadline",
    {
      stderr: `coordinator read retry 1/4 reason=timeout\ncontext deadline exceeded\n${leaseTimeout}`,
    },
    true,
  ],
  [
    "heartbeat",
    {
      stderr: leaseTimeout
        .replace("Get", "Post")
        .replace("?providerMetadata=authoritative", "/heartbeat"),
    },
    true,
  ],
  ["bare deadline", { stderr: "context deadline exceeded" }, false],
  ["retry diagnostic alone", { stderr: "coordinator read retry 1/4 reason=timeout" }, false],
  ["script stdout", { stdout: "installing packages" }, false],
  ["script stderr", { stderr: `${leaseTimeout}\napt failed` }, false],
  ["bootstrap phase", { stdout: "CRABBOX_PHASE:openclaw-bootstrap-start" }, false],
  ["authentication", { stderr: `${leaseTimeout}\nauthentication failed` }, false],
  ["other endpoint", { stderr: leaseTimeout.replace("/leases/", "/runs/") }, false],
  ["process timeout", { termination: "timeout", code: null }, false],
  ["successful exit", { code: 0 }, false],
])("retries only coordinator failures: %s", async (_name, result, transient) => {
  const failure = { ...transportFailure, ...result };
  const runCommand = vi
    .spyOn(processRunner, "runCrabboxProcess")
    .mockResolvedValueOnce(failure)
    .mockResolvedValue({ ...absentResult, code: 0, stderr: "" });
  vi.spyOn(timers, "setTimeout").mockResolvedValue(undefined);
  syncBuiltinESMExports();
  const stopped = stopLease();
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
    .spyOn(processRunner, "runCrabboxProcess")
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
  mockSleep(sleep);
  const stopped = stopLease(warn);
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
    vi.spyOn(performance, "now").mockImplementation(() => elapsedMs);
    const timeouts: number[] = [];
    const sleep = vi.fn(async (ms: number) => {
      elapsedMs += ms;
    });
    mockSleep(sleep);
    vi.spyOn(processRunner, "runCrabboxProcess").mockImplementation(async (_argv, options) => {
      timeouts.push(options.timeoutMs);
      elapsedMs += timeouts.length === 1 ? 60_000 : options.timeoutMs;
      return processTimeout && timeouts.length > 1
        ? { ...absentResult, code: null, termination: "timeout", stderr: "" }
        : transportFailure;
    });
    await expect(stopLease()).rejects.toThrow(/Get .*context deadline exceeded.*after 2 attempts/s);
    expect(timeouts).toHaveLength(2);
    expect(timeouts[1]).toBe(timeouts[0]! - 61_000);
    expect(sleep).toHaveBeenCalledTimes(1);
  },
);

it.each([-90_000, 90_000])(
  "shares command and backoff budget after a %i ms wall-clock step",
  async (clockStepMs) => {
    let monotonicMs = 0;
    let wallStep = 0;
    vi.spyOn(performance, "now").mockImplementation(() => monotonicMs);
    vi.spyOn(Date, "now").mockImplementation(() => monotonicMs + wallStep);
    const timeouts: number[] = [];
    const sleep = vi.fn(async (ms: number) => {
      monotonicMs += ms;
    });
    mockSleep(sleep);
    vi.spyOn(processRunner, "runCrabboxProcess").mockImplementation(async (_argv, options) => {
      timeouts.push(options.timeoutMs);
      monotonicMs += 1_000;
      wallStep = clockStepMs;
      return transportFailure;
    });
    const result = await retryStop();
    expect(timeouts).toEqual([5_000, 3_000]);
    expect(sleep.mock.calls).toEqual([[1_000]]);
    expect(result).toMatchObject({ ...transportFailure, coordinatorAttempts: 2 });
  },
);

it("does not start another command when cancelled during retry backoff", async () => {
  const controller = new AbortController();
  const reason = new Error("cancelled during coordinator retry");
  const runCommand = vi
    .spyOn(processRunner, "runCrabboxProcess")
    .mockResolvedValue(transportFailure);
  vi.spyOn(timers, "setTimeout").mockImplementation(async (_milliseconds, value) => {
    controller.abort(reason);
    return value;
  });
  syncBuiltinESMExports();
  await expect(retryStop(controller.signal)).rejects.toBe(reason);
  expect(runCommand).toHaveBeenCalledOnce();
  expect(timers.setTimeout).toHaveBeenCalledExactlyOnceWith(1_000, undefined, {
    signal: controller.signal,
  });
});
it("reports the runner failure without retaining private error data", async () => {
  const token = "synthetic-command-secret-0123456789";
  const cause = Object.assign(
    new Error(`output capture failed token=${token}`, {
      cause: new Error(`nested token=${token}`),
    }),
    { stdout: token, stderr: token },
  );
  vi.spyOn(processRunner, "runCrabboxProcess").mockRejectedValue(cause);
  const error = await runCrabboxCommand({
    action: "warmup",
    args: ["warmup"],
    binary: "crabbox",
    timeoutMs: 1_000,
  }).catch((rejection: unknown) => rejection);
  expect(error).toMatchObject({
    message: expect.stringContaining("Crabbox warmup execution failed: output capture failed"),
  });
  expect(inspectValue(error, { depth: null })).not.toContain(token);
  expect(error).not.toHaveProperty("cause");
  expect(error).toHaveProperty("message", expect.not.stringContaining("synthetic-command-secret"));
});

const metadataQuery = (text: string) =>
  text.replace(`${LEASE_ID}:`, `${LEASE_ID}?providerMetadata=authoritative:`);
type AbsenceCase = [
  name: string,
  result: string | Partial<SpawnResult>,
  absent: boolean,
  inspect?: boolean,
];

it.each<AbsenceCase>([
  ["matching read and release 404/not_found", {}, true],
  [
    "absolute coordinator URLs",
    absentOutput.replaceAll("/v1/", "https://coordinator.example/v1/"),
    true,
  ],
  ["inspect metadata query", metadataQuery(readError), false, true],
  ["stop metadata query", metadataQuery(absentOutput), true],
  [
    "query on a different lease read",
    `coordinator GET /v1/leases/cbx_other?providerMetadata=authoritative: http 404: {"error":"not_found"}\n${releaseError}`,
    false,
  ],
  ["diagnostics split across streams", { stderr: `${readError}\n`, stdout: releaseError }, true],
  [
    "release 503 after a read 404",
    `${readError}\n${releaseError.replace("404", "503")}`,
    false,
    true,
  ],
  ["read-only 404", readError, false, true],
  ["release-only 404", releaseError, false],
  ["truncated release body", absentOutput.slice(0, -2), false, true],
  [
    "unexplained 404 response",
    absentOutput.replaceAll('"not_found"', '"route_missing"'),
    false,
    true,
  ],
  ["different identifier", absentOutput.replaceAll(LEASE_ID, "cbx_other"), false],
  [
    "release names a different lease",
    `${readError}\n${releaseError.replace(LEASE_ID, "cbx_other")}`,
    false,
    true,
  ],
  ["identifier prefix only", absentOutput.replaceAll(LEASE_ID, `${LEASE_ID}_other`), false],
  ["timeout with absence output", { termination: "timeout", code: null, killed: true }, false],
  ["signal with absence output", { termination: "signal", code: null, signal: "SIGTERM" }, false],
  ["unknown exit code", { code: null }, false],
  ...["auth", "authentication", "authorization", "credentials", "permission", "token"].map(
    (word): AbsenceCase => [
      `${word} diagnostic`,
      { stdout: `${word} failure for ${LEASE_ID}` },
      false,
    ],
  ),
  ...[
    `lease/server not found: ${LEASE_ID}`,
    `unikraftcloud lease ${LEASE_ID} no longer exists`,
    `unknown lease: ${LEASE_ID}`,
  ].map((stderr): AbsenceCase => [stderr, { code: 4, stderr }, true]),
  [
    "provider absence with wrong exit code",
    { code: 1, stderr: `lease/server not found: ${LEASE_ID}` },
    false,
  ],
  [
    "missing claim without remote absence",
    `lease ${LEASE_ID} has no local claim; if an earlier stop verified absence, nothing remains to do; otherwise check the ID, provider, and provider inventory before recovery`,
    false,
  ],
  [
    "W&B missing claim",
    { code: 4, stderr: `wandb sandbox "${LEASE_ID}" has no matching local ownership claim` },
    false,
    true,
  ],
  [
    "unclaimed sandbox",
    { code: 4, stderr: `cubesandbox sandbox "${LEASE_ID}" is not claimed by Crabbox` },
    false,
    true,
  ],
  [
    "coder recognition is not stop confirmation",
    { code: 5, stderr: `coder workspace "${LEASE_ID}" not found` },
    false,
    true,
  ],
])("%s", async (_name, overrides, absent, inspect = absent) => {
  const result = {
    ...absentResult,
    ...(typeof overrides === "string" ? { stderr: overrides } : overrides),
  };
  expect(isUnrecognizedLease(result, LEASE_ID, "inspect")).toBe(inspect ?? absent);
  expect(isUnrecognizedLease(result, LEASE_ID, "stop")).toBe(absent);
  const warn = vi.fn();
  vi.spyOn(processRunner, "runCrabboxProcess").mockResolvedValue(result);
  const stop = stopLease(warn, "hetzner");
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
