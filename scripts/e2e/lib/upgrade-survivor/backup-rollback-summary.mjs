import { compareReleaseVersions } from "../../../lib/release-version.mjs";

export function publishedBackupRollback(snapshot, { sanitize, boundedList, textFields }) {
  const invalid = () => {
    throw new Error("Invalid backup rollback evidence");
  };
  const proof = snapshot.backupRollback;
  if (proof === undefined || proof === null) {
    if (snapshot.scenario === "legacy-operator-state") {
      const comparison =
        typeof snapshot.baseline?.version === "string"
          ? compareReleaseVersions(snapshot.baseline.version, "2026.9.4")
          : null;
      if (comparison === null || comparison >= 0) {
        invalid();
      }
    }
    return undefined;
  }
  const count = (value) => (Number.isSafeInteger(value) && value >= 0 ? value : invalid());
  const digest = (value) =>
    typeof value === "string" && /^[a-f0-9]{64}$/.test(value) ? value : invalid();
  const name = (value) =>
    typeof value === "string" && /^[a-z0-9_][a-z0-9_-]{0,127}$/.test(value)
      ? sanitize(value, "backup rollback")
      : invalid();
  const versions = (value) => ({ state: count(value?.state), agent: count(value?.agent) });
  const releaseVersion = (value) =>
    typeof value === "string" &&
    value.trim() === value &&
    compareReleaseVersions(value, value) !== null
      ? sanitize(value, "backup rollback")
      : invalid();
  if (
    snapshot.scenario !== "legacy-operator-state" ||
    proof.baselineVersion !== snapshot.baseline.version
  ) {
    invalid();
  }
  if (proof.status === "not-applicable") {
    if (
      proof.minimumBaseline !== "2026.9.4" ||
      compareReleaseVersions(proof.baselineVersion, proof.minimumBaseline) >= 0
    ) {
      invalid();
    }
    return {
      status: "not-applicable",
      baselineVersion: releaseVersion(proof.baselineVersion),
      minimumBaseline: releaseVersion(proof.minimumBaseline),
    };
  }
  if (
    proof.status !== "passed" ||
    proof.runtime?.version !== proof.baselineVersion ||
    proof.candidateVersion !== snapshot.candidate.version ||
    proof.candidateVersion !== snapshot.installedVersion
  ) {
    invalid();
  }
  const baselineSchemaVersions = versions(proof.runtime.schemaVersions);
  const preflights = boundedList(proof.preflights);
  const sessionReads = boundedList(proof.sessionReads);
  const databases = boundedList(proof.before?.databases).map((database) => {
    if (!["state", "agent"].includes(database.kind) || typeof database.present !== "boolean") {
      invalid();
    }
    const result = {
      kind: database.kind,
      present: database.present,
    };
    if (database.kind === "agent") {
      result.agentId = name(database.agentId);
    }
    if (!database.present) {
      return result;
    }
    for (const session of boundedList(database.sessions)) {
      if (typeof session?.key !== "string" || typeof session.sessionId !== "string") {
        invalid();
      }
    }
    Object.assign(result, {
      userVersion: count(database.userVersion),
      contentVersion: count(database.contentVersion),
      sessionCount: boundedList(database.sessions).length,
      tables: boundedList(database.tables).map((table) => ({
        table: name(table.table),
        rows: count(table.rows),
        sha256: digest(table.sha256),
      })),
    });
    if (database.kind === "agent") {
      const matchingPreflights = preflights.filter((entry) => entry.agentId === database.agentId);
      const matchingReads = sessionReads.filter((entry) => entry.agentId === database.agentId);
      const preflight = matchingPreflights[0];
      const read = matchingReads[0];
      if (
        matchingPreflights.length !== 1 ||
        matchingReads.length !== 1 ||
        preflight?.status !== "exact" ||
        preflight.foundVersion !== database.userVersion ||
        preflight.targetVersion !== baselineSchemaVersions.agent ||
        database.userVersion !== baselineSchemaVersions.agent ||
        database.contentVersion !== database.userVersion ||
        read?.count !== result.sessionCount
      ) {
        invalid();
      }
      Object.assign(result, {
        preflight: {
          status: "exact",
          foundVersion: count(preflight.foundVersion),
          targetVersion: count(preflight.targetVersion),
        },
        sessionRead: { count: count(read.count) },
      });
    }
    return result;
  });
  const presentAgents = databases.filter(
    (database) => database.kind === "agent" && database.present,
  );
  if (
    preflights.length !== presentAgents.length ||
    sessionReads.length !== presentAgents.length ||
    new Set(presentAgents.map((database) => database.agentId)).size !== presentAgents.length ||
    !presentAgents.some(
      (database) =>
        database.sessionCount > 0 &&
        database.tables.some((table) => table.table === "transcript_events" && table.rows > 0),
    )
  ) {
    invalid();
  }
  const omittedRawTranscripts = boundedList(proof.omittedRawTranscripts ?? []).map((file) => {
    if (
      proof.baselineVersion !== "2026.9.4" ||
      file.kind !== "transcript" ||
      file.reason !== "published-2026.9.4-volatile-transcript" ||
      file.relative !== "agents/main/sessions/upgrade-restored-index-history.jsonl" ||
      typeof file.archiveMember !== "string" ||
      !proof.before.files.some(
        (source) =>
          source.kind === file.kind &&
          source.relative === file.relative &&
          source.sha256 === file.sha256,
      ) ||
      count(file.canonicalEventCount) === 0
    ) {
      invalid();
    }
    return Object.assign(textFields(file, ["relative", "archiveMember", "reason"], sanitize), {
      kind: "transcript",
      sha256: digest(file.sha256),
      canonicalEventCount: count(file.canonicalEventCount),
    });
  });
  const rawTranscriptRestoration = omittedRawTranscripts.length
    ? "unsupported-by-published-backup"
    : "verified";
  if (
    (omittedRawTranscripts.length &&
      count(proof.backupCreate?.skippedVolatileCount) < omittedRawTranscripts.length) ||
    ((omittedRawTranscripts.length || proof.rawTranscriptRestoration !== undefined) &&
      proof.rawTranscriptRestoration !== rawTranscriptRestoration)
  ) {
    invalid();
  }
  return {
    status: "passed",
    baselineVersion: releaseVersion(proof.baselineVersion),
    candidateVersion: releaseVersion(proof.candidateVersion),
    baselineSchemaVersions,
    candidateSchemaVersions: versions(proof.candidateSchemaVersions),
    archiveSha256: digest(proof.archive?.sha256),
    baselineRuntime: {
      manifestSha256: digest(proof.runtime.manifestSha256),
      entrySha256: digest(proof.runtime.entrySha256),
    },
    ...(proof.backupCreate === undefined
      ? {}
      : { skippedVolatileCount: count(proof.backupCreate.skippedVolatileCount) }),
    rawTranscriptRestoration,
    omittedRawTranscripts,
    databases,
    files: boundedList(proof.before.files).map((file) => {
      if (!["legacy-store", "transcript", "trajectory", "skill-prompt"].includes(file.kind)) {
        invalid();
      }
      return { kind: file.kind, sha256: digest(file.sha256) };
    }),
  };
}
