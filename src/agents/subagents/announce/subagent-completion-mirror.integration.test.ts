import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, vi } from "vitest";
import { withinTest } from "../../../../test/helpers/promise.js";
import {
  loadTranscriptEvents,
  upsertSessionEntryCore,
} from "../../../config/sessions/session-accessor.js";
import { sendMessage } from "../../../infra/outbound/message.js";
import { runWithGatewayIndependentRootWorkAdmission } from "../../../process/gateway-work-admission.js";
import { commitConfirmedVisibleMessage } from "../../../sessions/confirmed-visible-message.js";
import { withSessionTurn } from "../../../sessions/session-controller.admission.js";
import { runSessionMutation } from "../../../sessions/session-controller.lifecycle.js";
import { AsyncWorkScope } from "../../../shared/async-work-scope.js";
import { createDeferredCore } from "../../../shared/deferred.js";
import { withOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import { SessionManager } from "../../sessions/session-manager.js";
import { taskCompletionEvents } from "../../subagent-test-fixtures.test-helpers.js";
import { makeAgentAssistantMessage } from "../../test-helpers/agent-message-fixtures.js";
import { deliverCompletionDirect } from "./subagent-announce-completion-delivery.js";

vi.mock("../../../infra/outbound/message.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../infra/outbound/message.js")>()),
  sendMessage: vi.fn(),
}));

it("settles child delivery and records its result during the requester turn", ({ signal }) =>
  withOpenClawTestState({ label: "direct-completion-mirror" }, async (state) => {
    const target = {
      agentId: "main",
      sessionId: "requester",
      sessionKey: "agent:main:discord:direct:mirror-fixture",
      storePath: path.join(state.agentDir("main"), "openclaw-agent.sqlite"),
    };
    const cfg = { session: { store: target.storePath } };
    await upsertSessionEntryCore(target, { sessionId: target.sessionId, updatedAt: 1 });
    const wake = {
      role: "user" as const,
      content: "Synthetic completion wake",
      timestamp: 1,
      idempotencyKey: "announce:requester-settle:fixture:yield-1:user",
    };
    const manager = await SessionManager.openAsync(target, state.workspaceDir);
    const wakeId = await manager.appendMessageAsync(wake);
    const entered = createDeferredCore();
    const release = createDeferredCore();
    const turn = withSessionTurn(target, async () => {
      entered.resolve();
      await release.promise;
      const requester = await SessionManager.openAsync(target, state.workspaceDir);
      expect(await requester.appendMessageAsync(wake)).toBe(wakeId);
      await requester.appendMessageAsync(
        makeAgentAssistantMessage({ content: [{ type: "text", text: "Synthetic wake reply" }] }),
      );
    });
    const settleMirrors = () =>
      runSessionMutation({
        scope: target.storePath,
        identities: [target.sessionKey, target.sessionId],
        agentId: target.agentId,
        policy: "wait",
        run: async () => {},
      });
    // Observe rejection immediately, but preserve it for the owning assertion below.
    void turn.catch(() => {});
    const send = vi.mocked(sendMessage).mockImplementation(async (params) => {
      await params.onPlatformSendDispatch?.();
      params.assertDirectAdapterHandoff?.();
      const payload = { text: params.content, mediaUrls: [] };
      params.onDeliveredPayload?.(payload);
      // Record as outbound delivery does, twice with one identity, without another send.
      const record = () =>
        commitConfirmedVisibleMessage({
          config: params.cfg ?? cfg,
          channel: "discord",
          to: params.to,
          route: {
            sessionKey: target.sessionKey,
            baseSessionKey: target.sessionKey,
            peer: { kind: "direct", id: "mirror-fixture" },
            chatType: "direct",
            from: "discord:mirror-fixture",
            to: params.to,
          },
          producer: params.session,
          payload: { text: params.content },
          deliveryId: params.idempotencyKey ?? "missing-identity",
          payloadIndex: 0,
          expectedGeneration: params.transcriptExpectedGeneration,
          provenance: params.transcriptProvenance,
        });
      expect(await record()).toMatchObject({ ok: true });
      expect(await record()).toMatchObject({ ok: true });
      return {
        channel: "discord",
        to: params.to,
        via: "direct",
        mediaUrl: null,
        result: { messageId: "synthetic-child-result" },
      };
    });
    try {
      await withinTest(entered.promise, signal);
      const onDeliveryResult = vi.fn();
      const deliveryWork = new AsyncWorkScope();
      const deliver = () =>
        deliverCompletionDirect({
          cfg,
          requesterSessionKey: target.sessionKey,
          requesterSessionId: target.sessionId,
          requesterAgentId: target.agentId,
          directIdempotencyKey: "announce:v1:child:run",
          deliveryTarget: { deliver: true, channel: "discord", to: "dm:mirror-fixture" },
          contentKind: "completed_result",
          internalEvents: taskCompletionEvents({ result: "Synthetic child result" }),
          onDeliveryResult,
        });
      const result = await withinTest(
        deliveryWork.track(() =>
          runWithGatewayIndependentRootWorkAdmission(deliver, "direct-child-result"),
        ),
        signal,
      );
      await deliveryWork.drain();
      expect(result).toMatchObject({ delivered: true, path: "direct" });
      expect(onDeliveryResult).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ delivered: true, deliveredAt: expect.any(Number) }),
      );
      expect(send).toHaveBeenCalledOnce();

      release.resolve();
      await withinTest(turn, signal);
      await withinTest(settleMirrors(), signal);
      const messages = (await loadTranscriptEvents(target)).flatMap((entry) =>
        isRecord(entry) && entry.type === "message" ? [entry.message] : [],
      );
      // The result is recorded once during the turn and does not consume its wake input.
      expect(messages).toHaveLength(3);
      expect(
        messages.filter((message) => isRecord(message) && message.role === "user"),
      ).toMatchObject([{ content: wake.content }]);
      expect(messages).toContainEqual(
        expect.objectContaining({
          role: "assistant",
          model: "automation-result",
          openclawAutomation: { kind: "subagent-completion" },
          content: [{ type: "text", text: "Synthetic child result" }],
        }),
      );
      expect(messages.at(-1)).toMatchObject({
        role: "assistant",
        content: [{ type: "text", text: "Synthetic wake reply" }],
      });
    } finally {
      release.resolve();
      await Promise.allSettled([turn, settleMirrors()]);
      send.mockReset();
    }
  }));
