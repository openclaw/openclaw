import { describe, expect, it } from "vitest";
import { buildEmbeddedAttemptToolRunContext } from "./attempt-tool-run-context.js";

describe("buildEmbeddedAttemptToolRunContext", () => {
  it("projects originating capabilities without copying execution or session ownership", () => {
    const input = {
      clientCaps: ["inline-widgets"],
      pinnedWidgetAuthoring: true,
      toolBindings: { browser: { kind: "tab", tabId: 7 } },
      memberRoleIds: ["maintainer-role"],
      approvalReviewerDeviceId: "reviewer-device",
      taskSuggestionDeliveryMode: "gateway" as const,
      chatId: "native-conversation",
      sessionKey: "agent:main:dashboard:current",
      sessionId: "source-session",
      runId: "source-run",
      onYield: () => undefined,
    };
    const context = buildEmbeddedAttemptToolRunContext(input);

    expect(context).toMatchObject({
      clientCaps: ["inline-widgets"],
      pinnedWidgetAuthoring: true,
      toolBindings: input.toolBindings,
      memberRoleIds: ["maintainer-role"],
      approvalReviewerDeviceId: "reviewer-device",
      taskSuggestionDeliveryMode: "gateway",
      nativeChannelId: "native-conversation",
    });
    for (const ownedField of ["sessionKey", "sessionId", "runId", "onYield"]) {
      expect(context).not.toHaveProperty(ownedField);
    }
  });

  it("carries runtime toolsAllow into coding tool construction", () => {
    const context = buildEmbeddedAttemptToolRunContext({
      trigger: "manual",
      jobId: "job-1",
      memoryFlushWritePath: "memory/log.md",
      toolsAllow: ["memory_search", "memory_get"],
    });
    expect(context.trigger).toBe("manual");
    expect(context.jobId).toBe("job-1");
    expect(context.memoryFlushWritePath).toBe("memory/log.md");
    expect(context.runtimeToolAllowlist).toEqual(["memory_search", "memory_get"]);
  });

  it("forwards memory trigger metadata into tool creation so append-only guards activate", () => {
    const memoryFlushWritePath = "memory/2026-03-24.md";
    const context = buildEmbeddedAttemptToolRunContext({ trigger: "memory", memoryFlushWritePath });
    expect(context.trigger).toBe("memory");
    expect(context.memoryFlushWritePath).toBe(memoryFlushWritePath);
  });

  it("forwards cron job id into tool creation so self-removal can be scoped", () => {
    const context = buildEmbeddedAttemptToolRunContext({
      trigger: "cron",
      jobId: "job-current",
    });
    expect(context.trigger).toBe("cron");
    expect(context.jobId).toBe("job-current");
  });

  it.each([undefined, false, true])(
    "preserves originating inbound audio %s",
    (currentInboundAudio) => {
      const context = buildEmbeddedAttemptToolRunContext({ currentInboundAudio });
      const withOperation = buildEmbeddedAttemptToolRunContext({
        currentInboundAudio,
        replyOperation: { acceptedSteeredInboundAudio: false },
      });

      expect(context.hasCurrentInboundAudio?.()).toBe(currentInboundAudio === true);
      expect(withOperation.hasCurrentInboundAudio?.()).toBe(currentInboundAudio === true);
    },
  );

  it("reads accepted steering at execution without crossing operation owners", () => {
    let acceptedSteeredInboundAudio = false;
    const attempt = {
      currentInboundAudio: false,
      replyOperation: {
        get acceptedSteeredInboundAudio() {
          return acceptedSteeredInboundAudio;
        },
      },
    };
    const context = buildEmbeddedAttemptToolRunContext(attempt);
    expect(context.hasCurrentInboundAudio?.()).toBe(false);

    attempt.replyOperation = { acceptedSteeredInboundAudio: true };
    expect(context.hasCurrentInboundAudio?.()).toBe(false);

    acceptedSteeredInboundAudio = true;
    expect(context.hasCurrentInboundAudio?.()).toBe(true);
    expect(
      buildEmbeddedAttemptToolRunContext({
        currentInboundAudio: false,
        replyOperation: { acceptedSteeredInboundAudio: false },
      }).hasCurrentInboundAudio?.(),
    ).toBe(false);
  });
});
