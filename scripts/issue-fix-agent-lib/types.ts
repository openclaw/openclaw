export type IssueFixAgentCommand = "scan" | "run" | "resume" | "status" | "monitor" | "gc";

export type IssueFixAgentArgs =
  | {
      command: "scan" | "run" | "resume" | "status";
      execute: boolean;
      pushPr: boolean;
      yes: boolean;
    }
  | {
      command: "monitor";
      execute: boolean;
      prNumber: number;
      pushPr: boolean;
      yes: boolean;
    }
  | {
      command: "gc";
      dryRun: boolean;
      execute: boolean;
      pushPr: boolean;
      yes: boolean;
    };

export type IssueFixAgentState =
  | "discovered"
  | "qualified"
  | "claimed_local"
  | "branch_created"
  | "patching"
  | "verifying"
  | "committed"
  | "pr_opened"
  | "monitoring"
  | "land_ready"
  | "blocked";

export type IssueCandidate = {
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly body: string;
  readonly labels: readonly string[];
  readonly author: string;
  readonly updatedAt: string;
  readonly isPullRequest: boolean;
};

export type QualifiedCandidate = IssueCandidate & {
  readonly score: number;
  readonly evidence: readonly string[];
};

export type SkippedCandidate = IssueCandidate & {
  readonly reason: string;
};

export type IssueFixAgentRun = {
  readonly runId: string;
  readonly issueNumber: number;
  readonly issueTitle: string;
  readonly issueUrl: string;
  readonly source: string;
  readonly state: IssueFixAgentState;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly branchName: string | null;
  readonly worktreePath: string | null;
  readonly commitSha: string | null;
  readonly prNumber: number | null;
  readonly prUrl: string | null;
  readonly terminalReason: string | null;
};
