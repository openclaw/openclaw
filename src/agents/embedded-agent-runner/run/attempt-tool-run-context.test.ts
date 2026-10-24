import { expect, it } from "vitest";
import { withSessionControllerOwner } from "../../../sessions/session-controller.context.js";
import { createReplyOperation } from "../../../sessions/session-controller.js";
import { runWithSessionControllerCleanup } from "../../../sessions/session-controller.owner-context.js";
import { buildEmbeddedAttemptToolRunContext } from "./attempt-tool-run-context.js";

it("projects originating capabilities without copying execution or session ownership", () => {
  const capabilities = {
    clientCaps: ["inline-widgets"],
    gatewayUiCommandTarget: { connId: "requester-tab", profileId: "requester" },
    pinnedWidgetAuthoring: true,
    toolBindings: { browser: { kind: "tab", tabId: 7 } },
    memberRoleIds: ["maintainer-role"],
    approvalReviewerDeviceId: "reviewer-device",
    taskSuggestionDeliveryMode: "gateway" as const,
  };
  const input = {
    ...structuredClone(capabilities),
    chatId: "native-conversation",
    sessionKey: "agent:main:dashboard:current",
    sessionId: "source-session",
    runId: "source-run",
    onYield: () => undefined,
    provider: "custom",
    modelId: "alias",
    model: { provider: "custom", id: "resolved-model", headers: { "x-private": "fixture" } },
  };
  const context = buildEmbeddedAttemptToolRunContext(input);
  input.model.id = "next-model";

  expect(context).toMatchObject({
    ...capabilities,
    nativeChannelId: "native-conversation",
  });
  for (const ownedField of ["sessionKey", "sessionId", "runId", "onYield", "model"]) {
    expect(context).not.toHaveProperty(ownedField);
  }
  expect(context.requesterModel).toEqual({ provider: "custom", model: "resolved-model" });
});

it("carries runtime toolsAllow into coding tool construction", () => {
  const facts = {
    trigger: "manual" as const,
    jobId: "job-1",
    memoryFlushWritePath: "memory/log.md",
  };
  const toolsAllow = ["memory_search", "memory_get"];
  expect(
    buildEmbeddedAttemptToolRunContext({ ...facts, toolsAllow: [...toolsAllow] }),
  ).toMatchObject({
    ...facts,
    runtimeToolAllowlist: toolsAllow,
  });
});

it("reads accepted steering at execution without crossing operation owners", () => {
  const replyOperation = { acceptedSteeredInboundAudio: false };
  const attempt = { currentInboundAudio: false, replyOperation };
  const context = buildEmbeddedAttemptToolRunContext(attempt);
  expect(context.hasCurrentInboundAudio?.()).toBe(false);

  attempt.replyOperation = { acceptedSteeredInboundAudio: true };
  expect(context.hasCurrentInboundAudio?.()).toBe(false);

  replyOperation.acceptedSteeredInboundAudio = true;
  expect(context.hasCurrentInboundAudio?.()).toBe(true);
  const next = buildEmbeddedAttemptToolRunContext({
    currentInboundAudio: false,
    replyOperation: { acceptedSteeredInboundAudio: false },
  });
  expect(next.hasCurrentInboundAudio()).toBe(false);
});

it("captures host-owned audio for the matching turn without lending it to detached work", () => {
  const identity = { sessionId: "audio-context", sessionKey: "agent:main:audio-context" };
  const operation = createReplyOperation({ ...identity, resetTriggered: false });
  try {
    withSessionControllerOwner(operation, () => {
      const context = buildEmbeddedAttemptToolRunContext(identity);
      const foreign = buildEmbeddedAttemptToolRunContext({ ...identity, sessionId: "other" });
      const detached = runWithSessionControllerCleanup(() =>
        buildEmbeddedAttemptToolRunContext(identity),
      );
      expect(context.hasCurrentInboundAudio()).toBe(false);
      operation.markSteeredInputAccepted({ inboundAudio: true });
      const audio = [context, foreign, detached].map((value) => value.hasCurrentInboundAudio());
      expect(audio).toEqual([true, false, false]);
    });
  } finally {
    operation.complete();
  }
});
