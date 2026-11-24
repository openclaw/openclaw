import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterEach, expect, it, vi } from "vitest";
import * as config from "../../../config/config.js";
import { upsertSessionEntryCore } from "../../../config/sessions/session-accessor.js";
import { callGateway } from "../../../gateway/call.js";
import { WRITE_SCOPE } from "../../../gateway/method-scopes.js";
import { bindGatewayLifecycleRequest } from "../../../gateway/server-lifecycle-runtime-context.js";
import type { GatewayRequestHandlerOptions } from "../../../gateway/server-methods/types.js";
import { dispatchGatewayMethodInProcessRaw } from "../../../gateway/server-plugin-in-process-dispatch.js";
import { createContext } from "../../../gateway/server-plugin-in-process-dispatch.test-support.js";
import { onAgentEvent } from "../../../infra/agent-events.js";
import { publishSystemEventStoreResolver } from "../../../infra/system-event-ownership.js";
import { withPluginRuntimeGatewayRequestScope } from "../../../plugins/runtime/gateway-request-scope.js";
import { withOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import * as delivery from "../announce/subagent-announce-delivery.js";
import { maybeWakeRequesterAfterAllChildrenSettled } from "../announce/subagent-announce.requester-settle-wake.js";
import { requesterWakeDriver } from "../completion/subagent-completion-admission.test-helpers.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import { mutateSubagentRuns } from "./subagent-registry-persistence.js";
import { loadSubagentRegistryFromSqlite } from "./subagent-registry-state.fixture.test-support.js";
import { retainedOperatorFixture } from "./subagent-registry.completed-followup-authority.test-support.js";
import { registerSubagentRun } from "./subagent-registry.js";
import { resetSubagentRegistryForTests } from "./subagent-registry.test-helpers.js";

vi.mock("../../../config/config.js", { spy: true });
vi.mock("../../../gateway/call.js", { spy: true });
vi.mock("../../../gateway/server-lifecycle-runtime-context.js", { spy: true });
vi.mock("../../../infra/agent-events.js", { spy: true });
vi.mock("../announce/subagent-announce-delivery.js", { spy: true });

afterEach(async () => {
  await resetSubagentRegistryForTests({ persist: false });
  publishSystemEventStoreResolver(undefined);
  vi.restoreAllMocks();
});

it("delivers a finished child to the live requester when the recorded store path differs", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    let cfg = { session: { store: state.path("sessions.json") } };
    config.setRuntimeConfigSnapshot(cfg);
    vi.mocked(config.getRuntimeConfig).mockReturnValue(cfg);
    publishSystemEventStoreResolver(() => cfg.session.store);
    vi.mocked(callGateway).mockResolvedValue({ status: "pending" });
    vi.mocked(bindGatewayLifecycleRequest).mockReturnValue(callGateway);
    vi.mocked(onAgentEvent).mockReturnValue(() => {});
    const requesterSessionKey = "agent:main:main";
    await upsertSessionEntryCore(
      { storePath: cfg.session.store, sessionKey: requesterSessionKey, agentId: "main" },
      { sessionId: "live-requester", updatedAt: 1 },
    );
    const turns: string[] = [];
    const handler = ({ params, respond }: GatewayRequestHandlerOptions) => {
      expect(params.sessionKey).toBe(requesterSessionKey);
      turns.push(String(params.message));
      respond(true, { status: "ok" });
    };
    const context = createContext([["agent", WRITE_SCOPE, "agent", handler]], () => cfg);
    const resolveGatewayContext = () => context;
    context.resolveGatewayContext = resolveGatewayContext;
    const source = await retainedOperatorFixture("operator", context, resolveGatewayContext);
    const runId = "finished-child";
    using driver = requesterWakeDriver([]);
    try {
      await withPluginRuntimeGatewayRequestScope({ ...source, isWebchatConnect: () => false }, () =>
        registerSubagentRun({
          runId,
          childSessionKey: `agent:main:subagent:${runId}`,
          childAgentId: "main",
          sessionEntry: { sessionId: `session-${runId}` },
          requesterAgentId: "main",
          requesterSessionKey,
          requesterDisplayKey: "main",
          task: "produce child result",
          cleanup: "keep",
          expectsCompletionMessage: true,
          gatewayContextResolver: resolveGatewayContext,
        }),
      );
      source.source.release();
      await mutateSubagentRuns([runId], (rows) => {
        const draft = structuredClone(expectDefined(rows.get(runId), "registered child"));
        const text = `Finished result from ${runId}`;
        draft.execution = { status: "terminal", endedAt: Date.now(), outcome: { status: "ok" } };
        draft.completion = {
          required: true,
          resultText: text,
          terminalReply: { disposition: "visible", text },
        };
        draft.delivery = { status: "pending" };
        draft.cleanupHandled = true;
        draft.cleanupCompletedAt = Date.now();
        draft.requesterSettleWake = {
          status: "pending",
          attemptCount: 0,
          rearmGeneration: 1,
          batchRunIds: [runId],
        };
        return { value: undefined, postimages: new Map([[runId, draft]]) };
      });
      const recordedStorePath = subagentRuns.get(runId)?.requesterStorePath;
      cfg = { session: { store: state.path("moved-sessions.json") } };
      config.setRuntimeConfigSnapshot(cfg);
      vi.mocked(config.getRuntimeConfig).mockReturnValue(cfg);
      await upsertSessionEntryCore(
        { storePath: cfg.session.store, sessionKey: requesterSessionKey, agentId: "main" },
        { sessionId: "live-requester", updatedAt: 2 },
      );
      const requester = await delivery.loadRequesterSessionEntry(requesterSessionKey, "main");
      expect(recordedStorePath).toBeDefined();
      expect(requester.storePath).not.toBe(recordedStorePath);
      expect(requester.entry?.sessionId).toBe("live-requester");
      // Replace only the established announcement boundary; exercise the real
      // in-process dispatcher so the requester route is not fabricated.
      vi.mocked(delivery.deliverSubagentAnnouncement).mockImplementation(async (params) => {
        const result = await dispatchGatewayMethodInProcessRaw(
          "agent",
          {
            message: params.triggerMessage,
            sessionKey: requesterSessionKey,
            idempotencyKey: params.directIdempotencyKey!,
          },
          { resolveGatewayContext },
        );
        expect(result.ok).toBe(true);
        return { delivered: true, path: "direct" };
      });
      driver.wake.mockImplementation(maybeWakeRequesterAfterAllChildrenSettled);
      await withPluginRuntimeGatewayRequestScope(
        { context, resolveGatewayContext, isWebchatConnect: () => false },
        () => driver.run(expectDefined(subagentRuns.get(runId), "finished child")),
      );
      await driver.sweep();
      expect(turns).toHaveLength(1);
      expect(turns[0]).toContain(`Finished result from ${runId}`);
      const stored = loadSubagentRegistryFromSqlite().get(runId);
      expect(stored?.delivery?.status).toBe("delivered");
      expect(stored?.requesterSettleWake).toBeUndefined();
    } finally {
      driver.controller.clearRuntimeState();
      await resetSubagentRegistryForTests({ persist: false });
      source.source.release();
    }
  });
});
