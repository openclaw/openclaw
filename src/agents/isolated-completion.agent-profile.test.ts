// Fixed-prompt utility calls (titles, labels, summaries) go through the isolated completion
// runtime, which loads no workspace context and no tool surface, so it takes no Agent Profile.
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  isolatedReply,
  isolatedCompletionMocks as mocks,
  isolatedRequest,
  preparedModelRuntime,
  registerIsolatedHarness,
  releaseRuntimeLease,
  resetIsolatedCompletionTestState,
  runIsolatedCompletion,
} from "./isolated-completion.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const WORKSPACE_MARKER = "WORKSPACE-FILE-MARKER";

beforeEach(resetIsolatedCompletionTestState);

function configWith(workspace: string, agentProfileId: string | undefined): OpenClawConfig {
  return {
    agents: { defaults: { workspace, ...(agentProfileId ? { agentProfileId } : {}) } },
  } as OpenClawConfig;
}

describe("isolated completion with an Agent Profile selected", () => {
  it.each(["openclaw/small", "openclaw/base", undefined])(
    "dispatches only the fixed prompts, with no workspace files, when agentProfileId is %s",
    async (agentProfileId) => {
      const workspace = tempDirs.make("isolated-profile-");
      fs.writeFileSync(path.join(workspace, "AGENTS.md"), WORKSPACE_MARKER.repeat(600));
      const dispatch = vi.fn(async (..._args: unknown[]) => isolatedReply("done"));
      const model = { provider: "openai", id: "gpt-test", api: "openai-responses" };
      mocks.resolveModelAsync.mockResolvedValue({ model });
      mocks.prepareSimpleCompletionModel.mockResolvedValue({
        model,
        auth: { apiKey: "synthetic-key", mode: "api-key", source: "test" },
      });
      registerIsolatedHarness({ runIsolatedCompletionV2: dispatch });
      // The runtime snapshot owns the config and workspace of an isolated completion.
      const config = configWith(workspace, agentProfileId);
      mocks.acquireAgentRunPreparedModelRuntime.mockResolvedValue({
        snapshot: { ...preparedModelRuntime, config, workspaceDir: workspace },
        run: <T>(run: () => T): T => run(),
        [Symbol.asyncDispose]: releaseRuntimeLease,
      });

      await runIsolatedCompletion(isolatedRequest({ config, workspaceDir: workspace }));

      expect(dispatch).toHaveBeenCalledTimes(1);
      const params = dispatch.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(params.systemPrompt).toBe("Return JSON.");
      expect(params.prompt).toBe("Do the task.");
      expect(JSON.stringify(params)).not.toContain(WORKSPACE_MARKER);
    },
  );
});
