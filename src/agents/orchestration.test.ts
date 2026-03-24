import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  buildHandoffEnvelope,
  buildHandoffFingerprint,
  composeAgentRolePrompt,
  formatMainDispatchGuide,
  formatMainSynthesisStyleGuide,
  formatSpecialistDisciplineGuide,
  formatSpecialistResponseForParent,
  formatTaskForSubagent,
  parseSpecialistResponseEnvelope,
  resolveOrchestrationConfig,
} from "./orchestration.js";

describe("agents orchestration helpers", () => {
  it("resolves backward-compatible orchestration defaults", () => {
    const cfg: OpenClawConfig = {};
    expect(resolveOrchestrationConfig(cfg)).toMatchObject({
      communication: {
        allowDirectSpecialistToSpecialist: false,
        requireStructuredHandoff: true,
        requireStructuredReturn: true,
        allowParallelDelegation: true,
      },
      limits: {
        maxDelegationDepth: 2,
        maxAgentsPerRequest: 3,
        dedupeRepeatedHandoffs: true,
        stopWhenNoNewInformation: true,
      },
    });
  });

  it("formats a structured handoff envelope for specialists", () => {
    const envelope = buildHandoffEnvelope({
      targetAgent: "legal",
      taskText: "review the claim",
      requestedOutput: "Return a risk memo",
      constraints: ["Use only stated facts"],
      knownFacts: ["The wagon arrived damaged"],
      priority: "high",
      returnFormat: "decision memo",
    });
    const text = formatTaskForSubagent({
      envelope,
      rawTaskText: "review the claim",
      includeEnvelope: true,
    });
    expect(text).toContain("[Structured Handoff]");
    expect(text).toContain("targetAgent: legal");
    expect(text).toContain("requestedOutput: Return a risk memo");
    expect(text).toContain("[Task for specialist]");
  });

  it("parses and re-formats a structured specialist response", () => {
    const parsed = parseSpecialistResponseEnvelope({
      fallbackAgentId: "legal",
      text: [
        "agentId: legal",
        "status: partial",
        "summary: Core risks identified",
        "keyFindings:",
        "- notice window is short",
        "assumptions:",
        "- shipment records are complete",
        "risks:",
        "- carrier may dispute causation",
        "output:",
        "Drafted a claim outline and identified documentary gaps.",
        "followUpNeeded:",
        "- get photos from depot",
        "suggestedNextAgent: trk",
      ].join("\n"),
    });
    expect(parsed).toMatchObject({
      agentId: "legal",
      status: "partial",
      summary: "Core risks identified",
      suggestedNextAgent: "trk",
    });
    expect(formatSpecialistResponseForParent(parsed!)).toContain(
      "[Structured Specialist Response]",
    );
  });

  it("generates stable handoff fingerprints for dedupe", () => {
    const first = buildHandoffEnvelope({ targetAgent: "design", taskText: "make logo" });
    const second = buildHandoffEnvelope({ targetAgent: "design", taskText: "make logo" });
    expect(buildHandoffFingerprint(first)).toBe(buildHandoffFingerprint(second));
  });

  it("builds a Main dispatch guide from orchestration policy", () => {
    const cfg: OpenClawConfig = {
      agents: {
        orchestration: {
          communication: { allowParallelDelegation: true },
          limits: {
            maxAgentsPerRequest: 3,
            maxDelegationDepth: 2,
            dedupeRepeatedHandoffs: true,
            stopWhenNoNewInformation: true,
          },
        },
      },
    };
    const guide = formatMainDispatchGuide(cfg);
    expect(guide).toContain("Dispatch Playbook");
    expect(guide).toContain("Classify request");
    expect(guide).toContain("multi-agent sequential delegation");
    expect(guide).toContain("multi-agent parallel-safe delegation");
    expect(guide).toContain("Never expose raw agent-to-agent envelopes");
    expect(guide).toContain("max delegation depth 2");
  });

  it("gives Main the dispatch guide but not specialists", () => {
    const cfg: OpenClawConfig = {
      agents: {
        list: [{ id: "main", default: true }, { id: "legal" }],
      },
    };
    const mainPrompt = composeAgentRolePrompt({
      cfg,
      agentId: "main",
      baseRolePrompt: "You are Main orchestrator.",
      mainAgentId: "main",
    });
    const legalPrompt = composeAgentRolePrompt({
      cfg,
      agentId: "legal",
      baseRolePrompt: "You are Legal specialist.",
      mainAgentId: "main",
    });

    expect(mainPrompt).toContain("You are Main orchestrator.");
    expect(mainPrompt).toContain("Dispatch Playbook");
    expect(mainPrompt).toContain("Synthesis Style Guide");
    expect(legalPrompt).toContain("You are Legal specialist.");
    expect(legalPrompt).toContain("Specialist Discipline");
    expect(legalPrompt).not.toContain("Dispatch Playbook");
    expect(legalPrompt).not.toContain("Synthesis Style Guide");
  });

  it("builds a Main synthesis style guide without raw inter-agent leakage", () => {
    const guide = formatMainSynthesisStyleGuide();
    expect(guide).toContain("Return only the final user-facing answer");
    expect(guide).toContain("never expose raw specialist envelopes");
    expect(guide).toContain("Deduplicate overlapping findings");
    expect(guide).toContain("Avoid long introductions");
    expect(guide).toContain("Never surface suggestedNextAgent");
  });

  it("builds a strict specialist discipline guide", () => {
    const guide = formatSpecialistDisciplineGuide();
    expect(guide).toContain("Stay strictly inside your assigned domain");
    expect(guide).toContain("Do not broaden scope");
    expect(guide).toContain("status: partial");
    expect(guide).toContain("brief, concrete");
  });
});
