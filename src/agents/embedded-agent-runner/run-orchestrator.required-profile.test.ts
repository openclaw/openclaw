import { expect, it, vi } from "vitest";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { prepareSystemAgentRunAdmission } from "../admitted-run-context.js";
import { installSessionPlacementAdmissionProvider } from "../session-placement-admission.js";
import { runEmbeddedAgent } from "./run-orchestrator.js";

it("resolves the admitted canonical agent before mandatory placement preparation", async () => {
  const state = await createOpenClawTestState({ label: "required-worker-canonical-target" });
  const agentId = "worker-agent";
  const sessionKey = "agent:worker-agent:direct:required";
  const sessionId = "canonical-required-session";
  const cfg: OpenClawConfig = {
    agents: { entries: { [agentId]: { workspace: state.workspaceDir } } },
    cloudWorkers: { requiredProfile: "dedicated" },
  };
  await state.writeConfig(cfg);
  await upsertSessionEntryCore({ agentId, sessionKey }, { sessionId, updatedAt: Date.now() });
  const reached = new Error("placement owner reached before model execution");
  const prepare = vi.fn(
    async (identity: { agentId?: string; sessionKey?: string; sessionId: string }) => {
      expect(identity).toMatchObject({ agentId, sessionKey, sessionId });
      throw reached;
    },
  );
  const local = vi.fn(async () => ({ meta: { durationMs: 0 } }));
  const uninstall = installSessionPlacementAdmissionProvider({
    prepareRequiredSession: prepare,
    assertCompactionSuccessorAllowed: () => {},
    executeLocalTurn: async (_claim, run) => await run(),
    executeTurn: local,
  });
  const admission = prepareSystemAgentRunAdmission(
    cfg,
    "canonical-required-run",
    agentId,
    "required-worker-test",
  );
  try {
    await expect(
      runEmbeddedAgent({
        // Public run inputs can omit agentId when the session key already identifies it.
        sessionKey,
        sessionId,
        sessionFile: sessionKey,
        workspaceDir: state.workspaceDir,
        config: cfg,
        prompt: "Use the dedicated worker",
        runId: "canonical-required-run",
        timeoutMs: 1000,
        preparedRunAdmission: admission,
      }),
    ).rejects.toBe(reached);
    expect(prepare).toHaveBeenCalledOnce();
    expect(local).not.toHaveBeenCalled();
  } finally {
    admission.close();
    uninstall();
    await state.cleanup();
  }
});
