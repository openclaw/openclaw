import { vi, type MockInstance } from "vitest";
import { writeSessionEntry } from "../../../config/sessions/session-accessor.sqlite-entry-store.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import * as approvals from "../../../infra/exec-approvals-store.js";
import { saveExecApprovals } from "../../../infra/exec-approvals-store.test-support.js";
import { openOpenClawAgentDatabase } from "../../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import { prepareSystemAgentRunAdmission } from "../../admitted-run-context.js";
import type { ExecElevatedDefaults } from "../../bash-tools.exec-types.js";
import { createSandboxTestContext } from "../../sandbox/test-fixtures.js";
import { createStubTool } from "../../test-helpers/agent-tool-stubs.js";
import { makeProviderModelFixture } from "../../test-helpers/provider-model-fixture.js";
import * as sandboxInfo from "../sandbox-info.js";
import { createAttemptSetupFixture } from "./attempt-setup.test-support.js";
import { prepareEmbeddedAttemptSystemPrompt } from "./attempt-system-prompt-prepare.js";
import { createEmptyPromptBootstrap } from "./attempt-system-prompt.test-support.js";

type PromptAttempt = Parameters<typeof prepareEmbeddedAttemptSystemPrompt>[0]["attempt"] & {
  workspaceDir: string;
};
const provider = "openai";
const modelId = "gpt-5.6-luna";

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
    attempt: PromptAttempt;
    admission: ReturnType<typeof prepareSystemAgentRunAdmission>;
    abort: AbortController;
    tools: ReturnType<typeof createStubTool>[];
    policyRead: MockInstance<typeof sandboxInfo.resolveEmbeddedSandboxInfoExecPolicy>;
    approvalRead: MockInstance<typeof approvals.loadExecApprovalsReadOnlyAsync>;
  }) => Promise<void>,
) {
  await withOpenClawTestState({ label: "prompt-elevation-read" }, async (state) => {
    const { workspaceDir } = state;
    const runId = "prompt-elevation";
    const sessionKey = "agent:main:prompt-elevation";
    const database = openOpenClawAgentDatabase({ agentId: "main", env: state.env });
    writeSessionEntry(database, sessionKey, {
      sessionId: runId,
      updatedAt: 1,
      ...(testCase.required ? { sandbox: "required" } : {}),
    });
    saveExecApprovals({ version: 1, defaults: { security: "allowlist", ask: "off" }, agents: {} });
    const config = {
      agents: {
        ownership: "explicit",
        defaults: { model: { primary: "openai/gpt-5.6-luna" } },
        entries: { main: { sandbox: { mode: "all" } } },
      },
      session: { store: database.path },
      tools: { exec: { host: "gateway", mode: "full" } },
    } satisfies OpenClawConfig;
    const admission = prepareSystemAgentRunAdmission(config, runId, "main", "system-prompt-test");
    const abort = new AbortController();
    const policyRead = vi.spyOn(sandboxInfo, "resolveEmbeddedSandboxInfoExecPolicy");
    const approvalRead = vi.spyOn(approvals, "loadExecApprovalsReadOnlyAsync");
    try {
      const attempt = {
        provider,
        modelId,
        model: makeProviderModelFixture({
          id: modelId,
          provider,
          api: "openai-responses",
          baseUrl: "https://api.openai.com/v1",
        }),
        config,
        admittedRunContext: await admission.admit("embedded"),
        abortSignal: abort.signal,
        sessionId: runId,
        sessionKey,
        workspaceDir,
        promptMode: "full",
        runId,
        bashElevated: testCase.elevated,
      } satisfies PromptAttempt;
      const tools = [createStubTool("exec")];
      const params = {
        attempt,
        activeContextEngine: undefined,
        bootstrap: createEmptyPromptBootstrap(),
        setup: createAttemptSetupFixture({
          effectiveCwd: workspaceDir,
          effectiveWorkspace: workspaceDir,
          sandboxSessionKey: sessionKey,
          sandboxReport: { mode: "all", sandboxed: true },
          sandbox: createSandboxTestContext({
            overrides: {
              sessionKey,
              workspaceDir,
              agentWorkspaceDir: workspaceDir,
              ...(testCase.required ? { required: true } : {}),
            },
          }),
          getProviderRuntimeHandle: () => ({ provider, modelId, prepared: true }),
        }),
        capabilityToolNames: new Set(["exec"]),
        effectiveTools: tools,
        isRawModelRun: false,
        modelToolsEnabled: true,
        skillsPrompt: "",
        toolSearchDirectoryEnabled: false,
        toolSearchRuntimeConfig: config,
      } satisfies Parameters<typeof prepareEmbeddedAttemptSystemPrompt>[0];
      const prepare = () => prepareEmbeddedAttemptSystemPrompt(params);
      await consume({ prepare, attempt, admission, abort, tools, policyRead, approvalRead });
    } finally {
      admission.close();
      policyRead.mockRestore();
      approvalRead.mockRestore();
    }
  });
}
