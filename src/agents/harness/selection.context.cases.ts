import { expect, it, vi, type Mock } from "vitest";
import { setActiveNodeContexts } from "../../infra/active-node-context.js";
import { createOpenClawCodingToolsAsync } from "../../plugin-sdk/agent-harness.js";
import { isHostScopedAgentToolActive } from "../agent-tools.ring-zero-context.js";
import type { EmbeddedRunAttemptParams } from "../embedded-agent-runner/run/types.js";
import { AGENT_INTERNAL_EVENT_TYPE_TASK_COMPLETION } from "../internal-event-contract.js";
import { RUNTIME_EVENT_USER_PROMPT } from "../internal-runtime-context.js";
import { createOpenClawOnlyToolConstructionPlan } from "../test-helpers/tool-construction-plan.js";
import { runAgentHarnessAttempt } from "./selection.js";
import { createAttemptResult } from "./selection.test-support.js";
import type { AgentHarness } from "./types.js";

/** Registers under the caller's existing registry/generation lifecycle hooks. */
export function registerSelectionContextCases({
  createAttemptParams,
  registerHarness,
  agentRunAttempt,
  createBuiltInAttemptParams,
}: {
  createAttemptParams: () => EmbeddedRunAttemptParams;
  registerHarness: (overrides?: Partial<AgentHarness>) => AgentHarness;
  agentRunAttempt: Mock<AgentHarness["runAttempt"]>;
  createBuiltInAttemptParams: () => EmbeddedRunAttemptParams;
}): void {
  it.each(["openclaw", "codex"] as const)(
    "prepares active computer context only at the %s harness's consuming boundary",
    async (runtime) => {
      let prepared = false;
      const prepare = vi.fn(async () => {
        prepared = true;
      });
      setActiveNodeContexts([{ nodeId: "synthetic-computer", prepare, isCurrent: () => prepared }]);
      try {
        if (runtime === "codex") {
          registerHarness({
            runAttempt: async (attempt) => {
              expect(prepare).toHaveBeenCalledOnce();
              expect(attempt.hostCapabilities?.activeComputerContext?.()).toContain(
                "active_node=synthetic-computer",
              );
              return createAttemptResult("codex");
            },
          });
        }
        const result = await runAgentHarnessAttempt({
          ...createAttemptParams(),
          agentHarnessRuntimeOverride: runtime,
        });
        expect(result.sessionIdUsed).toBe(runtime);
        // Embedded prompt assembly owns its later refresh; plugin consumers need it here.
        expect(prepare).toHaveBeenCalledTimes(runtime === "openclaw" ? 0 : 1);
      } finally {
        setActiveNodeContexts([]);
      }
    },
  );

  it("carries a runtime-event completion result into the plugin harness inbound context", async () => {
    const runAttempt = vi.fn<AgentHarness["runAttempt"]>(async () => createAttemptResult("native"));
    registerHarness({ runAttempt });
    const params = {
      ...createAttemptParams(),
      agentHarnessId: "codex",
      prompt: RUNTIME_EVENT_USER_PROMPT,
      internalEvents: [
        {
          type: AGENT_INTERNAL_EVENT_TYPE_TASK_COMPLETION,
          source: "subagent" as const,
          childSessionKey: "agent:main:subagent:child-a",
          announceType: "subagent task",
          taskLabel: "child A",
          status: "ok" as const,
          statusLabel: "completed successfully",
          result: "CHILD_RESULT_A_DONE",
          replyInstruction: "Summarize the child result for the user.",
        },
      ],
      runtimeContextFragments: [
        { kind: "runtime-instruction" as const, text: "SUPPLEMENTAL_RUNTIME_NOTE" },
      ],
    };

    await runAgentHarnessAttempt(params);

    const received = runAttempt.mock.calls.at(-1)?.[0];
    expect(received?.prompt).toBe(RUNTIME_EVENT_USER_PROMPT);
    const text = received?.currentInboundContext?.text ?? "";
    expect(text.match(/CHILD_RESULT_A_DONE/g)).toHaveLength(1);
    expect(text).toContain("Summarize the child result for the user.");
    expect(text.indexOf("CHILD_RESULT_A_DONE")).toBeLessThan(
      text.indexOf("SUPPLEMENTAL_RUNTIME_NOTE"),
    );
    expect(received?.currentInboundContext?.fragments).toContainEqual({
      kind: "conversation-data",
      text: expect.stringContaining("CHILD_RESULT_A_DONE"),
    });
  });
  it("binds the same host OpenClaw scope to the built-in OpenClaw harness", async () => {
    let toolNames: string[] = [];
    agentRunAttempt.mockImplementationOnce(async () => {
      await Promise.resolve();
      toolNames = (
        await createOpenClawCodingToolsAsync({
          config: { tools: { allow: ["read"], deny: ["openclaw"], toolSearch: true } },
          runtimeToolAllowlist: ["openclaw"],
          toolConstructionPlan: createOpenClawOnlyToolConstructionPlan(),
        })
      ).map((tool) => tool.name);
      return createAttemptResult("openclaw");
    });
    const onContextAccountingEvent = vi.fn();
    const onCompactionRequestBudget = vi.fn();
    let promptReads = 0;
    const params = Object.freeze({
      ...createBuiltInAttemptParams(),
      get prompt() {
        promptReads++;
        return "synthetic handoff prompt";
      },
      toolsAllow: ["openclaw"],
      systemAgentTool: { surface: "gateway" as const, proposalRef: {}, directiveRef: {} },
      compactionCountOwner: "caller" as const,
      onContextAccountingEvent,
      onCompactionRequestBudget,
    });

    const result = await runAgentHarnessAttempt(params);

    expect(result.sessionIdUsed).toBe("openclaw");
    const attempt = agentRunAttempt.mock.calls[0]?.[0];
    expect(attempt).toMatchObject({
      compactionCountOwner: "caller",
      onContextAccountingEvent,
      onCompactionRequestBudget,
      operationalRunInstance: params.admittedRunContext.operationalRunInstance,
    });
    expect(params).not.toHaveProperty("operationalRunInstance");
    // Only the owned attempt copy reads caller payload; authority receives its narrow facts.
    expect(promptReads).toBe(1);
    expect(attempt).not.toHaveProperty("systemAgentTool");
    expect(toolNames).toEqual(["openclaw"]);
    expect(isHostScopedAgentToolActive("openclaw")).toBe(false);
  });
}
