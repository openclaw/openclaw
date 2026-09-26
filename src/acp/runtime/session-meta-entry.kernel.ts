import type { SessionEntry } from "../../config/sessions/types.js";
import {
  matchesAcpSessionControlBinding,
  type AcpSessionControlBinding,
} from "./session-control-owner.js";

export type AcpSessionEntryExpectation = Pick<
  SessionEntry,
  "sessionId" | "lifecycleRevision" | "sessionStartedAt"
> | null;

/** A fresh row may change metadata, but cannot replace the lifecycle or cleanup target. */
export function assertAcpSessionMutationEntry(
  entry: SessionEntry | undefined,
  expected: AcpSessionEntryExpectation,
  control: AcpSessionControlBinding | undefined,
  phase: "entry mutation" | "metadata preparation" | "legacy source consumption",
): void {
  const matches =
    expected === null
      ? entry === undefined
      : entry !== undefined &&
        entry.sessionId === expected.sessionId &&
        entry.lifecycleRevision === expected.lifecycleRevision &&
        (expected.lifecycleRevision !== undefined ||
          entry.sessionStartedAt === expected.sessionStartedAt);
  if (!matches || (control && !matchesAcpSessionControlBinding(entry, control))) {
    throw new Error(`Canonical ACP session changed before ${phase}.`);
  }
}
