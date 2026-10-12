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
      Value.Check(WorkerSlotSummarySchema, { total: 1, available: 0, reclaimableIdle: 1 }),
    ).toBe(true);
    expect(
      Value.Check(WorkerSlotSummarySchema, { total: 1, available: 1, reclaimableIdle: 1 }),
    ).toBe(false);
    expect(
      Value.Check(WorkerSlotSummarySchema, { total: 4, available: 0, reclaimableIdle: 3 }),
    ).toBe(false);
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
    expect(
      Value.Check(EnvironmentSummarySchema, {
        ...node,
        requiredNodeCommand: {
          command: "runtime.exec",
          state: "undeclared",
          message: "Enable the runtime plugin on the node, then reconnect it.",
        },
      }),
    ).toBe(true);
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
      { command: "runtime.exec", state: "undeclared", message: "" },
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
});
