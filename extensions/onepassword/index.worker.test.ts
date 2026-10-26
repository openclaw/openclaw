import assert from "node:assert/strict";
import { DatabaseSync, StatementSync } from "node:sqlite";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import {
  createPluginStateKeyedStoreForTests,
  createPluginStateKeyedStoreV2ForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { closeOpenClawStateDatabaseAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, expect, it, vi } from "vitest";
import plugin from "./index.js";
import type { AuditRow, OnePasswordBroker, PendingAuthorization } from "./src/broker.js";

const getItem = vi.hoisted(() =>
  vi.fn(async () => ({
    value: "synthetic-secret",
    itemTitle: "Fixture",
    fieldLabel: "credential",
  })),
);
vi.mock("./src/op-client.js", () => ({
  OpClient: class {
    getItem = getItem;
  },
}));

const dirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    vi.restoreAllMocks();
    await closeOpenClawStateDatabaseAsync();
    cleanup();
  }),
);

const invocation = { agentId: "agent-a", sessionKey: "session-a", sessionId: "conversation-a" };

it("hands approvals to competing tool executions without main-thread SQL", async () => {
  const env = { OPENCLAW_STATE_DIR: dirs.make("onepassword-pending-worker-") };
  const pluginConfig = {
    vault: "Synthetic vault",
    cacheTtlSeconds: 0,
    items: {
      automatic: { item: "Automatic fixture", field: "credential", policy: "auto" },
      approval: { item: "Approval fixture", field: "credential", policy: "approve" },
    },
  };
  const registerTool = vi.fn<OpenClawPluginApi["registerTool"]>();
  const on = vi.fn<OpenClawPluginApi["on"]>();
  const api = createTestPluginApi({ id: "onepassword", pluginConfig, registerTool, on });
  api.runtime.config = {
    current: () => ({ plugins: { entries: { onepassword: { config: pluginConfig } } } }),
    mutateConfigFile: vi.fn(),
    replaceConfigFile: vi.fn(),
  };
  const unused = () => {
    throw new Error("unused store opener");
  };
  api.runtime.state = {
    resolveStateDir: () => env.OPENCLAW_STATE_DIR,
    openKeyedStoreV2: (options) =>
      createPluginStateKeyedStoreV2ForTests(
        "onepassword",
        { ...options, env },
        { assertCurrent() {} },
      ),
    openKeyedStore: (options) =>
      createPluginStateKeyedStoreForTests("onepassword", { ...options, env }),
    openSyncKeyedStore: unused,
    openBlobStore: unused,
    openChannelIngressQueue: unused,
    openChannelIngressDrain: unused,
  };
  const sql = [
    vi.spyOn(DatabaseSync.prototype, "prepare"),
    vi.spyOn(DatabaseSync.prototype, "exec"),
    ...(["get", "all", "run", "iterate"] as const).map((method) =>
      vi.spyOn(StatementSync.prototype, method),
    ),
  ];
  plugin.register(api);
  const factory = registerTool.mock.calls[0]?.[0];
  assert(typeof factory === "function", "missing tool factory");
  const tool = factory(invocation);
  assert(tool && !Array.isArray(tool), "expected one tool");
  const beforeToolCall = on.mock.calls.find(([name]) => name === "before_tool_call")?.[1] as
    | OnePasswordBroker["beforeToolCall"]
    | undefined;
  assert(beforeToolCall, "missing policy hook");
  for (const [toolCallId, slug, decision, dropNonce] of [
    ["automatic", "automatic", undefined, false],
    ["approved", "approval", "allow-always", false],
    ["standing-grant", "approval", undefined, true],
  ] as const) {
    const params = { action: "get", slug, reason: toolCallId };
    const result = await beforeToolCall(
      { toolName: "onepassword", toolCallId, params },
      { toolName: "onepassword", toolCallId, ...invocation },
    );
    expect(Boolean(result?.requireApproval)).toBe(decision !== undefined);
    const resolution = decision ? result?.requireApproval?.onResolution?.(decision) : undefined;
    const executedParams = dropNonce ? params : { ...params, ...result?.params };
    const executions = await Promise.all([
      tool.execute(toolCallId, executedParams),
      tool.execute(toolCallId, executedParams),
    ]);
    await resolution;
    const details = executions.map((execution) => execution.details);
    expect(details).toContainEqual(expect.objectContaining({ ok: true, slug }));
    expect(details).toContainEqual(
      expect.objectContaining({
        ok: false,
        error: expect.objectContaining({ code: "POLICY_NOT_EVALUATED" }),
      }),
    );
  }
  expect(getItem).toHaveBeenCalledTimes(3);
  const entries = <T>(namespace: string, maxEntries: number) =>
    api.runtime.state
      .openKeyedStore<T>({ namespace, maxEntries, overflowPolicy: "evict-oldest" })
      .entries();
  expect(await entries<PendingAuthorization>("pending", 512)).toEqual([]);
  expect((await entries<AuditRow>("audit", 40_000)).map(({ value }) => value.outcome)).toEqual(
    expect.arrayContaining(["auto", "approved", "grant"]),
  );
  for (const spy of sql) {
    expect(spy).not.toHaveBeenCalled();
  }
});
