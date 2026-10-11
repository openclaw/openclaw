import { CronReceiptAuthorityRefusal } from "../cron/store/receipt-authority-error.js";
import type { CronReceiptAuthorityUse } from "../cron/store/receipt-authority-owner.js";
import { buildCronExecOperationBinding } from "../gateway/operator-approval-standing-grants.js";
import type {
  ConsumeCronStandingGrantResult,
  CronStandingGrantRecord,
} from "../gateway/operator-approval-standing-grants.types.js";
import {
  consumeCronStandingGrant,
  validateCronStandingGrant,
} from "../gateway/operator-approval-store.js";
import { lookupCronRunExecSource, type CronRunExecSource } from "../infra/cron-run-exec-source.js";
import { prepareCronExecHostPolicyUse } from "../infra/exec-approvals-cron-policy.js";
import type { ProcessGatewayAllowlistParams } from "./bash-tools.exec-host-gateway.types.js";

/** Consumption accounts once; the receipt owner retains authority through native initiation. */
export async function prepareCronStandingGrantConsumption(
  params: Pick<
    ProcessGatewayAllowlistParams,
    "runId" | "command" | "workdir" | "requestedEnv" | "bypassHostApprovalFloors"
  >,
  source: CronRunExecSource,
  hostPolicy: Pick<Parameters<typeof prepareCronExecHostPolicyUse>[1], "security" | "ask">,
) {
  const authority = source.standingGrantAuthority;
  if (!authority || !params.runId) {
    return undefined;
  }
  const runId = params.runId;
  const { context } = authority;
  const lookup = {
    agentId: source.agentId,
    cronJobId: source.jobId,
    jobConfigRevision: source.jobConfigRevision,
    operationBinding: buildCronExecOperationBinding({
      command: params.command,
      cwd: params.workdir,
      env: params.requestedEnv,
    }),
    handle: { ...authority.handle },
  };
  const policy = await prepareCronExecHostPolicyUse(context, {
    ...hostPolicy,
    agentId: source.agentId,
    bypassHostApprovalFloors: params.bypassHostApprovalFloors,
  });
  const assertOccurrence = () => {
    if (lookupCronRunExecSource(runId) !== source) {
      throw new CronReceiptAuthorityRefusal("retired");
    }
    authority.assertCurrent();
    policy.assertCurrent();
  };
  let initial: ConsumeCronStandingGrantResult;
  try {
    assertOccurrence();
    initial = await validateCronStandingGrant({
      ...lookup,
      databaseOptions: { path: context.admission.databasePath, env: context.environment },
      assertCurrent: assertOccurrence,
    });
    assertOccurrence();
  } catch (error) {
    policy.release();
    throw error;
  }
  if (initial.outcome !== "consumed") {
    policy.release();
    return undefined;
  }
  const expectedGrant = {
    grantId: initial.grant.grantId,
    mintedByApprovalId: initial.grant.mintedByApprovalId,
  };
  let consumed: CronStandingGrantRecord | undefined;
  let terminal = false;
  let use: CronReceiptAuthorityUse | undefined;
  const releaseSpawn = (reason?: "retry") => {
    use?.release();
    use = undefined;
    if (reason !== "retry") {
      terminal = true;
      policy.release();
    }
  };
  const assertCurrent = () => {
    if (terminal || !use) {
      throw new Error("Cron standing-grant launch interval is no longer active");
    }
    use.assertCurrent();
  };
  return {
    assertCurrent,
    releaseSpawn,
    initiateSpawn<T>(this: void, launch: () => T, settlement?: Promise<unknown>): T {
      assertCurrent();
      try {
        return use!.initiate(() => policy.initiate(launch, settlement), settlement);
      } finally {
        releaseSpawn();
      }
    },
    async consume(this: void, signal?: AbortSignal): Promise<ConsumeCronStandingGrantResult> {
      if (terminal) {
        throw new Error("Cron standing-grant launch cannot be replayed");
      }
      releaseSpawn("retry");
      try {
        const assertAttempt = () => {
          assertOccurrence();
          signal?.throwIfAborted();
          if (consumed?.expiresAtMs != null && consumed.expiresAtMs <= Date.now()) {
            throw new Error("Cron standing grant expired before launch");
          }
        };
        const result = await consumeCronStandingGrant(
          context,
          { ...lookup, expectedGrant, recordUse: consumed === undefined },
          assertAttempt,
          async (run) => {
            use = await authority.acquireUse(assertAttempt, signal);
            return use.mutate(run);
          },
        );
        if (result.outcome !== "consumed") {
          releaseSpawn();
          return result;
        }
        consumed = result.grant;
        assertCurrent();
        return result;
      } catch (error) {
        releaseSpawn();
        throw error;
      }
    },
  };
}
