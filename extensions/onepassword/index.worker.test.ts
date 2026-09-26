import { DatabaseSync, StatementSync } from "node:sqlite";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import {
  createPluginStateKeyedStoreForTests,
  createPluginStateSyncKeyedStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { closeOpenClawStateDatabaseAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import type {
  PluginHookBeforeToolCallEvent,
  PluginHookBeforeToolCallResult,
  PluginHookToolContext,
} from "openclaw/plugin-sdk/types";
import { afterEach, describe, expect, it, vi } from "vitest";
import plugin from "./index.js";
import type { AuditRow, PendingAuthorization } from "./src/broker.js";

const { getItem } = vi.hoisted(() => ({
  getItem: vi.fn(async () => ({
    value: "synthetic-secret",
    itemTitle: "Fixture",
    fieldLabel: "credential",
  })),
}));
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

describe("OnePassword pending authorizations on the SQLite worker", () => {
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
    const unused = () => {
      throw new Error("unused store opener");
    };
    api.runtime.state = {
      resolveStateDir: () => env.OPENCLAW_STATE_DIR,
      openKeyedStore: (options) =>
        createPluginStateKeyedStoreForTests("onepassword", { ...options, env }),
      openSyncKeyedStore: (options) =>
        createPluginStateSyncKeyedStoreForTests("onepassword", { ...options, env }),
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
    if (typeof factory !== "function") {
      throw new Error("missing tool factory");
    }
    const tool = factory(invocation);
    if (!tool || Array.isArray(tool)) {
      throw new Error("expected one tool");
    }
    const beforeToolCall = on.mock.calls.find(([name]) => name === "before_tool_call")?.[1] as
      | ((
          event: PluginHookBeforeToolCallEvent,
          context: PluginHookToolContext,
        ) => Promise<PluginHookBeforeToolCallResult | void>)
      | undefined;
    if (!beforeToolCall) {
      throw new Error("missing policy hook");
    }
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
      expect(executions.map((execution) => execution.details)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ ok: true, slug }),
          expect.objectContaining({
            ok: false,
            error: expect.objectContaining({ code: "POLICY_NOT_EVALUATED" }),
          }),
        ]),
      );
    }
    expect(getItem).toHaveBeenCalledTimes(3);
    expect(
      await api.runtime.state
        .openKeyedStore<PendingAuthorization>({
          namespace: "pending",
          maxEntries: 512,
          overflowPolicy: "evict-oldest",
        })
        .entries(),
    ).toEqual([]);
    expect(
      (
        await api.runtime.state
          .openKeyedStore<AuditRow>({
            namespace: "audit",
            maxEntries: 40_000,
            overflowPolicy: "evict-oldest",
          })
          .entries()
      ).map(({ value }) => value.outcome),
    ).toEqual(expect.arrayContaining(["auto", "approved", "grant"]));
    for (const call of sql) {
      expect(call).not.toHaveBeenCalled();
    }
  });
});
