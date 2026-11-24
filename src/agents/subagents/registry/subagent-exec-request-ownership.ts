import type { ExecRequestIdentity, ExecRequestOwner } from "../../../infra/exec-request-context.js";
import type { SessionGeneration } from "../../../sessions/session-notice.js";
import type { ResolvedSubagentController } from "./subagent-control.types.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";
import { getSubagentRunRuntimeKey } from "./subagent-run-generation.js";

type ControllerIdentity = Pick<
  ResolvedSubagentController,
  "controllerSessionKey" | "controllerAgentId"
>;

export type SubagentRequestSessionOrigin = {
  /** The requester transcript an abort selected; a kill holds it with a transcript lease. */
  target: Readonly<SessionGeneration>;
  acceptsRequest: (identity: Readonly<ExecRequestIdentity>) => boolean;
};

const requestBindings = new WeakMap<
  object,
  { owners: readonly ExecRequestOwner[]; controller: ControllerIdentity }
>();

/** Registration publishes this relationship; IDs alone cannot reconstruct it later. */
export function bindSubagentExecRequestOwners(
  entry: SubagentRunRecord,
  owners: readonly ExecRequestOwner[] | undefined,
  controller: ControllerIdentity,
): void {
  const requesterTurnRunId = entry.requesterTurnRunId;
  const selected = requesterTurnRunId
    ? owners?.filter((owner) => owner.turnRunIds.has(requesterTurnRunId))
    : undefined;
  if (!selected?.length) {
    return;
  }
  requestBindings.set(getSubagentRunRuntimeKey(entry), {
    owners: selected,
    controller: { ...controller },
  });
}

/** Selection supplies current request custody or a freshly authorized session origin. */
export function readSubagentExecRequestController(
  entry: SubagentRunRecord,
  acceptsOwner: (owner: ExecRequestOwner) => boolean,
): ControllerIdentity | undefined {
  const binding = requestBindings.get(getSubagentRunRuntimeKey(entry));
  return binding?.owners.some(acceptsOwner) ? binding.controller : undefined;
}
