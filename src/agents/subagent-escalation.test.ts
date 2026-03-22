import { beforeEach, describe, expect, it, vi } from "vitest";

describe("subagent escalation helpers", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.doUnmock("../logging/subsystem.js");
  });

  it("parses a valid escalation request envelope", async () => {
    const { parseSubagentEscalationRequest } = await import("./subagent-escalation.js");
    const parsed = parseSubagentEscalationRequest(`
<<<BEGIN_OPENCLAW_TASK_ESCALATION_V1>>>
{"tier":"moderate","reason":"needs_deeper_reasoning","summary":"Need a stronger worker for repo-wide analysis."}
<<<END_OPENCLAW_TASK_ESCALATION_V1>>>
`);

    expect(parsed).toEqual({
      tier: "moderate",
      reason: "needs_deeper_reasoning",
      summary: "Need a stronger worker for repo-wide analysis.",
    });
  });

  it("rejects malformed escalation envelopes", async () => {
    const { parseSubagentEscalationRequest } = await import("./subagent-escalation.js");
    expect(
      parseSubagentEscalationRequest(`
<<<BEGIN_OPENCLAW_TASK_ESCALATION_V1>>>
{"tier":"moderate","reason":"Not Snake Case","summary":"bad"}
<<<END_OPENCLAW_TASK_ESCALATION_V1>>>
`),
    ).toBeNull();
    expect(
      parseSubagentEscalationRequest(`
prefix text
<<<BEGIN_OPENCLAW_TASK_ESCALATION_V1>>>
{"tier":"moderate","reason":"needs_deeper_reasoning","summary":"bad"}
<<<END_OPENCLAW_TASK_ESCALATION_V1>>>
`),
    ).toBeNull();
    expect(
      parseSubagentEscalationRequest(`
<<<BEGIN_OPENCLAW_TASK_ESCALATION_V1>>>
{"tier":null,"reason":null,"summary":null}
<<<END_OPENCLAW_TASK_ESCALATION_V1>>>
`),
    ).toBeNull();
  });

  it("builds and parses escalation handoff packets", async () => {
    const { buildSubagentEscalationHandoffPacket, parseSubagentEscalationHandoff } =
      await import("./subagent-escalation.js");
    const packet = buildSubagentEscalationHandoffPacket({
      version: 1,
      stage: "worker",
      tier: "complex",
      taskTag: "repo-audit",
      reason: "needs_stronger_model",
      originalTask: "Audit the routing layer.",
      triageSummary: "Need broad context and higher reasoning depth.",
    });

    expect(parseSubagentEscalationHandoff(packet)).toEqual({
      version: 1,
      stage: "worker",
      tier: "complex",
      taskTag: "repo-audit",
      reason: "needs_stronger_model",
      originalTask: "Audit the routing layer.",
      triageSummary: "Need broad context and higher reasoning depth.",
    });
  });

  it("rejects malformed handoff packets", async () => {
    const { parseSubagentEscalationHandoff } = await import("./subagent-escalation.js");
    expect(
      parseSubagentEscalationHandoff(`
<<<BEGIN_OPENCLAW_ESCALATION_HANDOFF_V1>>>
{"version":1,"stage":"triage","tier":"moderate","taskTag":"repo-audit","reason":"needs_stronger_model","originalTask":"Audit the routing layer.","triageSummary":"Need broad context."}
<<<END_OPENCLAW_ESCALATION_HANDOFF_V1>>>
`),
    ).toBeNull();
    expect(
      parseSubagentEscalationHandoff(`
<<<BEGIN_OPENCLAW_ESCALATION_HANDOFF_V1>>>
{"version":1,"stage":"worker","tier":"moderate","taskTag":"repo-audit","reason":"bad reason","originalTask":"Audit the routing layer.","triageSummary":"Need broad context."}
<<<END_OPENCLAW_ESCALATION_HANDOFF_V1>>>
`),
    ).toBeNull();
    expect(
      parseSubagentEscalationHandoff(`
<<<BEGIN_OPENCLAW_ESCALATION_HANDOFF_V1>>>
{"version":1,"stage":"worker","tier":"moderate","taskTag":null,"reason":null,"originalTask":null,"triageSummary":null}
<<<END_OPENCLAW_ESCALATION_HANDOFF_V1>>>
`),
    ).toBeNull();
  });

  it("prefers per-agent escalation tier models over defaults", async () => {
    const { resolveSubagentEscalationTierModel } = await import("./subagent-escalation.js");
    const cfg = {
      agents: {
        defaults: {
          subagents: {
            escalation: {
              enabled: true,
              moderateModel: "anthropic/claude-sonnet-4-6",
              complexModel: "anthropic/claude-opus-4-1",
            },
          },
        },
        list: [
          {
            id: "research",
            subagents: {
              escalation: {
                enabled: true,
                moderateModel: "openai/gpt-5.3-codex",
                complexModel: "openai/gpt-5.4",
              },
            },
          },
        ],
      },
    };

    expect(
      resolveSubagentEscalationTierModel({
        cfg,
        agentId: "research",
        tier: "moderate",
      }),
    ).toBe("openai/gpt-5.3-codex");
    expect(
      resolveSubagentEscalationTierModel({
        cfg,
        agentId: "research",
        tier: "complex",
      }),
    ).toBe("openai/gpt-5.4");
    expect(
      resolveSubagentEscalationTierModel({
        cfg,
        agentId: "other",
        tier: "complex",
      }),
    ).toBe("anthropic/claude-opus-4-1");
  });

  it("resolves task tags from label, capability, role, then agent id", async () => {
    const { resolveSubagentEscalationTaskTag } = await import("./subagent-escalation.js");
    expect(
      resolveSubagentEscalationTaskTag({
        label: "dispatch-ticket",
        capability: "research",
        role: "worker",
        agentId: "research",
      }),
    ).toBe("dispatch-ticket");
    expect(
      resolveSubagentEscalationTaskTag({
        capability: "research",
        role: "worker",
        agentId: "research",
      }),
    ).toBe("research");
    expect(
      resolveSubagentEscalationTaskTag({
        role: "worker",
        agentId: "research",
      }),
    ).toBe("worker");
    expect(
      resolveSubagentEscalationTaskTag({
        agentId: "research",
      }),
    ).toBe("research");
    expect(
      resolveSubagentEscalationTaskTag({
        label: null,
        capability: null,
        role: null,
        agentId: null,
      }),
    ).toBe("unlabeled");
  });

  it("logs structured escalation ladder decisions", async () => {
    const infoSpy = vi.fn();
    vi.doMock("../logging/subsystem.js", () => ({
      createSubsystemLogger: () => ({ info: infoSpy }),
    }));

    const { logSubagentEscalationDecision } = await import("./subagent-escalation.js");
    logSubagentEscalationDecision({
      agentId: "research",
      stage: "triage",
      ladderTier: "moderate",
      taskTag: "dispatch-ticket",
      resolvedModel: "anthropic/claude-sonnet-4-6",
      reason: "needs_deeper_reasoning",
    });

    expect(infoSpy).toHaveBeenCalledWith("subagent escalation ladder decision", {
      agent: "research",
      task_tag: "dispatch-ticket",
      ladder_tier: "moderate",
      stage: "triage",
      resolved_model: "anthropic/claude-sonnet-4-6",
      reason: "needs_deeper_reasoning",
    });
  });
});
