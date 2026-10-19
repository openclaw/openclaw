import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, vi } from "vitest";
import { withinTest } from "../../../../test/helpers/promise.js";
import {
  loadTranscriptEvents,
  upsertSessionEntryCore,
} from "../../../config/sessions/session-accessor.js";
import { mirrorDeliveredPayloads } from "../../../infra/outbound/deliver-transcript.js";
import { sendMessage } from "../../../infra/outbound/message.js";
import { runWithGatewayIndependentRootWorkAdmission } from "../../../process/gateway-work-admission.js";
import { withSessionTurn } from "../../../sessions/session-controller.admission.js";
import { runSessionMutation } from "../../../sessions/session-controller.lifecycle.js";
import { AsyncWorkScope } from "../../../shared/async-work-scope.js";
import { createDeferredCore } from "../../../shared/deferred.js";
import { withOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import { SessionManager } from "../../sessions/session-manager.js";
import { makeAgentAssistantMessage } from "../../test-helpers/agent-message-fixtures.js";
import { deliverCompletionDirect } from "./subagent-announce-completion-delivery.js";

vi.mock("../../../infra/outbound/message.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../infra/outbound/message.js")>()),
  sendMessage: vi.fn(),
}));

it("settles a direct child result before its mirror waits behind the requester's controller turn", async ({
  signal,
}) => {
  await withOpenClawTestState({ label: "direct-completion-mirror" }, async (state) => {
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
      const mirror = {
        delivery: {
          cfg: params.cfg ?? cfg,
          channel: params.channel ?? "discord",
          to: params.to,
          payloads: [{ text: params.content }],
          mirror: params.mirror,
        },
        payloads: [payload],
      };
      // Retry bookkeeping with the same identity, without another platform send.
      await mirrorDeliveredPayloads(mirror);
      await mirrorDeliveredPayloads(mirror);
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
      const result = await withinTest(
        deliveryWork.track(() =>
          runWithGatewayIndependentRootWorkAdmission(
            () =>
              deliverCompletionDirect({
                cfg,
                requesterSessionKey: target.sessionKey,
                requesterSessionId: target.sessionId,
                requesterAgentId: target.agentId,
                directIdempotencyKey: "announce:v1:child:run",
                deliveryTarget: { deliver: true, channel: "discord", to: "dm:mirror-fixture" },
                contentKind: "completed_result",
                agentResult: { payloads: [{ text: "Synthetic child result" }] },
                internalEvents: [
                  {
                    type: "task_completion",
                    source: "subagent",
                    childSessionKey: "agent:main:subagent:child",
                    announceType: "subagent task",
                    taskLabel: "synthetic child",
                    status: "ok",
                    statusLabel: "completed",
                    result: "Synthetic child result",
                    replyInstruction: "Summarize the result.",
                  },
                ],
                onDeliveryResult,
              }),
            "direct-child-result",
          ),
        ),
        signal,
      );
      await deliveryWork.drain();
      expect(result).toMatchObject({ delivered: true, path: "direct" });
      expect(onDeliveryResult).toHaveBeenCalledOnce();
      expect(send).toHaveBeenCalledOnce();

      release.resolve();
      await withinTest(turn, signal);
      await withinTest(settleMirrors(), signal);
      const messages = (await loadTranscriptEvents(target)).flatMap((entry) =>
        isRecord(entry) && entry.type === "message" ? [entry.message] : [],
      );
      expect(messages).toMatchObject([
        { role: "user", content: wake.content },
        { role: "assistant", content: [{ type: "text", text: "Synthetic wake reply" }] },
        {
          role: "assistant",
          model: "delivery-mirror",
          openclawDeliveryMirror: { kind: "subagent-completion-direct" },
          content: [{ type: "text", text: "Synthetic child result" }],
        },
      ]);
    } finally {
      release.resolve();
      await Promise.allSettled([turn, settleMirrors()]);
      send.mockReset();
    }
  });
});
