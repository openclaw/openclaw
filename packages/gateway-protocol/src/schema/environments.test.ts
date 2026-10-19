import { describe, it } from "vitest";
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
import { accepts, rejects, acceptsParams, rejectsParams } from "./schema.test-support.js";

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

const node = { id: "node:build-mac", type: "node", status: "available" };

describe("worker environment protocol schemas", () => {
  it("accepts only boolean opt-in for prepared details in list and status requests", () => {
    for (const includePreparedDetails of [undefined, false, true]) {
      const option = includePreparedDetails === undefined ? {} : { includePreparedDetails };
      acceptsParams(validateEnvironmentsListParams, option);
      acceptsParams(validateEnvironmentsStatusParams, { environmentId: "worker-1", ...option });
    }
    for (const includePreparedDetails of [null, "true", 1]) {
      rejectsParams(validateEnvironmentsListParams, { includePreparedDetails });
      rejectsParams(validateEnvironmentsStatusParams, {
        environmentId: "worker-1",
        includePreparedDetails,
      });
    }
  });

  it("accepts opt-in desktop setup discovery with a closed credential-free result", () => {
    acceptsParams(validateEnvironmentsListParams, { includeDesktopSetup: true });
    acceptsParams(validateEnvironmentsListParams, { includeDesktopSetup: false });
    rejectsParams(validateEnvironmentsListParams, { includeDesktopSetup: "true" });
    const gateway = { id: "gateway", type: "local", status: "available" };
    for (const state of ["ready", "needs-server", "unsupported", "managed"]) {
      accepts(EnvironmentsListResultSchema, {
        environments: [{ ...gateway, desktopSetup: { state } }],
      });
    }
    accepts(EnvironmentSummarySchema, {
      ...gateway,
      desktopSetup: { state: "unsupported", detail: "VNC authentication is required" },
    });
    for (const desktopSetup of [
      {},
      { state: "unknown" },
      { state: "ready", password: "hidden" },
      { state: "unsupported", detail: "" },
    ]) {
      rejects(EnvironmentSummarySchema, { ...gateway, desktopSetup });
    }
  });
  it("accepts only a profile and local project selector for preparation", () => {
    const request = { profileId: "development", projectPath: "/projects/app" };
    acceptsParams(validateEnvironmentsPrepareParams, request);
    for (const invalid of [
      {},
      { profileId: "development" },
      { ...request, profileId: "" },
      { ...request, projectPath: "" },
      { ...request, setupAuthorized: false },
    ]) {
      rejectsParams(validateEnvironmentsPrepareParams, invalid);
    }
    const result = { environmentId: "worker-1", preparationKey: "project-key", reused: false };
    acceptsParams(validateEnvironmentsPrepareResult, result);
    acceptsParams(validateEnvironmentsPrepareResult, { ...result, reused: true });
    rejectsParams(validateEnvironmentsPrepareResult, { ...result, reused: "true" });
    rejectsParams(validateEnvironmentsPrepareResult, { ...result, preparationKey: "" });
  });

  it("rejects missing, empty, and unknown lifecycle request fields", () => {
    for (const request of [
      {},
      { profileId: "", idempotencyKey: "request-1" },
      { profileId: "development", idempotencyKey: "" },
      { profileId: "development", idempotencyKey: "request-1", providerId: "ssh" },
    ]) {
      rejectsParams(validateEnvironmentsCreateParams, request);
    }
    rejectsParams(validateEnvironmentsDestroyParams, { environmentId: "" });
    acceptsParams(validateEnvironmentsDestroyParams, {
      environmentId: "environment-1",
      force: true,
    });
  });

  it("keeps the worker lifecycle state closed", () => {
    for (const state of workerStates) {
      accepts(WorkerEnvironmentStateSchema, state);
    }
    rejects(WorkerEnvironmentStateSchema, "unknown");
  });

  it("accepts only redacted node worker bundle status", () => {
    const bundle = (workerBundle: unknown) => ({ ...node, workerBundle });
    accepts(EnvironmentSummarySchema, bundle({ status: "installed", version: "2026.8.9" }));
    accepts(EnvironmentSummarySchema, bundle({ status: "missing" }));
    rejects(
      EnvironmentSummarySchema,
      bundle({ status: "installed", version: "2026.8.9", bundleHash: "a".repeat(64) }),
    );
    rejects(EnvironmentSummarySchema, bundle({ status: "installed", version: "" }));
  });

  it("accepts only bounded closed worker slot summaries", () => {
    const slots = { total: 2, available: 1 };
    accepts(WorkerSlotSummarySchema, slots);
    accepts(WorkerSlotSummarySchema, { total: 1, available: 0, reclaimableIdle: 1 });
    rejects(WorkerSlotSummarySchema, { total: 1, available: 1, reclaimableIdle: 1 });
    rejects(WorkerSlotSummarySchema, { total: 4, available: 0, reclaimableIdle: 3 });
    accepts(EnvironmentSummarySchema, { ...node, workerSlots: slots });
    rejects(WorkerSlotSummarySchema, { total: 0, available: 0 });
    rejects(WorkerSlotSummarySchema, { total: 2, available: 3 });
    rejects(WorkerSlotSummarySchema, { total: 2, available: 1_025 });
    rejects(WorkerSlotSummarySchema, { ...slots, busy: 1 });
    rejects(EnvironmentSummarySchema, {
      ...node,
      workerSlots: { total: 2, available: 3 },
    });
  });

  it("accepts only bounded, unique effective node command authority", () => {
    accepts(EnvironmentSummarySchema, {
      ...node,
      invocableCommands: ["codex.exec-server.stdio.v1", "system.run"],
    });
    accepts(EnvironmentSummarySchema, { ...node, invocableCommands: [] });

    for (const invocableCommands of [
      [""],
      ["system.run", "system.run"],
      ["x".repeat(129)],
      Array.from({ length: 129 }, (_, index) => `command.${index}`),
    ]) {
      rejects(EnvironmentSummarySchema, { ...node, invocableCommands });
    }
  });

  it("keeps runtime-scoped node command state bounded and closed", () => {
    const command = (requiredNodeCommand: unknown) => ({ ...node, requiredNodeCommand });
    for (const state of ["invocable", "pending-approval", "undeclared", "unauthorized"] as const) {
      accepts(EnvironmentSummarySchema, command({ command: "runtime.exec", state }));
    }
    const commandState = command({ command: "runtime.exec", state: "invocable" });
    accepts(
      EnvironmentSummarySchema,
      command({
        command: "runtime.exec",
        state: "undeclared",
        message: "Enable the runtime plugin on the node, then reconnect it.",
      }),
    );
    for (const schema of [
      EnvironmentsCreateResultSchema,
      EnvironmentsDestroyResultSchema,
      EnvironmentsStatusResultSchema,
    ]) {
      rejects(schema, commandState);
    }
    for (const requiredNodeCommand of [
      { command: "", state: "undeclared" },
      { command: "x".repeat(129), state: "undeclared" },
      { command: "runtime.exec", state: "unknown" },
      { command: "runtime.exec", state: "undeclared", message: "" },
      { command: "runtime.exec", state: "invocable", pending: true },
    ]) {
      rejects(EnvironmentSummarySchema, command(requiredNodeCommand));
    }

    acceptsParams(validateEnvironmentsListParams, {});
    acceptsParams(validateEnvironmentsListParams, { runtimeId: "codex" });
    acceptsParams(validateEnvironmentsListParams, { projection: "profiles" });
    acceptsParams(validateEnvironmentsListParams, { runtimeId: "codex", projection: "profiles" });
    rejectsParams(validateEnvironmentsListParams, { projection: "unknown" });
    rejectsParams(validateEnvironmentsListParams, { runtimeId: "" });
    rejectsParams(validateEnvironmentsListParams, { runtimeId: "x".repeat(129) });
    rejectsParams(validateEnvironmentsListParams, { runtimeId: "codex", command: "runtime.exec" });
  });

  it("keeps desktop app launch requests, results, and projected ids closed", () => {
    const request = { environmentId: "worker:one", app: "browser" };
    acceptsParams(validateWorkerDesktopLaunchParams, request);
    acceptsParams(validateWorkerDesktopLaunchResult, { app: "terminal", status: "ready" });
    rejectsParams(validateWorkerDesktopLaunchParams, { ...request, app: "editor" });
    rejectsParams(validateWorkerDesktopLaunchParams, { ...request, args: ["--incognito"] });
    rejectsParams(validateWorkerDesktopLaunchResult, { app: "browser", status: "starting" });
    rejects(EnvironmentSummarySchema, {
      id: "environment-1",
      type: "worker",
      label: "Development worker",
      status: "available",
      worker: {
        providerId: "static-ssh",
        state: "ready",
        ageMs: 250,
        attachedSessionIds: [],
        tunnelStatus: "stopped",
        desktopApps: ["editor"],
      },
    });
  });

  it("lists configured worker profiles without provider settings", () => {
    const profile = { id: "aws", providerId: "crabbox" };
    const result = (overrides: Record<string, unknown>) => ({
      environments: [],
      profiles: [{ ...profile, ...overrides }],
    });
    accepts(EnvironmentsListResultSchema, {
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
    });
    for (const invalid of [
      { settings: { token: "hidden" } },
      { trust: "temporary" },
      { executionMode: "sandbox" },
      { executionModes: [] },
      { executionModes: ["worker-turn", "worker-turn"] },
      { executionModes: ["remote-exec", "worker-turn"] },
      { executionModes: ["worker-turn", "sandbox"] },
      { executionModes: ["worker-turn", "remote-exec", "worker-turn"] },
      { machines: [{ id: "standard", label: "Standard", cpu: 0 }] },
    ]) {
      rejects(EnvironmentsListResultSchema, result(invalid));
    }
  });
});
