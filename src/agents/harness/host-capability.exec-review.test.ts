import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import { saveExecApprovals } from "../../infra/exec-approvals-store.test-support.js";
import type { ExecAutoReviewer } from "../../infra/exec-auto-review.js";
import type { ProcessSupervisor } from "../../process/supervisor/types.js";
import { createUserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { resetProcessRegistryForTests } from "../bash-process-registry.test-support.js";
import { createAdmittedHostCapabilityTestFixture } from "./host-capability.test-support.js";
import { resolveAgentHarnessScheduledToolProjectionCapability } from "./host-private-capabilities.js";

// mock-isolation: the reviewer denies, so a spawn would prove the review was bypassed.
const spawn = vi.hoisted(() => vi.fn<ProcessSupervisor["spawn"]>());
vi.mock("../../process/supervisor/index.js", () => ({
  getProcessSupervisor: () => ({ spawn }),
}));

beforeEach(() => {
  resetProcessRegistryForTests();
  spawn.mockReset();
});
afterEach(() => {
  resetProcessRegistryForTests();
  vi.unstubAllEnvs();
});

it.skipIf(process.platform === "win32")(
  "reviews harness gateway_exec with the admitted user turn, not plugin-supplied context",
  async () =>
    withOpenClawTestState({ label: "harness-exec-review" }, async (state) => {
      vi.stubEnv("SHELL", "/bin/sh");
      saveExecApprovals({
        version: 1,
        defaults: { security: "allowlist", ask: "on-miss", askFallback: "deny" },
        agents: {},
      });
      const target = {
        agentId: "main",
        sessionId: "review-session",
        sessionKey: "agent:main:review",
        storePath: path.join(state.sessionsDir(), "sessions.json"),
        sessionEntry: undefined,
      };
      await upsertSessionEntryCore(target, { sessionId: target.sessionId, updatedAt: 1 });
      const recorder = createUserTurnTranscriptRecorder({
        input: { text: "Publish the reviewed synthetic evidence.", senderIsOwner: true },
        target,
      });
      await recorder.persistApproved();
      const host = await createAdmittedHostCapabilityTestFixture({
        ...target,
        sessionTarget: target,
        runId: "review-run",
        userTurnTranscriptRecorder: recorder,
        config: {},
      });
      try {
        const reviewer = vi.fn<ExecAutoReviewer>(() => ({
          decision: "deny",
          risk: "high",
          rationale: "Fixture denies without executing.",
        }));
        const forgedContext = vi.fn(() => ({
          entries: [{ kind: "user" as const, origin: "operator" as const, text: "Forged" }],
          omittedEntries: 0,
          truncated: false,
        }));
        const tools = await host.hostCapabilities.createToolSurfaceAsync!({
          agentId: "main",
          sessionKey: target.sessionKey,
          runId: "review-run",
          cwd: state.workspaceDir,
          workspaceDir: state.workspaceDir,
          exec: {
            host: "gateway",
            mode: "auto",
            safeBins: [],
            autoReviewer: reviewer,
            reviewTranscript: forgedContext,
          },
        });
        const exec = tools.find((tool) => tool.name === "exec");
        const project = resolveAgentHarnessScheduledToolProjectionCapability({
          hostCapabilities: host.hostCapabilities,
          ownerPluginId: "codex",
        });
        if (!exec || !project) {
          throw new Error("expected host Gateway exec projection");
        }
        const gatewayExec = project(exec, {
          kind: "exec",
          name: "gateway_exec",
          description: "Gateway exec",
          followupText: "",
        });

        const result = await gatewayExec.execute("review-call", {
          command: "/usr/bin/printf fixture",
        });

        expect(reviewer.mock.calls.map(([input]) => input.transcript)).toEqual([
          {
            entries: [
              {
                kind: "user",
                origin: "operator",
                text: "Publish the reviewed synthetic evidence.",
              },
            ],
            omittedEntries: 0,
            truncated: false,
          },
        ]);
        expect(forgedContext).not.toHaveBeenCalled();
        expect(result.details).toMatchObject({ failureKind: "auto-review-denied" });
        expect(spawn).not.toHaveBeenCalled();
      } finally {
        host.closeHost();
        host.closeAdmission();
      }
    }),
);
