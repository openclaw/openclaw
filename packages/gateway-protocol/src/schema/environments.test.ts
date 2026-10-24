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
import { schemaValidation, validation } from "./protocol-validation.test-support.js";

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
const summary = schemaValidation(EnvironmentSummarySchema);
const listed = schemaValidation(EnvironmentsListResultSchema);
const listing = validation(validateEnvironmentsListParams);
const status = validation(validateEnvironmentsStatusParams);
const create = validation(validateEnvironmentsCreateParams);
const destroy = validation(validateEnvironmentsDestroyParams);
const prepare = validation(validateEnvironmentsPrepareParams);
const prepared = validation(validateEnvironmentsPrepareResult);
const slots = schemaValidation(WorkerSlotSummarySchema);
const launch = validation(validateWorkerDesktopLaunchParams);
const launched = validation(validateWorkerDesktopLaunchResult);
const profile = { id: "aws", providerId: "crabbox" };
const profileResult = (...profiles: unknown[]) => ({ environments: [], profiles });

describe("worker environment protocol schemas", () => {
  it("accepts only boolean opt-in for prepared details in list and status requests", () => {
    for (const includePreparedDetails of [undefined, false, true]) {
      const option = includePreparedDetails === undefined ? {} : { includePreparedDetails };
      listing.accepts(option);
      status.accepts({ environmentId: "worker-1", ...option });
    }
    for (const includePreparedDetails of [null, "true", 1]) {
      listing.rejects({ includePreparedDetails });
      status.rejects({ environmentId: "worker-1", includePreparedDetails });
    }
  });

  it("accepts opt-in desktop setup discovery with a closed credential-free result", () => {
    listing.accepts({ includeDesktopSetup: true }, { includeDesktopSetup: false });
    listing.rejects({ includeDesktopSetup: "true" });
    const gateway = { id: "gateway", type: "local", status: "available" };
    for (const state of ["ready", "needs-server", "unsupported", "managed"]) {
      listed.accepts({
        environments: [{ ...gateway, desktopSetup: { state } }],
      });
    }
    summary.accepts({
      ...gateway,
      desktopSetup: { state: "unsupported", detail: "VNC authentication is required" },
    });
    for (const desktopSetup of [
      {},
      { state: "unknown" },
      { state: "ready", password: "hidden" },
      { state: "unsupported", detail: "" },
    ]) {
      summary.rejects({ ...gateway, desktopSetup });
    }
  });
  it("accepts only a profile and local project selector for preparation", () => {
    const request = { profileId: "development", projectPath: "/projects/app" };
    prepare.accepts(request);
    prepare.rejects(
      {},
      { profileId: "development" },
      { ...request, profileId: "" },
      { ...request, projectPath: "" },
      { ...request, setupAuthorized: false },
    );
    const result = { environmentId: "worker-1", preparationKey: "project-key", reused: false };
    prepared.accepts(result, { ...result, reused: true });
    prepared.rejects({ ...result, reused: "true" }, { ...result, preparationKey: "" });
  });

  it("rejects missing, empty, and unknown lifecycle request fields", () => {
    create.rejects(
      {},
      { profileId: "", idempotencyKey: "request-1" },
      { profileId: "development", idempotencyKey: "" },
      { profileId: "development", idempotencyKey: "request-1", providerId: "ssh" },
    );
    destroy.accepts({ environmentId: "environment-1", force: true });
    destroy.rejects({ environmentId: "" });
  });

  it("keeps the worker lifecycle state closed", () => {
    const states = schemaValidation(WorkerEnvironmentStateSchema);
    states.accepts(...workerStates);
    states.rejects("unknown");
  });

  it("accepts only redacted node worker bundle status", () => {
    const bundle = (workerBundle: unknown) => ({ ...node, workerBundle });
    summary.accepts(
      bundle({ status: "installed", version: "2026.8.9" }),
      bundle({ status: "missing" }),
    );
    summary.rejects(
      bundle({ status: "installed", version: "2026.8.9", bundleHash: "a".repeat(64) }),
      bundle({ status: "installed", version: "" }),
    );
  });

  it("accepts only bounded closed worker slot summaries", () => {
    const available = { total: 2, available: 1 };
    slots.accepts(available, { total: 1, available: 0, reclaimableIdle: 1 });
    slots.rejects(
      { total: 1, available: 1, reclaimableIdle: 1 },
      { total: 4, available: 0, reclaimableIdle: 3 },
      { total: 0, available: 0 },
      { total: 2, available: 3 },
      { total: 2, available: 1_025 },
      { ...available, busy: 1 },
    );
    summary.accepts({ ...node, workerSlots: available });
    summary.rejects({ ...node, workerSlots: { total: 2, available: 3 } });
  });

  it("accepts only bounded, unique effective node command authority", () => {
    summary.accepts({
      ...node,
      invocableCommands: ["codex.exec-server.stdio.v1", "system.run"],
    });
    summary.accepts({ ...node, invocableCommands: [] });

    for (const invocableCommands of [
      [""],
      ["system.run", "system.run"],
      ["x".repeat(129)],
      Array.from({ length: 129 }, (_, index) => `command.${index}`),
    ]) {
      summary.rejects({ ...node, invocableCommands });
    }
  });

  it("keeps runtime-scoped node command state bounded and closed", () => {
    const command = (requiredNodeCommand: unknown) => ({ ...node, requiredNodeCommand });
    for (const state of ["invocable", "pending-approval", "undeclared", "unauthorized"] as const) {
      summary.accepts(command({ command: "runtime.exec", state }));
    }
    const commandState = command({ command: "runtime.exec", state: "invocable" });
    summary.accepts(
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
      schemaValidation(schema).rejects(commandState);
    }
    for (const requiredNodeCommand of [
      { command: "", state: "undeclared" },
      { command: "x".repeat(129), state: "undeclared" },
      { command: "runtime.exec", state: "unknown" },
      { command: "runtime.exec", state: "undeclared", message: "" },
      { command: "runtime.exec", state: "invocable", pending: true },
    ]) {
      summary.rejects(command(requiredNodeCommand));
    }

    listing.accepts(
      {},
      { runtimeId: "codex" },
      { projection: "profiles" },
      { runtimeId: "codex", projection: "profiles" },
    );
    listing.rejects(
      { projection: "unknown" },
      { runtimeId: "" },
      { runtimeId: "x".repeat(129) },
      { runtimeId: "codex", command: "runtime.exec" },
    );
  });

  it("keeps desktop app launch requests, results, and projected ids closed", () => {
    const request = { environmentId: "worker:one", app: "browser" };
    launch.accepts(request);
    launched.accepts({ app: "terminal", status: "ready" });
    launch.rejects({ ...request, app: "editor" }, { ...request, args: ["--incognito"] });
    launched.rejects({ app: "browser", status: "starting" });
    summary.rejects({
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
    listed.accepts(
      profileResult(
        {
          ...profile,
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
      ),
    );
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
      listed.rejects(profileResult({ ...profile, ...invalid }));
    }
  });
});
