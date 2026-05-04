export type CoordinationCleanupEvidence = {
  lock?: {
    existsAfterRun: boolean;
    path?: string;
    ownerPid?: number | null;
    details?: string;
  };
  processLineage?: {
    safeProbePid?: number;
    rootChildPid?: number;
    processGroupId?: number;
    remainingDescendants?: Array<{
      pid: number;
      ppid?: number;
      command?: string;
      args?: string[];
      lineageTiedToProof: boolean | "unknown";
    }>;
  };
  observedProcesses?: Array<{
    pid: number;
    ppid?: number;
    command?: string;
    args?: string[];
    type?:
      | "openclaw"
      | "mcp_remote"
      | "zapier"
      | "slack_runtime"
      | "slack_desktop"
      | "localhost_listener"
      | "unknown";
    lineageTiedToProof: boolean | "unknown";
  }>;
};

export type CoordinationCleanupFinding = {
  status: "pass" | "fail" | "blocked";
  category:
    | "lock"
    | "openclaw_child"
    | "mcp_remote"
    | "zapier"
    | "slack_runtime"
    | "unrelated_resident_process"
    | "ambiguous_lineage";
  pid?: number;
  command?: string;
  reason: string;
};

export type CoordinationCleanupVerificationResult = {
  status: "pass" | "fail" | "blocked";
  noStaleLock: boolean | "unknown";
  noOrphanOpenClawChildren: boolean | "unknown";
  noProofTiedMcpRemote: boolean | "unknown";
  noProofTiedZapierProcess: boolean | "unknown";
  noProofTiedSlackRuntime: boolean | "unknown";
  findings: CoordinationCleanupFinding[];
  classificationReason: string;
};

export function verifyCoordinationCleanup(
  input: CoordinationCleanupEvidence,
): CoordinationCleanupVerificationResult {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return blockedResult({
      noStaleLock: "unknown",
      noOrphanOpenClawChildren: "unknown",
      noProofTiedMcpRemote: "unknown",
      noProofTiedZapierProcess: "unknown",
      noProofTiedSlackRuntime: "unknown",
      findings: [
        {
          status: "blocked",
          category: "ambiguous_lineage",
          reason: "Cleanup evidence is missing or malformed",
        },
      ],
      classificationReason: "Cleanup evidence is missing or malformed",
    });
  }

  const findings: CoordinationCleanupFinding[] = [];

  if (!input.lock) {
    return blockedResult({
      noStaleLock: "unknown",
      noOrphanOpenClawChildren: "unknown",
      noProofTiedMcpRemote: "unknown",
      noProofTiedZapierProcess: "unknown",
      noProofTiedSlackRuntime: "unknown",
      findings: [
        {
          status: "blocked",
          category: "lock",
          reason: "Lock state is missing",
        },
      ],
      classificationReason: "Lock state is missing",
    });
  }

  const noStaleLock = !input.lock.existsAfterRun;
  if (!noStaleLock) {
    findings.push({
      status: "fail",
      category: "lock",
      reason: `Stale lock remains after run${input.lock.path ? ` at ${input.lock.path}` : ""}`,
    });
  } else {
    findings.push({
      status: "pass",
      category: "lock",
      reason: "No stale lock remained after the run",
    });
  }

  if (!input.processLineage || !Array.isArray(input.processLineage.remainingDescendants)) {
    return blockedResult({
      noStaleLock,
      noOrphanOpenClawChildren: "unknown",
      noProofTiedMcpRemote: "unknown",
      noProofTiedZapierProcess: "unknown",
      noProofTiedSlackRuntime: "unknown",
      findings: [
        ...findings,
        {
          status: "blocked",
          category: "ambiguous_lineage",
          reason: "Process lineage evidence is missing or incomplete",
        },
      ],
      classificationReason: "Process lineage evidence is missing or incomplete",
    });
  }

  const descendants = input.processLineage.remainingDescendants;
  const observedProcesses = Array.isArray(input.observedProcesses) ? input.observedProcesses : [];

  const orphanOpenClawFailures: CoordinationCleanupFinding[] = [];
  const blockedFindings: CoordinationCleanupFinding[] = [];
  const mcpRemoteFailures: CoordinationCleanupFinding[] = [];
  const zapierFailures: CoordinationCleanupFinding[] = [];
  const slackRuntimeFailures: CoordinationCleanupFinding[] = [];
  const residentPassFindings: CoordinationCleanupFinding[] = [];

  for (const descendant of descendants) {
    const text = buildProcessText(descendant.command, descendant.args);
    if (descendant.lineageTiedToProof === true && looksLikeOpenClawChild(text)) {
      orphanOpenClawFailures.push({
        status: "fail",
        category: "openclaw_child",
        pid: descendant.pid,
        command: descendant.command,
        reason: "A proof-tied OpenClaw child remained after the run",
      });
    } else if (descendant.lineageTiedToProof === "unknown" && looksPotentiallyRelevant(text)) {
      blockedFindings.push({
        status: "blocked",
        category: "ambiguous_lineage",
        pid: descendant.pid,
        command: descendant.command,
        reason: "A remaining descendant could plausibly be proof-tied, but lineage is ambiguous",
      });
    }
  }

  for (const proc of observedProcesses) {
    const text = buildProcessText(proc.command, proc.args);
    const inferredType = classifyObservedProcess(proc.type, text);

    if (proc.lineageTiedToProof === false) {
      if (inferredType === "slack_desktop" || inferredType === "localhost_listener") {
        residentPassFindings.push({
          status: "pass",
          category: "unrelated_resident_process",
          pid: proc.pid,
          command: proc.command,
          reason: "Resident process is explicitly not tied to this proof",
        });
      }
      continue;
    }

    if (proc.lineageTiedToProof === "unknown" && isPotentiallyFailingType(inferredType, text)) {
      blockedFindings.push({
        status: "blocked",
        category: "ambiguous_lineage",
        pid: proc.pid,
        command: proc.command,
        reason: "A suspicious process could plausibly be proof-tied, but lineage is unknown",
      });
      continue;
    }

    if (proc.lineageTiedToProof !== true) {
      continue;
    }

    if (inferredType === "openclaw") {
      orphanOpenClawFailures.push({
        status: "fail",
        category: "openclaw_child",
        pid: proc.pid,
        command: proc.command,
        reason: "A proof-tied OpenClaw process remained after the run",
      });
    } else if (inferredType === "mcp_remote") {
      mcpRemoteFailures.push({
        status: "fail",
        category: "mcp_remote",
        pid: proc.pid,
        command: proc.command,
        reason: "A proof-tied mcp-remote process remained after the run",
      });
    } else if (inferredType === "zapier") {
      zapierFailures.push({
        status: "fail",
        category: "zapier",
        pid: proc.pid,
        command: proc.command,
        reason: "A proof-tied Zapier process remained after the run",
      });
    } else if (inferredType === "slack_runtime") {
      slackRuntimeFailures.push({
        status: "fail",
        category: "slack_runtime",
        pid: proc.pid,
        command: proc.command,
        reason: "A proof-tied Slack runtime process remained after the run",
      });
    }
  }

  findings.push(
    ...residentPassFindings,
    ...orphanOpenClawFailures,
    ...mcpRemoteFailures,
    ...zapierFailures,
    ...slackRuntimeFailures,
    ...blockedFindings,
  );

  const noOrphanOpenClawChildren = blockedFindings.some(
    (finding) => finding.category === "ambiguous_lineage",
  )
    ? "unknown"
    : orphanOpenClawFailures.length === 0;
  const noProofTiedMcpRemote = blockedFindings.some(
    (finding) => finding.category === "ambiguous_lineage",
  )
    ? "unknown"
    : mcpRemoteFailures.length === 0;
  const noProofTiedZapierProcess = blockedFindings.some(
    (finding) => finding.category === "ambiguous_lineage",
  )
    ? "unknown"
    : zapierFailures.length === 0;
  const noProofTiedSlackRuntime = blockedFindings.some(
    (finding) => finding.category === "ambiguous_lineage",
  )
    ? "unknown"
    : slackRuntimeFailures.length === 0;

  if (
    orphanOpenClawFailures.length > 0 ||
    mcpRemoteFailures.length > 0 ||
    zapierFailures.length > 0 ||
    slackRuntimeFailures.length > 0 ||
    !noStaleLock
  ) {
    return {
      status: "fail",
      noStaleLock,
      noOrphanOpenClawChildren,
      noProofTiedMcpRemote,
      noProofTiedZapierProcess,
      noProofTiedSlackRuntime,
      findings,
      classificationReason: firstFailureReason(findings) ?? "Cleanup verification failed",
    };
  }

  if (blockedFindings.length > 0) {
    return blockedResult({
      noStaleLock,
      noOrphanOpenClawChildren,
      noProofTiedMcpRemote,
      noProofTiedZapierProcess,
      noProofTiedSlackRuntime,
      findings,
      classificationReason:
        blockedFindings[0]?.reason ?? "Cleanup verification is blocked by ambiguous lineage",
    });
  }

  if (
    !noStaleLock ||
    noOrphanOpenClawChildren !== true ||
    noProofTiedMcpRemote !== true ||
    noProofTiedZapierProcess !== true ||
    noProofTiedSlackRuntime !== true
  ) {
    return blockedResult({
      noStaleLock,
      noOrphanOpenClawChildren,
      noProofTiedMcpRemote,
      noProofTiedZapierProcess,
      noProofTiedSlackRuntime,
      findings,
      classificationReason: "Cleanup evidence was insufficient to prove a clean pass",
    });
  }

  return {
    status: "pass",
    noStaleLock: true,
    noOrphanOpenClawChildren: true,
    noProofTiedMcpRemote: true,
    noProofTiedZapierProcess: true,
    noProofTiedSlackRuntime: true,
    findings,
    classificationReason: "All required cleanup conditions were clearly satisfied",
  };
}

function blockedResult(
  result: Omit<CoordinationCleanupVerificationResult, "status">,
): CoordinationCleanupVerificationResult {
  return {
    status: "blocked",
    ...result,
  };
}

function buildProcessText(command?: string, args?: string[]): string {
  return [command ?? "", ...(Array.isArray(args) ? args : [])].join(" ").toLowerCase();
}

function looksLikeOpenClawChild(text: string): boolean {
  return (
    text.includes("openclaw") ||
    text.includes("openclaw.mjs") ||
    text.includes("agent-exec") ||
    text.includes("/users/corey-domidocs/src/openclaw-2026.4.21")
  );
}

function looksPotentiallyRelevant(text: string): boolean {
  return (
    looksLikeOpenClawChild(text) ||
    text.includes("mcp-remote") ||
    text.includes("zapier") ||
    text.includes("slack") ||
    text.includes("runtime-api.js")
  );
}

function classifyObservedProcess(
  declaredType:
    | "openclaw"
    | "mcp_remote"
    | "zapier"
    | "slack_runtime"
    | "slack_desktop"
    | "localhost_listener"
    | "unknown"
    | undefined,
  text: string,
):
  | "openclaw"
  | "mcp_remote"
  | "zapier"
  | "slack_runtime"
  | "slack_desktop"
  | "localhost_listener"
  | "unknown" {
  if (declaredType === "openclaw") {
    return "openclaw";
  }
  if (declaredType === "mcp_remote") {
    return "mcp_remote";
  }
  if (declaredType === "zapier") {
    return "zapier";
  }
  if (declaredType === "slack_runtime") {
    return "slack_runtime";
  }
  if (declaredType === "slack_desktop") {
    return "slack_desktop";
  }
  if (declaredType === "localhost_listener") {
    return "localhost_listener";
  }
  if (text.includes("mcp-remote")) {
    return "mcp_remote";
  }
  if (text.includes("zapier") || text.includes("zapier-mcp")) {
    return "zapier";
  }
  if (
    text.includes("extensions/slack/runtime-api.js") ||
    text.includes("slack runtime-api.js") ||
    text.includes("setslackruntime") ||
    text.includes("channel runtime setter")
  ) {
    return "slack_runtime";
  }
  if (text.includes("/applications/slack.app") || text.includes("slack helper")) {
    return "slack_desktop";
  }
  if (text.includes("listen") || text.includes("127.0.0.1:") || text.includes("[::1]:")) {
    return "localhost_listener";
  }
  if (looksLikeOpenClawChild(text)) {
    return "openclaw";
  }
  return "unknown";
}

function isPotentiallyFailingType(
  type:
    | "openclaw"
    | "mcp_remote"
    | "zapier"
    | "slack_runtime"
    | "slack_desktop"
    | "localhost_listener"
    | "unknown",
  text: string,
): boolean {
  if (
    type === "openclaw" ||
    type === "mcp_remote" ||
    type === "zapier" ||
    type === "slack_runtime"
  ) {
    return true;
  }
  if (type === "unknown") {
    return looksPotentiallyRelevant(text);
  }
  return false;
}

function firstFailureReason(findings: CoordinationCleanupFinding[]): string | undefined {
  return findings.find((finding) => finding.status === "fail")?.reason;
}
