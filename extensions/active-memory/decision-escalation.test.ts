import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { DecisionOutcome } from "openclaw/plugin-sdk/decisions";
import { describe, expect, it, vi } from "vitest";
import {
  ACTIVE_MEMORY_ESCALATION_DECISION_PURPOSE,
  ACTIVE_MEMORY_ESCALATION_RUBRIC_VERSION,
  buildActiveMemoryEscalationDecisionBatch,
  createActiveMemoryDecisionEscalationDecider,
  createActiveMemoryTurnEscalationDecider,
  isActiveMemoryDecisionEscalationEligible,
  mapActiveMemoryEscalationDecisionOutcome,
  readActiveMemoryDecisionConsent,
} from "./decision-escalation.js";

function booleanOutcome(probabilityTrue: number): DecisionOutcome {
  return {
    status: "ok",
    result: {
      model: "test/decider",
      answers: { deepRecall: { type: "boolean", probabilityTrue } },
    },
    provenance: {
      providerId: "test",
      rubricVersion: ACTIVE_MEMORY_ESCALATION_RUBRIC_VERSION,
      runtimeGeneration: "generation-1",
    },
  };
}

describe("active-memory decision escalation", () => {
  it("asks one boolean deep-recall question over the bounded message and search query", () => {
    expect(
      buildActiveMemoryEscalationDecisionBatch({
        message: "What did we decide last time?",
        searchQuery: "earlier turn\nWhat did we decide last time?",
      }),
    ).toEqual({
      state: {
        latestUserMessage: "What did we decide last time?",
        searchQuery: "earlier turn\nWhat did we decide last time?",
      },
      questions: {
        deepRecall: {
          type: "boolean",
          instructions: expect.any(String),
          criteria: { true: expect.any(String), false: expect.any(String) },
        },
      },
    });
  });

  it.each([
    [1, "recall"],
    [0.5, "recall"],
    [0.49, "skip"],
    [0, "skip"],
  ] as const)("maps probabilityTrue=%s to %s", (probabilityTrue, expected) => {
    expect(mapActiveMemoryEscalationDecisionOutcome(booleanOutcome(probabilityTrue))).toEqual({
      result: expected,
    });
  });

  it.each([
    ["an out-of-range probability", booleanOutcome(1.5)],
    ["a non-finite probability", booleanOutcome(Number.NaN)],
    [
      "a missing answer",
      { ...booleanOutcome(1), result: { model: "test/decider", answers: {} } } as DecisionOutcome,
    ],
    [
      "a non-boolean answer",
      {
        ...booleanOutcome(1),
        result: {
          model: "test/decider",
          answers: { deepRecall: { type: "score", score: 1, probabilities: [0, 1] } },
        },
      } as DecisionOutcome,
    ],
  ])("abstains on %s", (_label, outcome) => {
    expect(mapActiveMemoryEscalationDecisionOutcome(outcome)).toEqual({
      result: "abstain",
      reason: "invalid-answer",
    });
  });

  it.each(["disabled", "not-configured", "deadline", "rate-limited", "transport"] as const)(
    "abstains with the runtime's %s reason",
    (reason) => {
      expect(mapActiveMemoryEscalationDecisionOutcome({ status: "unavailable", reason })).toEqual({
        result: "abstain",
        reason,
      });
    },
  );

  it("evaluates through the owning agent with the Active Memory purpose, rubric, and budget", async () => {
    const evaluate = vi.fn(async () => booleanOutcome(0.9));
    const caller = new AbortController();
    const signal = caller.signal;
    const decider = createActiveMemoryDecisionEscalationDecider({
      decisions: { evaluate },
      agentId: "main",
      isStillAllowed: () => true,
    });

    await expect(
      decider.decide({
        message: "Explain the current configuration",
        searchQuery: "Explain the current configuration",
        signal,
        timeoutMs: 750,
      }),
    ).resolves.toBe("recall");
    expect(evaluate).toHaveBeenCalledWith(
      buildActiveMemoryEscalationDecisionBatch({
        message: "Explain the current configuration",
        searchQuery: "Explain the current configuration",
      }),
      {
        agentId: "main",
        purpose: ACTIVE_MEMORY_ESCALATION_DECISION_PURPOSE,
        rubricVersion: ACTIVE_MEMORY_ESCALATION_RUBRIC_VERSION,
        timeoutMs: 750,
        signal,
        admit: expect.any(Function),
      },
    );
    // The host receives the original cancellation signal and live admission callback.
    const passed = (evaluate.mock.calls[0] as unknown[] | undefined)?.[1] as {
      signal: AbortSignal;
    };
    expect(passed.signal.aborted).toBe(false);
    caller.abort();
    expect(passed.signal.aborted).toBe(true);
  });

  it("reports why an unavailable decision abstains", async () => {
    const onAbstain = vi.fn();
    const decider = createActiveMemoryDecisionEscalationDecider({
      decisions: { evaluate: async () => ({ status: "unavailable", reason: "disabled" }) },
      agentId: "main",
      isStillAllowed: () => true,
      onAbstain,
    });

    await expect(
      decider.decide({
        message: "What did we decide last time?",
        searchQuery: "What did we decide last time?",
        signal: new AbortController().signal,
        timeoutMs: 100,
      }),
    ).resolves.toBe("abstain");
    expect(onAbstain).toHaveBeenCalledWith("disabled");
  });

  it("does not evaluate when consent was revoked after the hook started", async () => {
    const evaluate = vi.fn(async () => booleanOutcome(1));
    const onAbstain = vi.fn();
    const decider = createActiveMemoryDecisionEscalationDecider({
      decisions: { evaluate },
      agentId: "main",
      isStillAllowed: () => false,
      onAbstain,
    });

    await expect(
      decider.decide({
        message: "What did we decide last time?",
        searchQuery: "What did we decide last time?",
        signal: new AbortController().signal,
        timeoutMs: 100,
      }),
    ).resolves.toBe("abstain");
    expect(evaluate).not.toHaveBeenCalled();
    expect(onAbstain).toHaveBeenCalledWith("revoked");
  });

  describe("live consent fence", () => {
    it("delegates live dispatch admission to the host without a timer", async () => {
      let allowed = true;
      const onAbstain = vi.fn();
      const evaluate = vi.fn(async (_batch: unknown, options: { admit?: () => boolean }) => {
        expect(options.admit?.()).toBe(true);
        allowed = false;
        expect(options.admit?.()).toBe(false);
        return { status: "unavailable", reason: "disabled" } as const;
      });
      const decider = createActiveMemoryDecisionEscalationDecider({
        decisions: { evaluate },
        agentId: "main",
        isStillAllowed: () => allowed,
        onAbstain,
      });
      expect(
        await decider.decide({
          message: "What did we decide last time?",
          searchQuery: "earlier decision",
          signal: new AbortController().signal,
          timeoutMs: 1000,
        }),
      ).toBe("abstain");
      expect(onAbstain).toHaveBeenCalledWith("revoked");
    });

    it("ignores a late answer when consent is withdrawn during inference", async () => {
      let allowed = true;
      const decider = createActiveMemoryDecisionEscalationDecider({
        decisions: {
          evaluate: async () => {
            allowed = false;
            return booleanOutcome(0.1);
          },
        },
        agentId: "main",
        isStillAllowed: () => allowed,
      });
      expect(
        await decider.decide({
          message: "What did we decide last time?",
          searchQuery: "earlier decision",
          signal: new AbortController().signal,
          timeoutMs: 1000,
        }),
      ).toBe("abstain");
    });
  });

  describe("live consent", () => {
    const configWith = (options: {
      decisionAssistance?: boolean;
      escalationDecision?: boolean;
      mode?: string;
      enabled?: boolean;
    }) =>
      ({
        agents: { defaults: { experimental: { decisionAssistance: options.decisionAssistance } } },
        plugins: {
          entries: {
            "active-memory": {
              enabled: options.enabled ?? true,
              config: {
                mode: options.mode ?? "escalate",
                escalationDecision: options.escalationDecision,
              },
            },
          },
        },
      }) as OpenClawConfig;

    it.each([
      ["both opt-ins", { decisionAssistance: true, escalationDecision: true }, true],
      ["no Decision assistance", { decisionAssistance: false, escalationDecision: true }, false],
      ["no escalationDecision", { decisionAssistance: true }, false],
      [
        "always mode",
        { decisionAssistance: true, escalationDecision: true, mode: "always" },
        false,
      ],
      [
        "the plugin disabled",
        { decisionAssistance: true, escalationDecision: true, enabled: false },
        false,
      ],
    ] as const)("reads consent with %s as %s", (_label, options, expected) => {
      expect(readActiveMemoryDecisionConsent(configWith(options))).toBe(expected);
    });

    describe("turn targeting", () => {
      const target = {
        agentId: "main",
        chatType: "group" as const,
        privateDestination: false,
        destination: {
          sessionKey: "agent:main:telegram:group:team",
          messageProvider: "telegram",
          channelId: "team",
        },
      };
      const targeted = (overrides: Record<string, unknown>, config: Record<string, unknown> = {}) =>
        ({
          ...config,
          agents: { defaults: { experimental: { decisionAssistance: true } } },
          plugins: {
            entries: {
              "active-memory": {
                enabled: true,
                config: {
                  mode: "escalate",
                  escalationDecision: true,
                  agents: ["main"],
                  allowedChatTypes: ["group"],
                  ...overrides,
                },
              },
            },
          },
        }) as OpenClawConfig;

      it.each([
        ["still targeted", {}, true],
        ["the agent removed", { agents: ["other"] }, false],
        ["the chat type no longer allowed", { allowedChatTypes: ["direct"] }, false],
        ["the chat id denied", { deniedChatIds: ["team"] }, false],
      ] as const)("reads consent with %s as %s", (_label, overrides, expected) => {
        expect(readActiveMemoryDecisionConsent(targeted(overrides), target)).toBe(expected);
      });

      it("keeps consent for private Remember across conversations recall", () => {
        const privateTarget = {
          ...target,
          chatType: "direct" as const,
          privateDestination: true,
          destination: { sessionKey: "agent:main:webchat:direct:operator" },
        };
        expect(readActiveMemoryDecisionConsent(targeted({ agents: [] }), privateTarget)).toBe(true);
        expect(
          readActiveMemoryDecisionConsent(
            targeted(
              { agents: [] },
              { memory: { search: { rememberAcrossConversations: false } } },
            ),
            privateTarget,
          ),
        ).toBe(false);
      });
    });

    it("builds a turn decider only when requested and eligible", () => {
      const debug = vi.fn();
      const base = {
        agentId: "main",
        target: {
          chatType: "direct" as const,
          privateDestination: true,
          destination: { sessionKey: "agent:main:webchat:direct:operator" },
        },
        readCurrentConfig: () => configWith({ decisionAssistance: true, escalationDecision: true }),
        decisions: { evaluate: async () => booleanOutcome(1) },
        logger: { debug },
      };
      expect(
        createActiveMemoryTurnEscalationDecider({
          ...base,
          requested: false,
          config: configWith({ decisionAssistance: true }),
        }),
      ).toBeUndefined();
      expect(debug).not.toHaveBeenCalled();
      expect(
        createActiveMemoryTurnEscalationDecider({
          ...base,
          requested: true,
          config: configWith({ decisionAssistance: false }),
        }),
      ).toBeUndefined();
      expect(debug).toHaveBeenCalledWith(
        "active-memory: escalation decision requires Decision assistance; using built-in matcher",
      );
      expect(
        createActiveMemoryTurnEscalationDecider({
          ...base,
          requested: true,
          config: configWith({ decisionAssistance: true, escalationDecision: true }),
        }),
      ).toBeDefined();
    });
  });

  it.each([
    [undefined, false],
    [false, false],
    [true, true],
  ] as const)("treats decisionAssistance=%s as eligible=%s", (decisionAssistance, expected) => {
    const config = {
      agents: { defaults: { experimental: { decisionAssistance } } },
    } as OpenClawConfig;
    expect(isActiveMemoryDecisionEscalationEligible(config)).toBe(expected);
    expect(isActiveMemoryDecisionEscalationEligible({} as OpenClawConfig)).toBe(false);
  });
});
