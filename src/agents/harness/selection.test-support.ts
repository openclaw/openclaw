import { expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { Model } from "../../llm/types.js";
import type { AdmittedRunContext } from "../admitted-run-context.js";
import type {
  EmbeddedRunAttemptParams,
  EmbeddedRunAttemptResult,
} from "../embedded-agent-runner/run/types.js";
import { registerAgentHarness } from "./registry.js";
import type { AgentHarness } from "./types.js";

export function createHarnessAttemptParams(
  admittedRunContext: AdmittedRunContext,
  config?: OpenClawConfig,
): EmbeddedRunAttemptParams {
  return {
    admittedRunContext,
    prompt: "hello",
    sessionId: "session-1",
    runId: admittedRunContext.operationalRunInstance.runId,
    sessionFile: "/tmp/session.jsonl",
    workspaceDir: "/tmp/workspace",
    timeoutMs: 5_000,
    provider: "codex",
    modelId: "gpt-5.4",
    model: { id: "gpt-5.4", provider: "codex" } as Model,
    authStorage: {} as never,
    authProfileStore: { version: 1, profiles: {} },
    modelRegistry: {} as never,
    thinkLevel: "low",
    config,
  } as EmbeddedRunAttemptParams;
}

export function registerHarnessInputPolicyTests({
  createAttemptParams,
  createAttemptResult,
  runAgentHarnessAttempt,
}: {
  createAttemptParams: () => EmbeddedRunAttemptParams;
  createAttemptResult: (sessionId: string) => EmbeddedRunAttemptResult;
  runAgentHarnessAttempt: typeof import("./selection.js").runAgentHarnessAttempt;
}) {
  it("rejects delegated input before a plugin run while preserving ordinary turns", async () => {
    const runAttempt = vi.fn<AgentHarness["runAttempt"]>(async () => createAttemptResult("codex"));
    registerAgentHarness(
      {
        id: "codex",
        label: "Codex",
        conversationToolPolicySupport: "exact",
        supports: (ctx) =>
          ctx.provider === "codex" ? { supported: true, priority: 100 } : { supported: false },
        runAttempt,
      },
      { ownerPluginId: "codex" },
    );
    await expect(
      runAgentHarnessAttempt({
        ...createAttemptParams(),
        delegatedInputPolicy: {
          clauses: [{ kind: "configured", allow: ["read"] }],
          parameters: { fileTools: [], exec: [], sandbox: [], unsupported: [] },
        },
      }),
    ).rejects.toThrow("cannot verify delegated input");
    expect(runAttempt).not.toHaveBeenCalled();
    await runAgentHarnessAttempt(createAttemptParams());
    expect(runAttempt).toHaveBeenCalledOnce();
  });

  it("passes partial conversation policy to harnesses that enforce it exactly", async () => {
    const received: Array<{
      conversationToolPolicy: EmbeddedRunAttemptParams["conversationToolPolicy"];
      pluginHarnessToolPolicyRestricted: boolean | undefined;
      toolsAllow: string[] | undefined;
    }> = [];
    const runAttempt = vi.fn<AgentHarness["runAttempt"]>(async (attempt) => {
      received.push({
        conversationToolPolicy: attempt.conversationToolPolicy,
        pluginHarnessToolPolicyRestricted: attempt.pluginHarnessToolPolicyRestricted,
        toolsAllow: attempt.toolsAllow,
      });
      return createAttemptResult("codex");
    });
    registerAgentHarness(
      {
        id: "codex",
        label: "Codex",
        conversationToolPolicySupport: "exact",
        supports: (ctx) =>
          ctx.provider === "codex" ? { supported: true, priority: 100 } : { supported: false },
        runAttempt,
      },
      { ownerPluginId: "codex" },
    );

    for (const toolsAllow of [undefined, ["Read", "Bash"]]) {
      await runAgentHarnessAttempt({
        ...createAttemptParams(),
        conversationToolPolicy: { deny: ["exec"] },
        toolsAllow,
      });
    }

    expect(received).toEqual([
      {
        conversationToolPolicy: { deny: ["exec"] },
        pluginHarnessToolPolicyRestricted: true,
        toolsAllow: undefined,
      },
      {
        conversationToolPolicy: { deny: ["exec"] },
        pluginHarnessToolPolicyRestricted: true,
        toolsAllow: ["Read", "Bash"],
      },
    ]);
  });
}
