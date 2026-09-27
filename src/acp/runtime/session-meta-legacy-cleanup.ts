import { patchSessionEntryWithKey } from "../../config/sessions/session-accessor.js";
import type { AcpSessionControlBinding } from "./session-control-owner.js";
import {
  assertAcpSessionMutationEntry,
  type AcpSessionEntryExpectation,
} from "./session-meta-entry.kernel.js";

export async function clearLegacyEmbeddedAcpMetadata(params: {
  storePath: string;
  assertCommitAllowed?: () => void;
  agentId?: string;
  expectedEntry?: AcpSessionEntryExpectation;
  expectedControlBinding?: AcpSessionControlBinding;
  sessionKeys: Iterable<string | null | undefined>;
}): Promise<void> {
  const sessionKeys = new Set(
    Array.from(params.sessionKeys, (sessionKey) => sessionKey?.trim()).filter(
      (sessionKey): sessionKey is string => Boolean(sessionKey),
    ),
  );
  for (const sessionKey of sessionKeys) {
    const patched = await patchSessionEntryWithKey(
      { storePath: params.storePath, agentId: params.agentId, sessionKey },
      (entry, context) => {
        if (params.expectedEntry !== undefined) {
          assertAcpSessionMutationEntry(
            context.existingEntry,
            params.expectedEntry,
            params.expectedControlBinding,
            "entry mutation",
          );
        }
        if (!entry.acp) {
          return null;
        }
        const next = { ...entry };
        delete next.acp;
        return next;
      },
      {
        replaceEntry: true,
        skipMaintenance: true,
        assertCommitAllowed: params.assertCommitAllowed,
      },
    );
    if (!patched && params.expectedEntry !== undefined) {
      assertAcpSessionMutationEntry(
        undefined,
        params.expectedEntry,
        params.expectedControlBinding,
        "entry mutation",
      );
    }
  }
}
