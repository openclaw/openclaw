import { inspect as inspectValue } from "node:util";
import type { SpawnResult } from "openclaw/plugin-sdk/process-runtime";
import { describe, expect, it, vi } from "vitest";
import {
  isUnrecognizedLease,
  runCrabboxCommand,
  stopCrabboxLease,
} from "./crabbox-worker-command.js";

const LEASE_ID = "cbx_absent_fixture";
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
