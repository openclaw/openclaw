// Shared real prompt/admission fixture for reporting and registered-session publication tests.
import { vi, type MockInstance } from "vitest";
import { writeSessionEntry } from "../../../config/sessions/session-accessor.sqlite-entry-store.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import * as approvals from "../../../infra/exec-approvals-store.js";
import { openOpenClawAgentDatabase } from "../../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import { prepareSystemAgentRunAdmission } from "../../admitted-run-context.js";
import type { ExecElevatedDefaults } from "../../bash-tools.exec-types.js";
import { buildBootstrapBudgetState } from "../../bootstrap-budget.js";
import { createSandboxTestContext } from "../../sandbox/test-fixtures.js";
import type { SandboxContext } from "../../sandbox/types.js";
import { createStubTool } from "../../test-helpers/agent-tool-stubs.js";
import { makeProviderModelFixture } from "../../test-helpers/provider-model-fixture.js";
import * as sandboxInfo from "../sandbox-info.js";
import { createAttemptSetupFixture } from "./attempt-setup.test-support.js";
import { prepareEmbeddedAttemptSystemPrompt } from "./attempt-system-prompt-prepare.js";
import type { EmbeddedRunAttemptParams } from "./types.js";

export type ElevationCase = {
  name: string;
  elevated?: ExecElevatedDefaults;
  required: boolean;
  promptLine?: string;
};

export async function withPromptFixture(
  testCase: ElevationCase,
  consume: (fixture: {
    prepare: () => ReturnType<typeof prepareEmbeddedAttemptSystemPrompt>;
    attempt: EmbeddedRunAttemptParams;
    admission: ReturnType<typeof prepareSystemAgentRunAdmission>;
    abort: AbortController;
    tools: ReturnType<typeof createStubTool>[];
    policyRead: MockInstance<typeof sandboxInfo.resolveEmbeddedSandboxInfoExecPolicy>;
    approvalRead: MockInstance<typeof approvals.loadExecApprovalsReadOnlyAsync>;
  }) => Promise<void>,
) {
  await withOpenClawTestState({ label: "prompt-elevation-read" }, async (state) => {
    const { workspaceDir } = state;
    const sessionKey = "agent:main:prompt-elevation";
    const database = openOpenClawAgentDatabase({ agentId: "main", env: state.env });
    writeSessionEntry(database, sessionKey, {
      sessionId: "prompt-elevation",
      updatedAt: 1,
      ...(testCase.required ? { sandbox: "required" } : {}),
    });
    approvals.saveExecApprovals({
      version: 1,
      defaults: { security: "allowlist", ask: "off" },
      agents: {},
    });
    const config = {
      agents: {
        ownership: "explicit",
        defaults: { model: { primary: "openai/gpt-5.6-luna" } },
        list: [{ id: "main", sandbox: { mode: "all" } }],
      },
      session: { store: database.path },
      tools: { exec: { host: "gateway", mode: "full" } },
    } satisfies OpenClawConfig;
    const admission = prepareSystemAgentRunAdmission(
      config,
      "prompt-elevation",
      "main",
      "system-prompt-test",
    );
    const abort = new AbortController();
    // No implementation overrides: these observations still perform real reporting and SQLite work.
    const policyRead = vi.spyOn(sandboxInfo, "resolveEmbeddedSandboxInfoExecPolicy");
    const approvalRead = vi.spyOn(approvals, "loadExecApprovalsReadOnlyAsync");
    try {
      const attempt = {
        provider: "openai",
        modelId: "gpt-5.6-luna",
        model: makeProviderModelFixture({
          id: "gpt-5.6-luna",
          provider: "openai",
          api: "openai-responses",
          baseUrl: "https://api.openai.com/v1",
        }),
        config,
        admittedRunContext: await admission.admit("embedded"),
        abortSignal: abort.signal,
        sessionId: "prompt-elevation",
        sessionKey,
        sessionFile: sessionKey,
        workspaceDir,
        prompt: "Explain this synthetic fixture",
        promptMode: "full",
        runId: "prompt-elevation",
        timeoutMs: 60_000,
        thinkLevel: "off",
        bashElevated: testCase.elevated,
        authProfileStore: { version: 1, profiles: {} },
        get authStorage(): never {
          throw new Error("Prompt fixture unexpectedly accessed auth storage");
        },
        get modelRegistry(): never {
          throw new Error("Prompt fixture unexpectedly accessed model registry");
        },
      } satisfies EmbeddedRunAttemptParams;
      const tools = [createStubTool("exec")];
      const params = {
        attempt,
        activeContextEngine: undefined,
        bootstrap: {
          ...buildBootstrapBudgetState({ files: [] }),
          bootstrapMode: "full",
          contextFiles: [],
          bootstrapInjectionStats: [],
          shouldRecordCompletedBootstrapTurn: false,
          workspaceNotes: [],
        },
        setup: createAttemptSetupFixture({
          effectiveCwd: workspaceDir,
          effectiveWorkspace: workspaceDir,
          resolvedWorkspace: workspaceDir,
          sessionPermissionRoot: workspaceDir,
          sandboxSessionKey: sessionKey,
          sandbox: createSandboxTestContext({
            overrides: {
              sessionKey,
              workspaceDir,
              agentWorkspaceDir: workspaceDir,
              ...(testCase.required
                ? ({ required: true } satisfies Pick<SandboxContext, "required">)
                : {}),
            },
          }),
          getProviderRuntimeHandle: () => ({
            provider: attempt.provider,
            modelId: attempt.modelId,
            prepared: true,
          }),
        }),
        capabilityToolNames: new Set(["exec"]),
        effectiveTools: tools,
        isRawModelRun: false,
        modelToolsEnabled: true,
        skillsPrompt: "",
        toolSearchDirectoryEnabled: false,
        toolSearchRuntimeConfig: config,
      } satisfies Parameters<typeof prepareEmbeddedAttemptSystemPrompt>[0];
      await consume({
        prepare: () => prepareEmbeddedAttemptSystemPrompt(params),
        attempt,
        admission,
        abort,
        tools,
        policyRead,
        approvalRead,
      });
    } finally {
      admission.close();
      policyRead.mockRestore();
      approvalRead.mockRestore();
    }
  });
}
