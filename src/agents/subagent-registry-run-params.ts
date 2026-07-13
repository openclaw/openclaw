import type { DeliveryContext } from "../utils/delivery-context.types.js";
import type { SubagentAnnounceTarget } from "./subagent-announce-target.js";

export type RegisterSubagentRunParams = {
  runId: string;
  childSessionKey: string;
  controllerSessionKey?: string;
  requesterSessionKey: string;
  requesterOrigin?: DeliveryContext;
  requesterDisplayKey: string;
  task: string;
  taskName?: string;
  agentId?: string;
  requesterAgentId?: string;
  cleanup: "delete" | "keep";
  label?: string;
  model?: string;
  agentDir?: string;
  workspaceDir?: string;
  runTimeoutSeconds?: number;
  expectsCompletionMessage?: boolean;
  announceTarget?: SubagentAnnounceTarget;
  spawnMode?: "run" | "session";
  attachmentsDir?: string;
  attachmentsRootDir?: string;
  retainAttachmentsOnKeep?: boolean;
};
