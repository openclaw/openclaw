import { getAgentScopedMediaLocalRoots } from "../../../media/local-roots.js";
import { resolveImageSanitizationLimits } from "../../image-sanitization.js";
import type { SandboxContext } from "../../sandbox/types.js";
import { materializeProviderContext } from "./images.js";
import type { ProviderContextMaterializer } from "./message-transform-stream-wrapper.js";
import { promptImageSessionKey } from "./prompt-image-decisions.js";
import type { EmbeddedRunAttemptParams } from "./types.js";

/** Builds the provider-handoff materializer that replays media for one attempt. */
export function createProviderContextMaterializer(input: {
  attempt: EmbeddedRunAttemptParams;
  workspaceDir: string;
  workspaceOnly: boolean;
  sessionAgentId: string;
  onCurrentTurnImageFailure?: (count: number) => void;
  sandbox?: SandboxContext | null;
  assertRunCurrent?: () => void;
}): ProviderContextMaterializer {
  const { attempt } = input;
  return async ({ context, signal }) => {
    input.assertRunCurrent?.();
    let localRoots: readonly string[] | undefined;
    const prepared = await materializeProviderContext({
      context,
      signal,
      imageSessionKey: promptImageSessionKey(attempt),
      workspaceDir: input.workspaceDir,
      agentWorkspaceDir: attempt.workspaceDir,
      // Provider replay resizes exactly like the prompt path; omitting this fell back
      // to the built-in 1200px default and ignored agents.defaults.imageMaxDimensionPx.
      maxDimensionPx: resolveImageSanitizationLimits(attempt.config).maxDimensionPx,
      workspaceOnly: input.workspaceOnly,
      localRoots: input.workspaceOnly
        ? undefined
        : () =>
            (localRoots ??= getAgentScopedMediaLocalRoots(
              attempt.config ?? {},
              input.sessionAgentId,
            )),
      onCurrentTurnImageFailure: input.onCurrentTurnImageFailure,
      sandbox:
        input.sandbox?.enabled && input.sandbox.fsBridge
          ? { root: input.sandbox.workspaceDir, bridge: input.sandbox.fsBridge }
          : undefined,
    });
    input.assertRunCurrent?.();
    return prepared;
  };
}
