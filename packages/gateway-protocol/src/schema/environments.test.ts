import { Value } from "typebox/value";
import { expect, it } from "vitest";
import {
  EnvironmentsCreateResultSchema,
  EnvironmentsDestroyResultSchema,
  EnvironmentsListResultSchema,
  EnvironmentsStatusResultSchema,
  EnvironmentSummarySchema,
  validateEnvironmentsListParams,
  validateEnvironmentsPrepareParams,
  validateWorkerDesktopLaunchParams,
  validateWorkerDesktopLaunchResult,
} from "../index.js";
import { WorkerSlotSummarySchema } from "./environments.js";

const node = { id: "node:build-mac", type: "node", status: "available" };
const summaryAccepts = (fields: object) =>
  Value.Check(EnvironmentSummarySchema, { ...node, ...fields });
const profileAccepts = (fields: object) =>
  Value.Check(EnvironmentsListResultSchema, {
    environments: [],
    profiles: [{ id: "aws", providerId: "crabbox", ...fields }],
  });

it("accepts opt-in desktop setup discovery with a closed credential-free result", () => {
  for (const includeDesktopSetup of [true, false, "true"]) {
    expect(validateEnvironmentsListParams({ includeDesktopSetup })).toBe(
      typeof includeDesktopSetup === "boolean",
    );
  }
  for (const state of ["ready", "needs-server", "unsupported", "managed"]) {
    expect(
      Value.Check(EnvironmentsListResultSchema, {
        environments: [{ ...node, desktopSetup: { state } }],
      }),
    ).toBe(true);
  }
  expect(
    summaryAccepts({
      desktopSetup: { state: "unsupported", detail: "VNC authentication is required" },
    }),
  ).toBe(true);
  for (const desktopSetup of [
    {},
    { state: "unknown" },
    { state: "ready", password: "hidden" },
    { state: "unsupported", detail: "" },
  ]) {
    expect(summaryAccepts({ desktopSetup })).toBe(false);
  }
});

it("preserves desktop availability across list and status projections", () => {
  for (const state of ["locked", "unlocked", "unknown"]) {
    const summary = { ...node, desktopAvailability: { state } };
    expect(Value.Check(EnvironmentsListResultSchema, { environments: [summary] })).toBe(true);
    expect(Value.Check(EnvironmentsStatusResultSchema, summary)).toBe(true);
  }
  for (const desktopAvailability of [null, {}, { state: "idle" }, { state: "locked", idle: 1 }]) {
    expect(summaryAccepts({ desktopAvailability })).toBe(false);
  }
});

it("publishes profile execution modes without provider settings", () => {
  for (const fields of [
    {},
    { executionMode: "worker-turn" },
    { executionModes: ["remote-exec"] },
    { executionModes: ["worker-turn", "remote-exec"] },
  ]) {
    expect(profileAccepts(fields)).toBe(true);
  }
  for (const executionModes of [
    [],
    ["worker-turn", "worker-turn"],
    ["remote-exec", "worker-turn"],
    ["worker-turn", "sandbox"],
    ["worker-turn", "remote-exec", "worker-turn"],
  ]) {
    expect(profileAccepts({ executionModes })).toBe(false);
  }
  expect(profileAccepts({ settings: { token: "hidden" } })).toBe(false);
  expect(
    profileAccepts({ operatingSystems: [{ id: "linux", label: "Linux", settings: {} }] }),
  ).toBe(false);
});

it("keeps preparation authorization and private project paths out of the public projection", () => {
  const request = { profileId: "development", projectPath: "/projects/app" };
  expect(validateEnvironmentsPrepareParams(request)).toBe(true);
  expect(validateEnvironmentsPrepareParams({ ...request, setupAuthorized: false })).toBe(false);
  const preparation = { purpose: "build", key: "project-key" };
  const details = { demandAtMs: 1_000, expiresAtMs: 2_000, consumedAtMs: null };
  expect(summaryAccepts({ preparation: { ...preparation, details } })).toBe(true);
  for (const invalid of [
    { ...preparation, projectPath: "/projects/app" },
    { ...preparation, details: { ...details, projectPath: "/projects/app" } },
    {
      ...preparation,
      details: { ...details, project: { baseCommit: "a".repeat(40), root: "/projects/app" } },
    },
  ]) {
    expect(summaryAccepts({ preparation: invalid })).toBe(false);
  }
});

it("publishes redacted worker bundle status", () => {
  for (const workerBundle of [
    { status: "installed", version: "2026.8.9" },
    { status: "missing" },
  ]) {
    expect(summaryAccepts({ workerBundle })).toBe(true);
  }
  expect(
    summaryAccepts({
      workerBundle: { status: "installed", version: "2026.8.9", bundleHash: "a".repeat(64) },
    }),
  ).toBe(false);
});

it("counts available and reclaimable worker slots against the same total", () => {
  for (const [slots, valid] of [
    [{ total: 2, available: 1 }, true],
    [{ total: 1, available: 0, reclaimableIdle: 1 }, true],
    [{ total: 1, available: 1, reclaimableIdle: 1 }, false],
    [{ total: 4, available: 0, reclaimableIdle: 3 }, false],
    [{ total: 0, available: 0 }, false],
    [{ total: 2, available: 3 }, false],
    [{ total: 2, available: 1_025 }, false],
    [{ total: 2, available: 1, busy: 1 }, false],
  ] as const) {
    expect(Value.Check(WorkerSlotSummarySchema, slots)).toBe(valid);
    expect(summaryAccepts({ workerSlots: slots })).toBe(valid);
  }
});

it("accepts only bounded, unique effective node command authority", () => {
  for (const invocableCommands of [["codex.exec-server.stdio.v1", "system.run"], []]) {
    expect(summaryAccepts({ invocableCommands })).toBe(true);
  }
  for (const invocableCommands of [
    [""],
    ["system.run", "system.run"],
    ["x".repeat(129)],
    Array.from({ length: 129 }, (_, i) => `command.${i}`),
  ]) {
    expect(summaryAccepts({ invocableCommands })).toBe(false);
  }
});

it("keeps runtime command remediation scoped to list projections", () => {
  for (const state of ["invocable", "pending-approval", "undeclared", "unauthorized"]) {
    expect(summaryAccepts({ requiredNodeCommand: { command: "runtime.exec", state } })).toBe(true);
  }
  expect(
    summaryAccepts({
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
    expect(
      Value.Check(schema, {
        ...node,
        requiredNodeCommand: { command: "runtime.exec", state: "invocable" },
      }),
    ).toBe(false);
  }
  for (const requiredNodeCommand of [
    { command: "", state: "undeclared" },
    { command: "x".repeat(129), state: "undeclared" },
    { command: "runtime.exec", state: "unknown" },
    { command: "runtime.exec", state: "undeclared", message: "" },
    { command: "runtime.exec", state: "invocable", pending: true },
  ]) {
    expect(summaryAccepts({ requiredNodeCommand })).toBe(false);
  }
  for (const [params, valid] of [
    [{}, true],
    [{ runtimeId: "codex" }, true],
    [{ projection: "profiles" }, true],
    [{ runtimeId: "codex", projection: "profiles" }, true],
    [{ projection: "unknown" }, false],
    [{ runtimeId: "" }, false],
    [{ runtimeId: "x".repeat(129) }, false],
    [{ runtimeId: "codex", command: "runtime.exec" }, false],
  ] as const) {
    expect(validateEnvironmentsListParams(params)).toBe(valid);
  }
});

it("keeps desktop launches closed to arbitrary apps and arguments", () => {
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
});

it("accepts bounded disabled-host diagnostics without arbitrary fields", () => {
  for (const message of [
    "state directory /srv/node is group-writable; run chmod go-w /srv/node",
    "x".repeat(1_024),
  ]) {
    const summary = {
      ...node,
      status: "unavailable",
      issues: [{ code: "worker-host-unavailable", message }],
    };
    expect(Value.Check(EnvironmentsListResultSchema, { environments: [summary] })).toBe(true);
    expect(Value.Check(EnvironmentsStatusResultSchema, summary)).toBe(true);
  }
  for (const issue of [
    { code: "worker-host-unavailable" },
    { code: "worker-host-unavailable", message: "" },
    { code: "worker-host-unavailable", message: "x".repeat(1_025) },
    { code: "worker-host-unavailable", message: "unavailable", action: "repair" },
  ]) {
    expect(summaryAccepts({ issues: [issue] })).toBe(false);
  }
});
