import {
  bindMessageInjectionAdmission,
  createLegacyMessageInjectionAuthority,
} from "../../auto-reply/reply/message-injection-authority.js";
import type {
  ReplyBackendHandle,
  ReplyBackendMessageInjection,
  ReplyBackendMessageInjectionV2,
  ReplyToolAuthorityPreparation,
} from "../../auto-reply/reply/reply-run-registry.contracts.js";
import { withSessionEntriesFromStoresInWorker } from "../../config/sessions/session-entry-read-runtime.js";
import {
  capturePreparedToolAuthorityReads,
  type PreparedToolAuthorityRead,
} from "./host-private-capabilities.js";

/** Keep receipt reads out of the compatibility guards shared with question grants. */
export function assertLegacyPreparedToolAuthority(
  preparation: ReplyToolAuthorityPreparation,
  reads: readonly PreparedToolAuthorityRead[],
): void {
  preparation.assertCurrent();
  preparation.compatAssertCurrent();
  for (const read of reads) {
    read.assertLegacyCurrent();
  }
  preparation.assertCurrent();
}

/** Capture while the caller holds FIFO custody; check again at the legacy sink invocation. */
export function createLegacyToolAuthorityQueuePreflight(
  preparation: ReplyToolAuthorityPreparation,
) {
  let reads: PreparedToolAuthorityRead[] | undefined;
  return {
    prepareQueueMessage: async () => {
      reads = (await capturePreparedToolAuthorityReads(preparation)).reads;
    },
    assertQueueCurrent: () => {
      if (!reads) {
        throw new Error("Legacy message injection requires tool-authority preparation");
      }
      assertLegacyPreparedToolAuthority(preparation, reads);
    },
  };
}

export function bindMessageInjectionV2(
  guarded: ReplyBackendMessageInjectionV2,
  assertCurrent: () => void,
  authorityKind: "run" | "source-bound",
  getPreparation?: () => ReplyToolAuthorityPreparation,
  legacy?: ReturnType<typeof createLegacyToolAuthorityQueuePreflight>,
): Pick<ReplyBackendMessageInjection, "queueMessage"> &
  Pick<ReplyBackendHandle, "claimPendingUserInputAnswer" | "cancelPendingUserInput"> & {
    prepareQueueMessage?: () => Promise<void>;
  } {
  const assertFinalCurrent = legacy
    ? createLegacyMessageInjectionAuthority(assertCurrent, legacy.assertQueueCurrent)
    : assertCurrent;
  return {
    prepareQueueMessage: legacy?.prepareQueueMessage,
    queueMessage: (text, options) => {
      if (getPreparation && guarded.queueMessageAsync) {
        return guarded.queueMessageAsync(text, options, getPreparation(), authorityKind);
      }
      legacy?.assertQueueCurrent();
      return guarded.queueMessage(text, options, assertFinalCurrent, authorityKind);
    },
    claimPendingUserInputAnswer:
      getPreparation && guarded.claimPendingUserInputAnswerAsync
        ? (text, options) =>
            guarded.claimPendingUserInputAnswerAsync!(
              text,
              options,
              getPreparation(),
              authorityKind,
            )
        : guarded.claimPendingUserInputAnswer
          ? (text, options) =>
              guarded.claimPendingUserInputAnswer!(text, options, assertCurrent, authorityKind)
          : undefined,
    cancelPendingUserInput:
      getPreparation && guarded.cancelPendingUserInputAsync
        ? (resolvedBy) =>
            guarded.cancelPendingUserInputAsync!(resolvedBy, getPreparation(), authorityKind)
        : guarded.cancelPendingUserInput
          ? (resolvedBy) =>
              guarded.cancelPendingUserInput!(resolvedBy, assertCurrent, authorityKind)
          : undefined,
  };
}

/** Bind the complete preparation to its synchronous effect, including reads added by wrappers. */
export function bindPreparedToolAuthority<T extends ReplyToolAuthorityPreparation>(
  preparation: T,
): T {
  bindMessageInjectionAdmission(preparation.prepareCurrent, async (consume) => {
    const captured = await capturePreparedToolAuthorityReads(preparation);
    if (captured.assertCompatibility) {
      // An incomplete reader contract keeps its full synchronous compatibility
      // boundary outside worker admission, where legacy SQL remains valid.
      assertLegacyPreparedToolAuthority(preparation, captured.reads);
      return consume();
    }
    return withSessionEntriesFromStoresInWorker(
      captured.reads.flatMap((read) => read.reads),
      (reads) => {
        preparation.assertCurrent();
        let offset = 0;
        for (const read of captured.reads) {
          read.assertPrepared(reads.slice(offset, offset + read.reads.length));
          offset += read.reads.length;
        }
        preparation.assertCurrent();
        return consume();
      },
      { ordered: true },
    );
  });
  return preparation;
}
