// Publish only the native-upgrade witness bound to this package and completed cell.
export function publishedNativeAssignments(snapshot) {
  const eligibility = snapshot.nativeAssignmentEligibility;
  const proof = snapshot.nativeAssignments;
  const prepared = snapshot.phases?.some(
    (event) => event.phase === "prepare-native-assignment-proof" && event.status === "passed",
  );
  if (!eligibility) {
    if (prepared || proof) {
      throw new Error("Missing native assignment eligibility evidence");
    }
    return undefined;
  }
  if (
    snapshot.scenario !== "legacy-operator-state" ||
    snapshot.baseline?.version !== "2026.9.4" ||
    snapshot.updateRestartMode !== "manual"
  ) {
    throw new Error("Native assignment evidence belongs to another upgrade cell");
  }
  if (eligibility.status === "not-applicable") {
    if (proof || eligibility.reason !== "candidate retains the Task runtime SDK") {
      throw new Error("Invalid native assignment non-applicability evidence");
    }
    return { status: "not-applicable", reason: eligibility.reason };
  }
  if (
    eligibility.status !== "required" ||
    eligibility.candidateVersion !== snapshot.candidate?.version ||
    !/^[a-f0-9]{64}$/u.test(eligibility.candidateSha256 ?? "") ||
    !/^[a-f0-9]{64}$/u.test(eligibility.companionSha256 ?? "") ||
    !/^[a-f0-9]{40}$/u.test(eligibility.sourceSha ?? "")
  ) {
    throw new Error("Invalid native assignment candidate identity");
  }
  if (!proof) {
    if (snapshot.status === "passed") {
      throw new Error("Passed retirement upgrade omitted native assignment proof");
    }
    return { status: "incomplete", candidateVersion: eligibility.candidateVersion };
  }
  const outcomes = [
    "firstHopImported",
    "retainedHistory",
    "retainedCompletion",
    "unconfirmedClosePreserved",
    "confirmedCloseSettled",
    "noReplay",
  ];
  if (
    proof.status !== "passed" ||
    proof.baselineVersion !== "2026.9.4" ||
    proof.candidateVersion !== eligibility.candidateVersion ||
    proof.candidateVersion !== snapshot.installedVersion ||
    proof.candidateSha256 !== eligibility.candidateSha256 ||
    proof.source !== "published-gateway-agent-native-events" ||
    proof.backend !== "synthetic-codex-websocket" ||
    !/^OpenClaw 2026\.9\.4(?:\s|$)/u.test(proof.baselineCore ?? "") ||
    proof.sessionKey !== "agent:native-proof:upgrade-native-proof" ||
    JSON.stringify(proof.recoveredRunIds) !==
      JSON.stringify([
        "codex-thread:native-upgrade-running",
        "codex-thread:native-upgrade-complete",
      ]) ||
    proof.baselineCodex?.name !== "@openclaw/codex" ||
    proof.baselineCodex.version !== "2026.9.4" ||
    !/^sha512-[A-Za-z0-9+/]+=*$/u.test(proof.baselineCodex.integrity ?? "") ||
    outcomes.some((key) => proof[key] !== true)
  ) {
    throw new Error("Invalid native assignment preservation evidence");
  }
  return {
    status: "passed",
    baselineVersion: proof.baselineVersion,
    candidateVersion: proof.candidateVersion,
    sourceSha: eligibility.sourceSha,
    candidateSha256: eligibility.candidateSha256,
    companionSha256: eligibility.companionSha256,
    baselineCodex: {
      name: proof.baselineCodex.name,
      version: proof.baselineCodex.version,
      integrity: proof.baselineCodex.integrity,
    },
    source: proof.source,
    backend: proof.backend,
    baselineCore: proof.baselineCore,
    recoveredRunIds: proof.recoveredRunIds,
    ...Object.fromEntries(outcomes.map((key) => [key, true])),
  };
}
