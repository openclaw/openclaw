import { FsSafeError, root } from "../infra/fs-safe.js";
import { type createAgentIdentityConfig, mergeIdentityMarkdownContent } from "./identity-file.js";
import { DEFAULT_IDENTITY_FILENAME } from "./workspace-bootstrap-policy.js";
import { createWorkspaceFileMutationGuard } from "./workspace-file-mutation-guard.js";
import type { WorkspaceStateGuard } from "./workspace-state-store.worker-contract.js";

export async function writeIdentityFile(params: {
  workspaceDir: string;
  identity: NonNullable<ReturnType<typeof createAgentIdentityConfig>>;
  guard?: WorkspaceStateGuard;
}): Promise<void> {
  const beforeFileMutation = createWorkspaceFileMutationGuard(params.guard);
  const workspaceRoot = await root(params.workspaceDir);
  let existing: string | undefined;
  try {
    const result = await workspaceRoot.read(DEFAULT_IDENTITY_FILENAME, {
      hardlinks: "reject",
    });
    existing = result.buffer.toString("utf-8");
  } catch (error) {
    if (!(error instanceof FsSafeError && error.code === "not-found")) {
      throw error;
    }
  }
  const content = mergeIdentityMarkdownContent(existing, params.identity);
  beforeFileMutation?.();
  // Root.write rechecks after its own async preparation and before each mutation.
  await workspaceRoot.write(DEFAULT_IDENTITY_FILENAME, content, {
    encoding: "utf8",
    assertBeforeMutation: beforeFileMutation,
  });
}
