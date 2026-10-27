import { captureOpenClawStateWorkerContext } from "../../../state/openclaw-state-worker-context.js";
import { prepareRequesterCronAuthority } from "../requester-cron-authority.js";
import {
  commitRequesterTransfer,
  markRequesterTurnYieldedInRuns,
  type RequesterInitialTransfer,
} from "./subagent-registry-requester-yield.js";
import { saveSubagentRegistryChangesToSqlite } from "./subagent-registry-state.fixture.test-support.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

/** Seed SQLite, then exercise the real single-write transfer and admitted worker mutation owners. */
export function createRequesterInitialTransferFixture(
  runs: Map<string, SubagentRunRecord>,
  beforeWrite?: (...runIds: string[]) => void,
  options: { assertCurrent?: () => void } = {},
): RequesterInitialTransfer {
  return async (params) => {
    saveSubagentRegistryChangesToSqlite(runs, [...runs.keys()]);
    await commitRequesterTransfer(
      {
        ...params,
        mutate: (entries) => {
          const retired = params.mutate(entries);
          beforeWrite?.(...entries.map((entry) => entry.runId));
          return retired;
        },
      },
      {
        runs,
        stateContext: captureOpenClawStateWorkerContext(),
        assertCurrent: options.assertCurrent ?? (() => {}),
      },
    );
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
