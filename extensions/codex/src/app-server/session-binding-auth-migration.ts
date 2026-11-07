import type {
  CodexAppServerBindingIdentity,
  StoredCodexAppServerBinding,
} from "./session-binding-record.js";

export type CodexAuthProfileMigrationMutation = {
  kind: "clear-auth-profile";
  threadId: string;
  clientId: string | undefined;
  expectedAuthProfileId: string;
  dryRun: boolean;
};

/** Called inside the binding owner's lease-aware compare-and-apply transaction. */
export function migrateCodexBindingAuthProfile(
  identity: CodexAppServerBindingIdentity,
  current: StoredCodexAppServerBinding | undefined,
  mutation: CodexAuthProfileMigrationMutation,
): { result: boolean; next?: StoredCodexAppServerBinding } {
  if (
    identity.kind !== "session" ||
    !identity.sessionKey ||
    current?.state !== "active" ||
    current.sessionId !== identity.sessionId ||
    current.binding.threadId !== mutation.threadId ||
    current.binding.clientId !== mutation.clientId ||
    current.binding.connectionScope === "supervision" ||
    current.binding.pendingSupervisionBranch ||
    current.nativeSubagentAssignments !== undefined ||
    current.nativeSubagentSubmissions !== undefined ||
    (current.binding.authProfileId !== undefined &&
      current.binding.authProfileId !== mutation.expectedAuthProfileId)
  ) {
    return { result: false };
  }
  if (mutation.dryRun || current.binding.authProfileId === undefined) {
    return { result: true };
  }
  // Retain native thread, history cursor, generation and task imports. Ordinary
  // auth selection stays fail-closed; only this explicit operator operation clears it.
  const binding = { ...current.binding };
  delete binding.authProfileId;
  return { result: true, next: { ...current, binding } };
}
