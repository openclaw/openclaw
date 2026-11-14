import { expect, it, onTestFinished, vi } from "vitest";
import { captureSessionTarget } from "../../../sessions/session-controller.target.js";
import { deliverSubagentAnnouncement, testing } from "./subagent-announce-delivery.test-support.js";

it.each([
  { name: "consumed native input", native: true, visible: false, delivered: true },
  { name: "other completion family", native: false, visible: false, delivered: false },
  { name: "required visible reply", native: true, visible: true, delivered: false },
  { name: "aborted native input", native: true, visible: false, aborted: true, delivered: false },
  { name: "failed native input", native: true, visible: false, error: true, delivered: false },
])("acknowledges only successful optional native yielded input: $name", async (testCase) => {
  const sessionKey = "agent:main:discord:dm:recipient";
  const origin = { channel: "discord", to: "dm:recipient", accountId: "account" };
  const response = {
    status: "ok",
    result: {
      payloads: [],
      meta: {
        yielded: true,
        ...(testCase.aborted ? { aborted: true } : {}),
        ...(testCase.error ? { error: { kind: "incomplete_turn" } } : {}),
      },
    },
  };
  const dispatch = vi.fn<
    typeof import("./subagent-announce.runtime.js").dispatchGatewayMethodInProcess
  >(async <T>() => response as T);
  onTestFinished(() => testing.setDepsForTest());
  testing.setDepsForTest({
    dispatchGatewayMethodInProcess: dispatch,
    getRequesterSessionActivity: () => ({
      sessionId: "parent-session",
      isActive: false,
      target: captureSessionTarget({
        storeScope: "/synthetic/native-yield/sessions.json",
        sessionKey,
        incarnation: "parent-session",
      }),
    }),
    getRuntimeConfig: () => ({}),
    loadRequesterSessionEntry: (key) => ({
      cfg: {},
      canonicalKey: key,
      entry: { sessionId: "parent-session", updatedAt: 1 },
    }),
  });
  const result = await deliverSubagentAnnouncement({
    requesterSessionKey: sessionKey,
    targetRequesterSessionKey: sessionKey,
    triggerMessage: "Child result",
    requesterSessionOrigin: origin,
    directOrigin: origin,
    sourceTool: testCase.native ? "agent_harness_completion" : "subagent_announce",
    requesterIsSubagent: false,
    expectsCompletionMessage: true,
    ...(testCase.visible ? { requireVisibleReply: true } : {}),
    directIdempotencyKey: testCase.native
      ? "announce:codex-native:parent:child:succeeded"
      : "announce:other",
  });
  expect(result.delivered).toBe(testCase.delivered);
  expect(dispatch).toHaveBeenCalledOnce();
});
