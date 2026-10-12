import { withClaimingHookAdmission } from "../../plugins/hook-claim-admission.js";
import { getGlobalHookRunner } from "../../plugins/hook-runner-global.js";
import { withPluginRuntimeGenerationScope } from "../../plugins/runtime/generation-scope.js";
import {
  getPreparedModelRuntimeBorrowedSnapshot,
  getPreparedModelRuntimePluginGeneration,
} from "../prepared-model-runtime-generation-scope.js";
import { prepareAgentPromptProjects } from "../prompt-projects.js";
import type {
  EmbeddedAgentRunEntryParams,
  ResolvedRunEntryModelSelection,
} from "./run-entry.types.js";
import { buildBeforeModelResolveAttachments, resolveHookModelSelection } from "./run/setup.js";
import type { EmbeddedAgentRunResult } from "./types.js";

/** Resolve run routing in the retained plugin generation, before candidate preparation. */
export async function resolveRunEntryModelSelection(
  params: Pick<
    EmbeddedAgentRunEntryParams<EmbeddedAgentRunResult>,
    "modelResolve" | "selection" | "identity"
  > & { workspaceDir: string; assertCurrent: () => void },
): Promise<ResolvedRunEntryModelSelection | undefined> {
  const input = params.modelResolve;
  if (!input || input.modelSelectionLocked) {
    return undefined;
  }
  const generation = getPreparedModelRuntimePluginGeneration();
  const snapshot = generation ? getPreparedModelRuntimeBorrowedSnapshot(generation) : undefined;
  const resolve = async () => {
    const hookRunner = getGlobalHookRunner();
    if (!hookRunner?.hasHooks("before_model_resolve")) {
      return undefined;
    }
    params.assertCurrent();
    const projects = await prepareAgentPromptProjects({
      config: snapshot?.config ?? params.selection.cfg,
      workspaceDir: params.workspaceDir,
      cwd: input.cwd,
      sessionId: params.identity.sessionId,
    });
    params.assertCurrent();
    return resolveHookModelSelection({
      prompt: input.prompt,
      attachments: buildBeforeModelResolveAttachments(input.images),
      provider: params.selection.provider,
      modelId: params.selection.model,
      hookRunner,
      hookContext: withClaimingHookAdmission(
        {
          ...input.context,
          ...params.identity,
          workspaceDir: params.workspaceDir,
          activeProjectKeys: [...projects.activeProjectKeys],
          modelProviderId: params.selection.provider,
          modelId: params.selection.model,
        },
        { assertCurrent: params.assertCurrent },
      ),
    });
  };
  return snapshot ? withPluginRuntimeGenerationScope(snapshot, resolve) : resolve();
}
