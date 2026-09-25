import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import {
  EnvironmentsCreateResultSchema,
  EnvironmentsDestroyResultSchema,
  EnvironmentsListResultSchema,
  EnvironmentsStatusResultSchema,
  EnvironmentSummarySchema,
  validateEnvironmentsCreateParams,
  validateEnvironmentsDestroyParams,
  validateEnvironmentsListParams,
  validateEnvironmentsPrepareParams,
  validateEnvironmentsPrepareResult,
  validateEnvironmentsStatusParams,
  validateWorkerDesktopLaunchParams,
  validateWorkerDesktopLaunchResult,
  WorkerEnvironmentStateSchema,
} from "../index.js";
import { WorkerSlotSummarySchema } from "./environments.js";

const workerStates = [
  "requested",
  "provisioning",
  "bootstrapping",
  "ready",
  "attached",
  "idle",
  "draining",
  "destroying",
  "destroyed",
  "failed",
  "orphaned",
] as const;

function workerSummary(
  state: (typeof workerStates)[number],
  status: "available" | "unavailable" | "starting" = "starting",
) {
  return {
    id: "environment-1",
    type: "worker",
    label: "Development worker",
    status,
    worker: {
      providerId: "static-ssh",
      state,
      ageMs: 250,
      attachedSessionIds: [],
      tunnelStatus: "stopped",
    },
  };
}

describe("worker environment protocol schemas", () => {
  it("accepts only boolean opt-in for prepared details in list and status requests", () => {
    for (const includePreparedDetails of [undefined, false, true]) {
      const option = includePreparedDetails === undefined ? {} : { includePreparedDetails };
      expect(validateEnvironmentsListParams(option)).toBe(true);
      expect(validateEnvironmentsStatusParams({ environmentId: "worker-1", ...option })).toBe(true);
    }
    for (const includePreparedDetails of [null, "true", 1]) {
      expect(validateEnvironmentsListParams({ includePreparedDetails })).toBe(false);
      expect(
        validateEnvironmentsStatusParams({ environmentId: "worker-1", includePreparedDetails }),
      ).toBe(false);
    }
  });

  it("accepts opt-in desktop setup discovery with a closed credential-free result", () => {
    expect(validateEnvironmentsListParams({ includeDesktopSetup: true })).toBe(true);
    expect(validateEnvironmentsListParams({ includeDesktopSetup: false })).toBe(true);
    expect(validateEnvironmentsListParams({ includeDesktopSetup: "true" })).toBe(false);
    const gateway = { id: "gateway", type: "local", status: "available" };
    for (const state of ["ready", "needs-server", "unsupported", "managed"]) {
      expect(
        Value.Check(EnvironmentsListResultSchema, {
          environments: [{ ...gateway, desktopSetup: { state } }],
        }),
      ).toBe(true);
    }
    expect(
      Value.Check(EnvironmentSummarySchema, {
        ...gateway,
        desktopSetup: { state: "unsupported", detail: "VNC authentication is required" },
      }),
    ).toBe(true);
    for (const desktopSetup of [
      {},
      { state: "unknown" },
      { state: "ready", password: "hidden" },
      { state: "unsupported", detail: "" },
    ]) {
      expect(Value.Check(EnvironmentSummarySchema, { ...gateway, desktopSetup })).toBe(false);
    }
  });

  it("allows only bounded readonly profile metadata, never settings", () => {
    const check = (profile: Record<string, unknown>) =>
      Value.Check(EnvironmentsListResultSchema, {
        environments: [],
        profiles: [{ id: "production", providerId: "crabbox", ...profile }],
      });
    expect(check({})).toBe(true);
    expect(check({ providerDisplayId: "aws" })).toBe(true);
    expect(check({ providerDisplayId: "google-cloud" })).toBe(true);
    expect(check({ readyWorkers: 0 })).toBe(true);
    expect(check({ readyWorkers: 2 })).toBe(true);
    for (const providerDisplayId of ["", "AWS", "aws\n", "a".repeat(65), "aws/token", 42, {}]) {
      expect(check({ providerDisplayId })).toBe(false);
    }
    for (const readyWorkers of [-1, 0.5, "2", null]) {
      expect(check({ readyWorkers })).toBe(false);
    }
    expect(check({ providerDisplayId: "aws", settings: { provider: "aws" } })).toBe(false);
  });

  it("reports unique prepared reservation identities even above a reduced cap", () => {
    const check = (preparedPool: unknown) =>
      Value.Check(EnvironmentsListResultSchema, { environments: [], preparedPool });
    expect(Value.Check(EnvironmentsListResultSchema, { environments: [] })).toBe(true);
    expect(check({ maxTotal: 0, reservedEnvironmentIds: [] })).toBe(true);
    expect(check({ maxTotal: 4, reservedEnvironmentIds: ["worker:one", "worker:two"] })).toBe(true);
    expect(check({ maxTotal: 0, reservedEnvironmentIds: ["worker:one", "worker:two"] })).toBe(true);
    for (const preparedPool of [
      {},
      { maxTotal: 4 },
      { reservedEnvironmentIds: [] },
      { maxTotal: -1, reservedEnvironmentIds: [] },
      { maxTotal: 0.5, reservedEnvironmentIds: [] },
      { maxTotal: 4, reservedEnvironmentIds: [""] },
      { maxTotal: 4, reservedEnvironmentIds: [42] },
      { maxTotal: 4, reservedEnvironmentIds: "worker:one" },
      { maxTotal: 4, reservedEnvironmentIds: ["worker:one", "worker:one"] },
      { maxTotal: 4, reservedEnvironmentIds: [], reserved: 0 },
    ]) {
      expect(check(preparedPool)).toBe(false);
    }
  });

  it("accepts bounded desktop availability in environment lists and status responses", () => {
    const base = { id: "node:mac-1", type: "node", status: "available" };
    for (const state of ["locked", "unlocked", "unknown"]) {
      const summary = { ...base, desktopAvailability: { state } };
      expect(Value.Check(EnvironmentsListResultSchema, { environments: [summary] })).toBe(true);
      expect(Value.Check(EnvironmentsStatusResultSchema, summary)).toBe(true);
    }
    for (const desktopAvailability of [null, {}, { state: "idle" }, { state: "locked", idle: 1 }]) {
      expect(Value.Check(EnvironmentSummarySchema, { ...base, desktopAvailability })).toBe(false);
    }
  });
  it("accepts only a profile and local project selector for preparation", () => {
    const request = { profileId: "development", projectPath: "/projects/app" };
    expect(validateEnvironmentsPrepareParams(request)).toBe(true);
    for (const invalid of [
      {},
      { profileId: "development" },
      { ...request, profileId: "" },
      { ...request, projectPath: "" },
      { ...request, setupAuthorized: false },
    ]) {
      expect(validateEnvironmentsPrepareParams(invalid)).toBe(false);
    }
    const result = { environmentId: "worker-1", preparationKey: "project-key", reused: false };
    expect(validateEnvironmentsPrepareResult(result)).toBe(true);
    expect(validateEnvironmentsPrepareResult({ ...result, reused: true })).toBe(true);
    expect(validateEnvironmentsPrepareResult({ ...result, reused: "true" })).toBe(false);
    expect(validateEnvironmentsPrepareResult({ ...result, preparationKey: "" })).toBe(false);
  });

  it("preserves basic preparation summaries with optional closed lifecycle details", () => {
    const preparation = { purpose: "build", key: "project-key" };
    const details = {
      demandAtMs: 1_000,
      expiresAtMs: 2_000,
      consumedAtMs: null,
    };
    const baseCommit = "a".repeat(40);
    for (const purpose of ["build", "reserve"] as const) {
      const summary = {
        ...workerSummary("requested"),
        preparation: { ...preparation, purpose },
      };
      expect(Value.Check(EnvironmentsListResultSchema, { environments: [summary] })).toBe(true);
      expect(Value.Check(EnvironmentsStatusResultSchema, summary)).toBe(true);
    }
    for (const detail of [
      details,
      { ...details, project: { baseCommit } },
      { ...details, consumedAtMs: 1_500, project: { label: "openclaw", baseCommit } },
    ]) {
      expect(
        Value.Check(EnvironmentSummarySchema, {
          ...workerSummary("attached"),
          preparation: { ...preparation, details: detail },
        }),
      ).toBe(true);
    }
    const { demandAtMs: _demandAtMs, ...withoutDemand } = details;
    const { expiresAtMs: _expiresAtMs, ...withoutExpiry } = details;
    const { consumedAtMs: _consumedAtMs, ...withoutConsumption } = details;
    for (const invalid of [
      {},
      withoutDemand,
      withoutExpiry,
      withoutConsumption,
      { ...details, demandAtMs: -1 },
      { ...details, expiresAtMs: 0.5 },
      { ...details, consumedAtMs: -1 },
      { ...details, consumedAtMs: "1500" },
      { ...details, projectPath: "/projects/app" },
      { ...details, project: {} },
      { ...details, project: { baseCommit: "" } },
      { ...details, project: { baseCommit, label: "" } },
      { ...details, project: { baseCommit, root: "/projects/app" } },
    ]) {
      expect(
        Value.Check(EnvironmentSummarySchema, {
          ...workerSummary("requested"),
          preparation: { ...preparation, details: invalid },
        }),
      ).toBe(false);
    }
    for (const invalid of [
      { ...preparation, purpose: "unknown" },
      { ...preparation, key: "" },
      { ...preparation, projectPath: "/projects/app" },
      { ...preparation, demandAtMs: 1_000 },
    ]) {
      expect(
        Value.Check(EnvironmentSummarySchema, {
          ...workerSummary("requested"),
          preparation: invalid,
        }),
      ).toBe(false);
    }
  });

  it("accepts configured-profile create and environment-id destroy requests", () => {
    expect(
      validateEnvironmentsCreateParams({ profileId: "development", idempotencyKey: "request-1" }),
    ).toBe(true);
    expect(validateEnvironmentsDestroyParams({ environmentId: "environment-1" })).toBe(true);
  });

  it("rejects missing, empty, and unknown lifecycle request fields", () => {
    expect(validateEnvironmentsCreateParams({})).toBe(false);
    expect(validateEnvironmentsCreateParams({ profileId: "", idempotencyKey: "request-1" })).toBe(
      false,
    );
    expect(validateEnvironmentsCreateParams({ profileId: "development", idempotencyKey: "" })).toBe(
      false,
    );
    expect(
      validateEnvironmentsCreateParams({
        profileId: "development",
        idempotencyKey: "request-1",
        providerId: "ssh",
      }),
    ).toBe(false);
    expect(validateEnvironmentsDestroyParams({ environmentId: "" })).toBe(false);
    expect(validateEnvironmentsDestroyParams({ environmentId: "environment-1", force: true })).toBe(
      true,
    );
  });

  it("keeps the worker lifecycle state closed", () => {
    for (const state of workerStates) {
      expect(Value.Check(WorkerEnvironmentStateSchema, state)).toBe(true);
    }
    expect(Value.Check(WorkerEnvironmentStateSchema, "unknown")).toBe(false);
  });

  it("accepts worker metadata additively across summary and mutation results", () => {
    const requested = {
      ...workerSummary("requested"),
      platform: "linux",
      sessionHost: false,
      trust: "disposable",
    };
    const destroyedBase = workerSummary("destroyed", "unavailable");
    const destroyed = {
      ...destroyedBase,
      worker: {
        ...destroyedBase.worker,
        leaseId: "lease-1",
        idleMs: 50,
        destroyRequestedAtMs: 2_000,
        error: "provider teardown failed",
      },
    };

    expect(Value.Check(EnvironmentSummarySchema, requested)).toBe(true);
    expect(Value.Check(EnvironmentsCreateResultSchema, requested)).toBe(true);
    expect(Value.Check(EnvironmentsDestroyResultSchema, destroyed)).toBe(true);
    expect(
      Value.Check(EnvironmentSummarySchema, {
        ...workerSummary("ready", "available"),
        worker: {
          ...workerSummary("ready", "available").worker,
          desktop: true,
          desktopApps: ["browser", "terminal"],
        },
      }),
    ).toBe(true);
  });

  it("accepts only redacted node worker bundle status", () => {
    const node = {
      id: "node:build-mac",
      type: "node",
      status: "available",
    };
    expect(
      Value.Check(EnvironmentSummarySchema, {
        ...node,
        workerBundle: { status: "installed", version: "2026.8.9" },
      }),
    ).toBe(true);
    expect(
      Value.Check(EnvironmentSummarySchema, {
        ...node,
        workerBundle: { status: "missing" },
      }),
    ).toBe(true);
    expect(
      Value.Check(EnvironmentSummarySchema, {
        ...node,
        workerBundle: {
          status: "installed",
          version: "2026.8.9",
          bundleHash: "a".repeat(64),
        },
      }),
    ).toBe(false);
    expect(
      Value.Check(EnvironmentSummarySchema, {
        ...node,
        workerBundle: { status: "installed", version: "" },
      }),
    ).toBe(false);
  });

  it("accepts only bounded closed worker slot summaries", () => {
    const slots = { total: 2, available: 1 };
    expect(Value.Check(WorkerSlotSummarySchema, slots)).toBe(true);
    expect(
      Value.Check(EnvironmentSummarySchema, {
        id: "node:build-mac",
        type: "node",
        status: "available",
        workerSlots: slots,
      }),
    ).toBe(true);
    expect(Value.Check(WorkerSlotSummarySchema, { total: 0, available: 0 })).toBe(false);
    expect(Value.Check(WorkerSlotSummarySchema, { total: 2, available: 3 })).toBe(false);
    expect(Value.Check(WorkerSlotSummarySchema, { total: 2, available: 1_025 })).toBe(false);
    expect(Value.Check(WorkerSlotSummarySchema, { ...slots, busy: 1 })).toBe(false);
    expect(
      Value.Check(EnvironmentSummarySchema, {
        id: "node:build-mac",
        type: "node",
        status: "available",
        workerSlots: { total: 2, available: 3 },
      }),
    ).toBe(false);
  });

  it("accepts only bounded, unique effective node command authority", () => {
    const node = {
      id: "node:build-mac",
      type: "node",
      status: "available",
    };

    expect(
      Value.Check(EnvironmentSummarySchema, {
        ...node,
        invocableCommands: ["codex.exec-server.stdio.v1", "system.run"],
      }),
    ).toBe(true);
    expect(Value.Check(EnvironmentSummarySchema, { ...node, invocableCommands: [] })).toBe(true);

    for (const invocableCommands of [
      [""],
      ["system.run", "system.run"],
      ["x".repeat(129)],
      Array.from({ length: 129 }, (_, index) => `command.${index}`),
    ]) {
      expect(Value.Check(EnvironmentSummarySchema, { ...node, invocableCommands })).toBe(false);
    }
  });

  it("keeps runtime-scoped node command state bounded and closed", () => {
    const node = { id: "node:build-mac", type: "node", status: "available" };
    for (const state of ["invocable", "pending-approval", "undeclared", "unauthorized"] as const) {
      expect(
        Value.Check(EnvironmentSummarySchema, {
          ...node,
          requiredNodeCommand: { command: "runtime.exec", state },
        }),
      ).toBe(true);
    }
    const commandState = {
      ...node,
      requiredNodeCommand: { command: "runtime.exec", state: "invocable" },
    };
    for (const schema of [
      EnvironmentsCreateResultSchema,
      EnvironmentsDestroyResultSchema,
      EnvironmentsStatusResultSchema,
    ]) {
      expect(Value.Check(schema, commandState)).toBe(false);
    }
    for (const requiredNodeCommand of [
      { command: "", state: "undeclared" },
      { command: "x".repeat(129), state: "undeclared" },
      { command: "runtime.exec", state: "unknown" },
      { command: "runtime.exec", state: "invocable", pending: true },
    ]) {
      expect(Value.Check(EnvironmentSummarySchema, { ...node, requiredNodeCommand })).toBe(false);
    }

    expect(validateEnvironmentsListParams({})).toBe(true);
    expect(validateEnvironmentsListParams({ runtimeId: "codex" })).toBe(true);
    expect(validateEnvironmentsListParams({ projection: "profiles" })).toBe(true);
    expect(validateEnvironmentsListParams({ runtimeId: "codex", projection: "profiles" })).toBe(
      true,
    );
    expect(validateEnvironmentsListParams({ projection: "unknown" })).toBe(false);
    expect(validateEnvironmentsListParams({ runtimeId: "" })).toBe(false);
    expect(validateEnvironmentsListParams({ runtimeId: "x".repeat(129) })).toBe(false);
    expect(validateEnvironmentsListParams({ runtimeId: "codex", command: "runtime.exec" })).toBe(
      false,
    );
  });

  it("accepts bounded node lifecycle history and rejects malformed timestamps", () => {
    const node = {
      id: "node:build-mac",
      type: "node",
      status: "unavailable",
      lastConnectedAtMs: 1_000,
      lastDisconnectedAtMs: 2_000,
      lastSeenAtMs: 1_500,
      lastSeenReason: "silent_push",
    };
    expect(Value.Check(EnvironmentSummarySchema, node)).toBe(true);
    expect(Value.Check(EnvironmentSummarySchema, { ...node, lastDisconnectedAtMs: -1 })).toBe(
      false,
    );
    expect(Value.Check(EnvironmentSummarySchema, { ...node, lastSeenReason: "" })).toBe(false);
  });

  it("keeps desktop app launch requests, results, and projected ids closed", () => {
    expect(validateWorkerDesktopLaunchParams({ environmentId: "worker:one", app: "browser" })).toBe(
      true,
    );
    expect(validateWorkerDesktopLaunchResult({ app: "terminal", status: "ready" })).toBe(true);
    expect(validateWorkerDesktopLaunchParams({ environmentId: "worker:one", app: "editor" })).toBe(
      false,
    );
    expect(
      validateWorkerDesktopLaunchParams({
        environmentId: "worker:one",
        app: "browser",
        args: ["--incognito"],
      }),
    ).toBe(false);
    expect(validateWorkerDesktopLaunchResult({ app: "browser", status: "starting" })).toBe(false);
    expect(
      Value.Check(EnvironmentSummarySchema, {
        ...workerSummary("ready", "available"),
        worker: {
          ...workerSummary("ready", "available").worker,
          desktopApps: ["editor"],
        },
      }),
    ).toBe(false);
  });

  it("lists configured worker profiles without provider settings", () => {
    expect(
      Value.Check(EnvironmentsListResultSchema, {
        environments: [],
        profiles: [
          {
            id: "aws",
            providerId: "crabbox",
            trust: "disposable",
            executionMode: "worker-turn",
            executionModes: ["worker-turn", "remote-exec"],
            operatingSystems: [
              { id: "linux", label: "Linux", default: true },
              { id: "windows/wsl2", label: "Windows (WSL2)" },
            ],
            machines: [
              {
                id: "standard",
                label: "Standard",
                cpu: 32,
                memoryGb: 64,
                default: true,
                os: "linux",
              },
            ],
          },
          {
            id: "worker",
            providerId: "static-ssh",
            executionMode: "remote-exec",
            executionModes: ["remote-exec"],
          },
          { id: "legacy-primary", providerId: "static-ssh", executionMode: "worker-turn" },
          { id: "legacy", providerId: "static-ssh" },
        ],
      }),
    ).toBe(true);
    expect(
      Value.Check(EnvironmentsListResultSchema, {
        environments: [],
        profiles: [{ id: "aws", providerId: "crabbox", settings: { token: "hidden" } }],
      }),
    ).toBe(false);
    expect(
      Value.Check(EnvironmentsListResultSchema, {
        environments: [],
        profiles: [{ id: "aws", providerId: "crabbox", trust: "temporary" }],
      }),
    ).toBe(false);
    expect(
      Value.Check(EnvironmentsListResultSchema, {
        environments: [],
        profiles: [{ id: "aws", providerId: "crabbox", executionMode: "sandbox" }],
      }),
    ).toBe(false);
    for (const executionModes of [
      [],
      ["worker-turn", "worker-turn"],
      ["remote-exec", "worker-turn"],
      ["worker-turn", "sandbox"],
      ["worker-turn", "remote-exec", "worker-turn"],
    ]) {
      expect(
        Value.Check(EnvironmentsListResultSchema, {
          environments: [],
          profiles: [{ id: "aws", providerId: "crabbox", executionModes }],
        }),
      ).toBe(false);
    }
    expect(
      Value.Check(EnvironmentsListResultSchema, {
        environments: [],
        profiles: [
          {
            id: "aws",
            providerId: "crabbox",
            machines: [{ id: "standard", label: "Standard", cpu: 0 }],
          },
        ],
      }),
    ).toBe(false);
  });

  it("bounds provider-authored OS catalogs and machine choices", () => {
    const profile = { id: "aws", providerId: "crabbox" };
    const operatingSystems = Array.from({ length: 8 }, (_, i) => ({
      id: `os-${i}`,
      label: `OS ${i}`,
    }));
    const machines = Array.from({ length: 64 }, (_, i) => ({
      id: `class-${i}`,
      label: `Class ${i}`,
      os: "os-0",
    }));
    const accepts = (choices: object) =>
      Value.Check(EnvironmentsListResultSchema, {
        environments: [],
        profiles: [{ ...profile, ...choices }],
      });
    expect(accepts({ operatingSystems, machines })).toBe(true);
    expect(accepts({ machines: [{ id: "shared", label: "Shared" }] })).toBe(true);
    for (const choices of [
      { operatingSystems: [] },
      { operatingSystems: [...operatingSystems, { id: "overflow", label: "Overflow" }] },
      { operatingSystems: [{ id: "", label: "Empty ID" }] },
      { operatingSystems: [{ id: "x".repeat(65), label: "Long ID" }] },
      { operatingSystems: [{ id: "linux", label: "" }] },
      { operatingSystems: [{ id: "linux", label: "x".repeat(65) }] },
      { operatingSystems: [{ id: "linux", label: "Linux", settings: {} }] },
      { machines: [...machines, { id: "overflow", label: "Overflow" }] },
      { machines: [{ id: "tiny", label: "Tiny", os: "" }] },
      { machines: [{ id: "tiny", label: "Tiny", os: "x".repeat(65) }] },
    ]) {
      expect(accepts(choices)).toBe(false);
    }
  });

  it("preserves summaries without worker metadata and rejects malformed worker metadata", () => {
    expect(
      Value.Check(EnvironmentSummarySchema, {
        id: "gateway",
        type: "local",
        status: "available",
      }),
    ).toBe(true);
    expect(
      Value.Check(EnvironmentSummarySchema, {
        id: "node:outdated",
        type: "node",
        status: "available",
        issues: [
          {
            code: "update-required",
            action: "update-and-reconnect",
            updateCommand: "openclaw update",
            headlessReconnectCommand: "openclaw node restart",
          },
        ],
      }),
    ).toBe(true);
    expect(
      Value.Check(EnvironmentSummarySchema, {
        id: "node:outdated",
        type: "node",
        status: "available",
        issues: [{ code: "update-required", action: "run-legacy-worker" }],
      }),
    ).toBe(false);
    expect(
      Value.Check(EnvironmentSummarySchema, {
        ...workerSummary("ready", "available"),
        worker: { ...workerSummary("ready", "available").worker, ageMs: -1 },
      }),
    ).toBe(false);
    for (const destroyRequestedAtMs of [-1, 0.5, "2000", null]) {
      const summary = workerSummary("destroying");
      expect(
        Value.Check(EnvironmentSummarySchema, {
          ...summary,
          worker: { ...summary.worker, destroyRequestedAtMs },
        }),
      ).toBe(false);
    }
    expect(
      Value.Check(EnvironmentSummarySchema, {
        ...workerSummary("attached", "available"),
        worker: {
          ...workerSummary("attached", "available").worker,
          attachedSessionIds: [""],
        },
      }),
    ).toBe(false);
    expect(
      Value.Check(EnvironmentSummarySchema, {
        ...workerSummary("failed"),
        worker: { ...workerSummary("failed").worker, error: "" },
      }),
    ).toBe(false);
    expect(
      Value.Check(EnvironmentSummarySchema, {
        ...workerSummary("ready", "available"),
        trust: "temporary",
      }),
    ).toBe(false);
  });
});
