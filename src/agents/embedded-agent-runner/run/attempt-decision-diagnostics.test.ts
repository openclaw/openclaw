import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  logDecisionToolRequest,
  measureDecisionToolSurface,
} from "./attempt-decision-diagnostics.js";
import { createPromptBuildToolPolicy } from "./attempt-prompt-support.js";
const logger = vi.hoisted(() => ({ isEnabled: vi.fn(() => true), debug: vi.fn() }));
vi.mock("../logger.js", () => ({ log: logger }));
const trace = { traceId: "11111111111111111111111111111111" };
const decision = {
  shouldPruneTools: true,
  restrictionApplied: true,
  status: "proposed" as const,
  reason: "conversational",
  latencyMs: 7,
};
beforeEach(() => {
  logger.isEnabled.mockReturnValue(true);
  logger.debug.mockClear();
});

describe("Decision primary tool-definition diagnostics", () => {
  it("does not read definitions or serialize when DEBUG is off", () => {
    logger.isEnabled.mockReturnValue(false);
    const read = vi.fn(() => {
      throw new Error("private getter");
    });
    expect(measureDecisionToolSurface(read)).toBeUndefined();
    logDecisionToolRequest({ decision, readFinal: read, trace });
    expect(read).not.toHaveBeenCalled();
    expect(logger.debug).not.toHaveBeenCalled();
  });
  it("measures actual visible definitions and keeps nonzero required tools without logging payloads", () => {
    const required = {
      name: "message",
      description: "private required description",
      parameters: { type: "object" },
    };
    const optional = {
      name: "read",
      description: "private optional description",
      parameters: { secret: "private schema" },
    };
    const baseline = measureDecisionToolSurface(() => [required, optional], ["message", "denied"]);
    logDecisionToolRequest({
      decision,
      baseline,
      readFinal: () => [required],
      requiredNames: ["message", "denied"],
      trace,
    });
    const record = logger.debug.mock.calls[0]?.[1];
    expect(record).toMatchObject({
      baselineVisibleTools: 2,
      finalVisibleTools: 1,
      requiredRetained: 1,
      definitionCharsSaved:
        JSON.stringify([required, optional]).length - JSON.stringify([required]).length,
      restrictionApplied: true,
      stage: "primary-dispatch",
      providerAcceptance: "not-observed",
    });
    expect(JSON.stringify(record)).not.toContain("private");
    expect(record).not.toHaveProperty("tools");
  });
  it("reports unknown rather than zero for unmeasurable definitions", () => {
    const read = () => [
      {
        name: "x",
        parameters: {
          get secret() {
            throw new Error("private payload");
          },
        },
      },
    ];
    logDecisionToolRequest({
      decision,
      baseline: measureDecisionToolSurface(read),
      readFinal: read,
      trace,
    });
    expect(logger.debug.mock.calls[0]?.[1]).toMatchObject({
      surfaceEffect: "unknown",
      baselineDefinitionChars: null,
      finalDefinitionChars: null,
      definitionCharsSaved: null,
    });
    expect(JSON.stringify(logger.debug.mock.calls)).not.toContain("private");
  });
  it("captures Code Mode description scalars before mutation and recaptures only on owner refresh", () => {
    const tool = { name: "exec", description: "a full bounded directory", parameters: {} };
    let active = ["exec"];
    const policy = createPromptBuildToolPolicy({
      session: {
        getActiveToolNames: () => active,
        setActiveToolsByName: (names) => {
          active = names;
        },
      },
      readModelTools: () => (active.length ? [tool] : []),
      effectiveTools: [tool],
      uncompactedEffectiveTools: [tool],
      tools: [tool],
      codeModeControlsEnabled: true,
    });
    const initial = policy.readDecisionBaseline();
    policy.apply([]);
    tool.description = "short";
    expect(policy.readDecisionBaseline()).toEqual(initial);
    policy.apply(undefined);
    expect(policy.readDecisionBaseline()).toEqual(initial);
    policy.refresh();
    expect(policy.readDecisionBaseline()?.definitionJsonChars).toBeLessThan(
      initial!.definitionJsonChars,
    );
  });
});
