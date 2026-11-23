import type { CommonWorkRecord, WorkboardLaunchState } from "@openclaw/workboard-contract";

export type NormalizeMetadataOptions = {
  allowDependencyLinks?: boolean;
  allowArchivedAt?: boolean;
  automationLaunch?: WorkboardLaunchState;
  preserveProofId?: string;
  preserveNotificationId?: string;
  commonWork?: CommonWorkRecord;
};
