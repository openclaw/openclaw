// Reconstruct exact publication descriptors from authenticated producer receipts.
// Shared by recovery and historical selection; never builds or adopts new bytes.
import { parse as parseYaml } from "yaml";
import { validateArtifactProducerRun } from "../full-release-artifacts.mjs";
import { inspectActionsArtifactZip } from "./actions-artifact-archive.mjs";

const REPOSITORY = "openclaw/openclaw";
const MAX_BYTES = 256 * 1024;
function requireValue(value, message) {
  if (!value) {
    throw new Error("Receipt recovery: " + message);
  }
}
function one(values, label) {
  requireValue(values.length === 1, label + " is missing or ambiguous");
  return values[0];
}

// Contents are discovery indexes, not authority. The receipt owner authenticates
// every selected descriptor before the operator can send a POST.
export async function artifactJson(client, run, name, file) {
  const metadata = one(
    (await client.getRunArtifacts(String(run.id))).filter((entry) => entry.name === name),
    name,
  );
  const downloaded = await client.downloadArtifactArchive({
    expected: {
      repository: REPOSITORY,
      runId: Number(run.id),
      workflowSha: run.head_sha,
      artifactId: Number(metadata.id),
      artifactName: name,
      artifactDigest: metadata.digest,
      artifactSizeBytes: metadata.size_in_bytes,
      artifactExpiresAt: metadata.expires_at,
    },
    maxArchiveBytes: 1024 * 1024,
    token: process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN,
  });
  const bytes = inspectActionsArtifactZip(downloaded.archiveBytes, [file], {
    maxArchiveBytes: 1024 * 1024,
    maxEntryBytes: MAX_BYTES,
    maxExpandedBytes: MAX_BYTES,
  }).get(file);
  return { metadata, bytes, value: JSON.parse(bytes.toString("utf8")) };
}

export async function witnessedRun(client, jobs, jobName, workflow, allowReuse = false) {
  const job = one(
    jobs.filter((entry) => entry.name === jobName),
    "original " + jobName,
  );
  const log = await client.getJobLog(job.id);
  requireValue(
    typeof log === "string" && Buffer.byteLength(log) <= 8 * 1024 * 1024,
    "dispatch log exceeds limit",
  );
  const matches = [
    ...log.matchAll(
      /(Dispatched|Reused) ([\w.-]+\.ya?ml): https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/actions\/runs\/([1-9][0-9]*) \(attempt ([1-9][0-9]*)\)/gu,
    ),
  ];
  const match = one(matches, "original dispatch witness for " + jobName);
  requireValue(
    (match[1] === "Dispatched" || allowReuse) &&
      match[2] === workflow &&
      match[3] === REPOSITORY &&
      match[5] === "1",
    "original dispatch identity differs",
  );
  return { run: await client.getRun(match[4]), log, reused: match[1] === "Reused" };
}

export async function discoverPublicationArtifacts(
  parent,
  source,
  jobs,
  client,
  originalCandidate,
) {
  const workflow = parseYaml(client.getWorkflowSource(parent.head_sha));
  const records = {};
  for (const stage of originalCandidate ? ["npm", "docker"] : ["npm", "candidate", "docker"]) {
    const job = one(
      Object.values(workflow.jobs).filter(
        (entry) => entry.env?.CHILD_WORKFLOW_KIND === "artifact-" + stage,
      ),
      "frozen artifact job " + stage,
    );
    const { run } = await witnessedRun(client, jobs, job.name, "full-release-artifacts.yml");
    const receipt = (
      await artifactJson(
        client,
        run,
        "full-release-artifact-receipt-" + run.id + "-" + run.run_attempt,
        "artifact-receipt.json",
      )
    ).value;
    requireValue(
      receipt.schema === "openclaw.full-release-artifact-receipt/v1" &&
        receipt.stage === stage &&
        receipt.sourceSha === source.candidateSha &&
        receipt.toolingSha === parent.head_sha &&
        receipt.dispatchId === "full-release-validation-" + parent.id + "-1-artifacts-" + stage &&
        String(receipt.runId) === String(run.id) &&
        Number(receipt.runAttempt) === run.run_attempt,
      "artifact receipt discovery identity differs",
    );
    validateArtifactProducerRun(receipt, run, String(run.id), String(run.run_attempt));
    records[stage] = receipt.outputs;
  }
  let pluginNpm = null;
  if (source.publicationSelection?.pluginPublishScope !== "none") {
    const { run: pluginRun } = await witnessedRun(
      client,
      jobs,
      "Prepare exact plugin npm artifacts",
      "plugin-npm-release.yml",
    );
    const plugin = await artifactJson(
      client,
      pluginRun,
      "plugin-npm-prepared-" +
        source.candidateSha +
        "-" +
        pluginRun.id +
        "-" +
        pluginRun.run_attempt,
      "plugin-npm-prepared.json",
    );
    pluginNpm = {
      ...plugin.value.producer,
      artifactId: plugin.metadata.id,
      artifactName: plugin.metadata.name,
      artifactDigest: plugin.metadata.digest,
      artifactSizeBytes: plugin.metadata.size_in_bytes,
    };
  }
  return {
    candidate: originalCandidate ?? JSON.parse(records.candidate.binding_json),
    publicationArtifacts: {
      npmPreflight: JSON.parse(records.npm.qualified_preflight_bundle_json),
      docker: {
        preparedRunId: records.docker.prepared_run_id,
        preparedRunAttempt: records.docker.prepared_run_attempt,
        preparedArtifactName: records.docker.prepared_artifact_name,
        preparedManifestSha256: records.docker.prepared_manifest_sha256,
      },
      pluginNpm,
    },
  };
}
