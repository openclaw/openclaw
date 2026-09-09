import {
  PreparedModelRuntimeOwnerNotPublishedError,
  normalizePreparedModelRuntimeInput,
  preparedModelRuntimeConfigsMatch,
  resolvePublishedOwner,
} from "./prepared-model-runtime.owner.js";
import type {
  PreparedModelRuntimeInput,
  PreparedModelRuntimeOwner,
  PreparedModelRuntimeReplacement,
  PreparedModelRuntimeSnapshot,
} from "./prepared-model-runtime.types.js";

type PublishedModelRuntimeContext = {
  captureLifetime(): () => void;
  getPendingReplacement(): PreparedModelRuntimeReplacement | undefined;
  owners: Map<string, PreparedModelRuntimeOwner>;
};

/** Project or retain the exact published owner before its snapshot crosses an await. */
export async function projectPublishedModelRuntimeOwner<T>(
  rawInput: PreparedModelRuntimeInput,
  context: PublishedModelRuntimeContext,
  project: (owner: PreparedModelRuntimeOwner, snapshot: PreparedModelRuntimeSnapshot) => T,
): Promise<T> {
  const assertLifetime = context.captureLifetime();
  const replacement = context.getPendingReplacement();
  if (replacement) {
    // Individual owners may finish before a multi-owner publication commits. The lifecycle gate
    // makes the generation visible atomically only after every owner and auth mutation is ready.
    await replacement.promise;
    assertLifetime();
    return await projectPublishedModelRuntimeOwner(rawInput, context, project);
  }
  const input = normalizePreparedModelRuntimeInput(rawInput);
  const existing = resolvePublishedOwner(context.owners, input, {
    allowConfiguredWorkspaceFallback:
      rawInput.workspaceDir === undefined ||
      rawInput.agentId === undefined ||
      rawInput.runtimePluginSelections === undefined,
  });
  if (
    input.readOnly &&
    existing &&
    !preparedModelRuntimeConfigsMatch(existing.input.config, input.config)
  ) {
    throw new PreparedModelRuntimeOwnerNotPublishedError(
      `prepared read-only model runtime owner was not published for the requested config (${input.agentDir})`,
    );
  }
  // Generated catalogs are lifecycle artifacts, not a live-edit surface. Config/plugin reload,
  // doctor/auth repair, and auth publication replace owners; external edits require restart.
  if (existing?.pending) {
    try {
      await existing.pending;
    } catch {
      // Re-read the owner below so a superseding generation wins over this result or error.
    }
    assertLifetime();
    return await projectPublishedModelRuntimeOwner(rawInput, context, project);
  }
  if (existing?.needsRefresh) {
    throw existing.refreshError ?? new Error("prepared model runtime refresh is pending");
  }
  if (existing?.snapshot) {
    return project(existing, existing.snapshot);
  }
  throw new PreparedModelRuntimeOwnerNotPublishedError(
    `prepared model runtime owner was not published for ${input.agentDir}`,
  );
}
