import { captureOpenClawStateWorkerContext } from "../../../state/openclaw-state-worker-context.js";
import { prepareRequesterCronAuthority } from "../requester-cron-authority.js";
import {
  assertSubagentRegistryWriteSourceCurrent,
  captureSubagentRunMutationSnapshot,
  publishSubagentRunPostimages,
  SubagentRegistryWriteError,
} from "./subagent-registry-persistence.js";
import {
  markRequesterTurnYieldedInRuns,
  type RequesterInitialTransfer,
} from "./subagent-registry-requester-yield.js";
import { persistSubagentRunsToDiskAsyncOrThrow } from "./subagent-registry-state.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

/** Unit persistence faults use the real staging/publication owner; registered tests use SQLite. */
export function createRequesterInitialTransferFixture(
  runs: Map<string, SubagentRunRecord>,
  persistOrThrow?: (...runIds: string[]) => void,
): RequesterInitialTransfer {
  return async ({
    entries,
    alreadyPublished,
    prepare,
    assertHandoffCurrent,
    mutate,
    retire,
    finish,
    release,
    afterRelease,
  }) => {
    const context = captureOpenClawStateWorkerContext();
    const write = async (applyMutation: () => void) => {
      const previous = new Map(
        entries.map((entry) => [entry, captureSubagentRunMutationSnapshot(entry)] as const),
      );
      assertSubagentRegistryWriteSourceCurrent(context);
      applyMutation();
      await publishSubagentRunPostimages({
        runs,
        previous,
        retire,
        context,
        assertCurrent: () => assertSubagentRegistryWriteSourceCurrent(context),
        persist: persistOrThrow
          ? async (_context, publication, ...runIds) => {
              publication.assertCurrent();
              try {
                persistOrThrow(...runIds);
              } catch (error) {
                throw new SubagentRegistryWriteError("not-committed", error);
              }
              await Promise.resolve();
              publication.onCommitted?.();
            }
          : (writeContext, callbacks, ...runIds) =>
              persistSubagentRunsToDiskAsyncOrThrow(runs, runIds, {
                context: writeContext,
                ...callbacks,
              }),
      });
    };
    await prepare?.();
    if (!alreadyPublished) {
      await write(mutate);
    }
    assertHandoffCurrent();
    finish();
    if (release) {
      await write(release);
    }
    afterRelease?.();
  };
}

/** Mirrors the lifecycle controller: prepare requester cron authority, mark, then release. */
export async function markRequesterTurnYieldedWithAuthority(
  params: Omit<Parameters<typeof markRequesterTurnYieldedInRuns>[0], "preparedAuthority">,
): Promise<number> {
  const preparedAuthority = prepareRequesterCronAuthority(params);
  try {
    return await markRequesterTurnYieldedInRuns({
      ...params,
      preparedAuthority: preparedAuthority ?? null,
    });
  } finally {
    await preparedAuthority?.release();
  }
}
