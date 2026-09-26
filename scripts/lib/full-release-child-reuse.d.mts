export interface ReusableReleaseChildRequest {
  repository: string;
  targetSha: string;
  role: string;
  inputs: Record<string, string | boolean | number>;
  /** Exclude children dispatched by this parent run. */
  excludeRunId?: string;
}

export interface ReusableReleaseChildSelection {
  repository: string;
  targetSha: string;
  role: string;
  runId: string;
  runAttempt: number;
  workflowSha: string;
  workflowRef: string;
  displayTitle: string;
  sourceParentRunId: string;
  sourceParentAttempt: number;
  url: string;
  artifact: {
    id: string;
    name: string;
    digest: string;
    expiresAt: string;
    sizeInBytes: number;
  };
  receiptSha256: string;
  inputs: Record<string, string>;
}

export interface ReusableReleaseChildDependencies {
  github?: (endpoint: string) => Promise<unknown>;
  downloadArchive?: (input: Record<string, unknown>) => Promise<{
    artifactMetadata: unknown;
    archiveBytes: Uint8Array;
  }>;
  now?: number;
  deadlineMs?: number;
  token?: string;
}

export function discoverReusableReleaseChild(
  request: ReusableReleaseChildRequest,
  deps?: ReusableReleaseChildDependencies,
): Promise<ReusableReleaseChildSelection | null>;

export function validateReusableReleaseChild(
  selection: unknown,
  request: ReusableReleaseChildRequest,
  deps?: ReusableReleaseChildDependencies,
): Promise<{
  selection: ReusableReleaseChildSelection;
  receipt: Record<string, unknown>;
  run: Record<string, unknown>;
  jobs: Record<string, unknown>[];
}>;
