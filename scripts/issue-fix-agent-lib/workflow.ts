import fs from "node:fs";
import path from "node:path";
import { classifyIssueCandidate, formatScanResult, sortQualifiedCandidates } from "./candidates.js";
import { classifyCheckSnapshots, normalizePrCheckRollup } from "./checks.js";
import { runCommand as defaultRunCommand, type CommandRunner } from "./command-runner.js";
import { fetchOpenIssueCandidates, fetchPrCheckRollup } from "./github.js";
import {
  createIssueFixAgentRun,
  getLatestOpenIssueFixAgentRun,
  openIssueFixAgentState,
  transitionIssueFixAgentRun,
} from "./state.sqlite.js";
import type { IssueFixAgentArgs, QualifiedCandidate, SkippedCandidate } from "./types.js";

type WorkflowParams = {
  readonly args: IssueFixAgentArgs;
  readonly out?: (line: string) => void;
  readonly runCommand?: CommandRunner;
  readonly statePath?: string;
};

function defaultStatePath(): string {
  return path.join(process.cwd(), ".openclaw", "issue-fix-agent.sqlite");
}

async function scan(runCommand: CommandRunner): Promise<{
  qualified: QualifiedCandidate[];
  skipped: SkippedCandidate[];
}> {
  const candidates = await fetchOpenIssueCandidates({ limit: 10, runCommand });
  const qualified: QualifiedCandidate[] = [];
  const skipped: SkippedCandidate[] = [];
  for (const candidate of candidates) {
    const result = classifyIssueCandidate(candidate);
    if (result.kind === "qualified") {
      qualified.push(result.candidate);
    } else {
      skipped.push(result.candidate);
    }
  }
  return { qualified: sortQualifiedCandidates(qualified), skipped };
}

export async function runIssueFixAgentCommand(params: WorkflowParams): Promise<void> {
  const out = params.out ?? ((line: string) => process.stdout.write(`${line}\n`));
  const run = params.runCommand ?? defaultRunCommand;
  if (params.args.command === "scan") {
    out(formatScanResult(await scan(run)));
    return;
  }
  if (params.args.command === "status") {
    const statePath = params.statePath ?? defaultStatePath();
    if (!fs.existsSync(statePath)) {
      out("No active issue-fix-agent run.");
      return;
    }
    const store = openIssueFixAgentState(statePath);
    try {
      const active = getLatestOpenIssueFixAgentRun(store);
      out(
        active
          ? `Active run ${active.runId}: #${active.issueNumber} ${active.state}`
          : "No active issue-fix-agent run.",
      );
    } finally {
      store.close();
    }
    return;
  }
  if (params.args.command === "monitor") {
    const rawChecks = await fetchPrCheckRollup({
      prNumber: params.args.prNumber,
      runCommand: run,
    });
    const result = classifyCheckSnapshots(normalizePrCheckRollup(rawChecks));
    out(`PR #${params.args.prNumber} checks: ${result.kind}`);
    for (const failed of result.failed) {
      out(`failed: ${failed.name} ${failed.detailsUrl ?? ""}`.trim());
    }
    for (const pending of result.pending) {
      out(`pending: ${pending.name} ${pending.detailsUrl ?? ""}`.trim());
    }
    return;
  }
  if (params.args.command === "run") {
    const result = await scan(run);
    const candidate = result.qualified[0];
    if (!candidate) {
      out(formatScanResult(result));
      out("No qualified issue-fix-agent candidates.");
      return;
    }
    const store = openIssueFixAgentState(params.statePath ?? defaultStatePath());
    try {
      const created = createIssueFixAgentRun(store, {
        issueNumber: candidate.number,
        issueTitle: candidate.title,
        issueUrl: candidate.url,
        source: "gitcrawl search",
      });
      transitionIssueFixAgentRun(store, created.runId, "qualified", {
        reason: `score=${candidate.score}; evidence=${candidate.evidence.join(", ")}`,
      });
      out(`Qualified #${candidate.number}: ${candidate.title}`);
      if (!params.args.execute) {
        out("Dry run stopped at qualified. Re-run with --execute to create a branch.");
        return;
      }
      transitionIssueFixAgentRun(store, created.runId, "claimed_local", {
        reason: "execute enabled",
      });
      out("Execution stopped before push/PR. Branch and patch automation are not enabled yet.");
    } finally {
      store.close();
    }
    return;
  }
  out(`${params.args.command} is not implemented yet.`);
}
