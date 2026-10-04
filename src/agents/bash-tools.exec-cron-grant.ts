import { withCronReceiptAuthorityMutation } from "../cron/store/receipt-authority-owner.js";
import {
  consumeCronStandingGrant,
  validateCronStandingGrant,
} from "../gateway/operator-approval-standing-grants.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";

/** Retain the lookup's physical source through each existing consumption attempt. */
export function prepareCronStandingGrantConsumption(
  params: Omit<Parameters<typeof validateCronStandingGrant>[0], "databaseOptions">,
) {
  const context = captureOpenClawStateWorkerContext();
  const lookup = {
    ...params,
    databaseOptions: { path: context.admission.databasePath, env: context.environment },
  };
  if (validateCronStandingGrant(lookup).outcome !== "consumed") {
    return undefined;
  }
  return (signal?: AbortSignal) =>
    withCronReceiptAuthorityMutation(context, async (mutation) =>
      consumeCronStandingGrant(lookup, {
        assertCurrent() {
          mutation.assertCurrent();
          signal?.throwIfAborted();
        },
        onCommitted: () => mutation.publish({ nonce: mutation.attachment.nonce, sequence: 1 }),
      }),
    );
}
