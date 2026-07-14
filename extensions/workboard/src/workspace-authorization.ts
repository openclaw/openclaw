import type { WorkboardWorkspace } from "./types.js";

export type WorkboardWorkspaceMutationAuthorization = "operator.admin" | undefined;

export function resolveManagedWorktreeSourceAuthorization(
  client: unknown,
): WorkboardWorkspaceMutationAuthorization {
  const scopes = (client as { connect?: { scopes?: unknown } } | undefined)?.connect?.scopes;
  return Array.isArray(scopes) && scopes.includes("operator.admin") ? "operator.admin" : undefined;
}

function managedWorktreeSource(workspace: WorkboardWorkspace | undefined): string | undefined {
  return workspace?.kind === "worktree" ? (workspace.sourcePath ?? workspace.path) : undefined;
}

export function assertManagedWorktreeSourceMutationAllowed(
  previous: WorkboardWorkspace | undefined,
  next: WorkboardWorkspace | undefined,
  authorization: WorkboardWorkspaceMutationAuthorization,
): void {
  const previousSource = managedWorktreeSource(previous);
  const nextSource = managedWorktreeSource(next);
  const introducesSource =
    nextSource !== undefined && (previous?.kind !== "worktree" || previousSource !== nextSource);
  // The stored source is later consumed by an admin-only worktree operation.
  // Reject planting or replacing it unless this mutation carries the same authority.
  if (introducesSource && authorization !== "operator.admin") {
    throw new Error("managed worktree source changes require operator.admin.");
  }
}
