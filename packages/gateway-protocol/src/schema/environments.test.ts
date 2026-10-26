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
const nodeWith = (field: string) => (value: unknown) => ({ ...node, [field]: value });
const machine = { id: "standard", label: "Standard" };
const command = (state = "invocable", fields: object = {}) => ({
  command: "runtime.exec",
  state,
  ...fields,
});

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
    const desktop = nodeWith("desktopSetup");
    listed.accepts({ environments: [desktop({ state: "ready" })] });
    summary.accepts(desktop({ state: "unsupported", detail: "VNC authentication is required" }));
    summary.rejects(
      ...[
        {},
        { state: "unknown" },
        { state: "ready", password: "hidden" },
        { state: "unsupported", detail: "" },
      ].map(desktop),
    );
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
    states.accepts("ready");
    states.rejects("unknown");
  });

  it("accepts only redacted node worker bundle status", () => {
    const bundle = nodeWith("workerBundle");
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
    const commands = nodeWith("invocableCommands");
    summary.accepts(commands(["codex.exec-server.stdio.v1", "system.run"]), commands([]));
    summary.rejects(
      ...[
        [""],
        ["system.run", "system.run"],
        ["x".repeat(129)],
        Array.from({ length: 129 }, (_, index) => `command.${index}`),
      ].map(commands),
    );
  });

  it("keeps runtime-scoped node command state bounded and closed", () => {
    const required = nodeWith("requiredNodeCommand");
    for (const state of ["invocable", "pending-approval", "undeclared", "unauthorized"] as const) {
      summary.accepts(required(command(state)));
    }
    summary.accepts(required(command("undeclared", { message: "Enable the runtime plugin." })));
    for (const schema of [
      EnvironmentsCreateResultSchema,
      EnvironmentsDestroyResultSchema,
      EnvironmentsStatusResultSchema,
    ]) {
      schemaValidation(schema).rejects(required(command()));
    }
    summary.rejects(
      ...[
        command("undeclared", { command: "" }),
        command("undeclared", { command: "x".repeat(129) }),
        command("unknown"),
        command("undeclared", { message: "" }),
        command("invocable", { pending: true }),
      ].map(required),
    );

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
    summary.rejects(
      nodeWith("worker")({
        providerId: "static-ssh",
        state: "ready",
        ageMs: 250,
        attachedSessionIds: [],
        tunnelStatus: "stopped",
        desktopApps: ["editor"],
      }),
    );
  });

  it("lists configured worker profiles without provider settings", () => {
    listed.accepts(
      profileResult(
        {
          ...profile,
          trust: "disposable",
          executionMode: "worker-turn",
          executionModes: ["worker-turn", "remote-exec"],
          operatingSystems: [{ id: "linux", label: "Linux", default: true }],
          machines: [{ ...machine, cpu: 32, memoryGb: 64, default: true, os: "linux" }],
        },
        {
          ...profile,
          executionMode: "remote-exec",
          executionModes: ["remote-exec"],
        },
        profile,
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
      { machines: [{ ...machine, cpu: 0 }] },
    ]) {
      listed.rejects(profileResult({ ...profile, ...invalid }));
    }
  });
});
