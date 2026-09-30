import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { stripVTControlCharacters } from "node:util";

const NOW = "2026-07-29T00:00:00.000Z";
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const readJson = (filename) => JSON.parse(fs.readFileSync(filename, "utf8"));

function writeFile(filename, content) {
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  fs.writeFileSync(filename, content, { flag: "wx", mode: 0o600 });
}

/** Independently seed the shipped v1 sidecar contract, without importing candidate code. */
export function seedWorkshopLegacyProposals(stateDir, artifactRoot) {
  assert.equal(
    readJson(path.join(artifactRoot, "workshop-baseline-doctor.json")).status,
    "explicit-doctor-repaired",
    "Seed legacy proposals only after the published baseline Doctor repair",
  );
  const files = {};
  const bundles = [
    { key: "survivor-recovered", owner: "main", recover: true },
    { key: "survivor-retained", owner: "retired-agent", recover: false },
  ].map(({ key, owner, recover }) => {
    const id = `${key}-20260729-1234567890`;
    const directory = `skill-workshop/proposals/${id}`;
    const target = recover
      ? `workspace/skills/${key}`
      : `agents/${owner}/agent/workshop-skills/${key}`;
    const destination = `agents/main/agent/workshop-skills/${key}`;
    const support = `Preserved ${key} support.\n`;
    const header = `name: "${key}"\ndescription: "Published updater Workshop fixture"`;
    const body = `# ${key}\n\nPreserve the original proposal and support bytes.\n`;
    const content = `---\n${header}\nstatus: proposal\nversion: "v1"\ndate: "${NOW}"\n---\n\n${body}`;
    const installed = `---\n${header}\n---\n\n${body}`;
    const record = {
      schema: "openclaw.skill-workshop.proposal.v1",
      id,
      kind: "create",
      status: "pending",
      title: `Create ${key}`,
      description: "Published updater Workshop fixture",
      createdAt: NOW,
      updatedAt: NOW,
      createdBy: "skill-workshop",
      origin: { agentId: owner, runId: `${key}-run` },
      originRunIds: [`${key}-run`],
      originRunMutationCounts: { [`${key}-run`]: 1 },
      proposedVersion: "v1",
      draftFile: "PROPOSAL.md",
      draftHash: sha256(content),
      supportFiles: [
        {
          path: "references/proof.md",
          sizeBytes: Buffer.byteLength(support),
          hash: sha256(support),
        },
      ],
      target: {
        skillName: key,
        skillKey: key,
        skillDir: path.join(stateDir, target),
        skillFile: path.join(stateDir, target, "SKILL.md"),
        source: "openclaw-workspace",
      },
      scan: { state: "clean", scannedAt: NOW, critical: 0, warn: 0, info: 0, findings: [] },
    };
    const rollback = recover
      ? {
          schema: "openclaw.skill-workshop.rollback.v1",
          proposalId: id,
          writtenAt: NOW,
          targetSkillFile: record.target.skillFile,
          action: "create",
          supportFiles: [{ path: "references/proof.md", existed: false }],
        }
      : undefined;
    const contentByPath = {
      [`${directory}/proposal.json`]: `${JSON.stringify(record, null, 2)}\n`,
      [`${directory}/PROPOSAL.md`]: content,
      [`${directory}/references/proof.md`]: support,
      [`${target}/SKILL.md`]: installed,
      [`${target}/references/proof.md`]: support,
      ...(rollback
        ? { [`${directory}/rollback.json`]: `${JSON.stringify(rollback, null, 2)}\n` }
        : {}),
    };
    for (const [relative, bytes] of Object.entries(contentByPath)) {
      writeFile(path.join(stateDir, relative), bytes);
      files[relative] = sha256(bytes);
    }
    if (recover) {
      for (const relative of [`${destination}/SKILL.md`, `${destination}/references/proof.md`]) {
        assert.equal(fs.existsSync(path.join(stateDir, relative)), false);
        files[relative] = null;
      }
    }
    return { record, rollback, directory, target, destination, recover };
  });
  const manifest = "skill-workshop/proposals.json";
  const manifestBytes = `${JSON.stringify({ schema: "openclaw.skill-workshop.proposals-manifest.v1", updatedAt: NOW, proposals: [] })}\n`;
  writeFile(path.join(stateDir, manifest), manifestBytes);
  files[manifest] = sha256(manifestBytes);
  const fixture = { bundles, files };
  const before = captureWorkshopLegacyState(stateDir, fixture);
  assert.deepEqual(before.files, files);
  assert.deepEqual(before.database, { proposals: [], rollbacks: [], events: [] });
  const retained = bundles.find((bundle) => !bundle.recover);
  const retainedWarning = `Preserved Skill Workshop proposal ${path.join(stateDir, retained.directory)} for manual review: owning agent "retired-agent" is not configured; target ${retained.record.target.skillDir} (candidate agents: none). Review the retained metadata and configured workspace ownership before retrying Doctor.`;
  assert(
    retainedWarning.length <= 500,
    "Fixture warning exceeds the Doctor IPC limit; use a shorter isolated state root",
  );
  const seeded = { ...fixture, before, retainedWarning };
  writeFile(
    path.join(artifactRoot, "workshop-legacy-seeded.json"),
    `${JSON.stringify(seeded, null, 2)}\n`,
  );
  return seeded;
}

export function captureWorkshopLegacyState(stateDir, fixture) {
  const files = Object.fromEntries(
    Object.keys(fixture.files).map((relative) => {
      const filename = path.join(stateDir, relative);
      if (!fs.existsSync(filename)) {
        return [relative, null];
      }
      assert(
        fs.lstatSync(filename).isFile(),
        `Legacy fixture path is not a regular file: ${relative}`,
      );
      return [relative, sha256(fs.readFileSync(filename))];
    }),
  );
  const database = new DatabaseSync(path.join(stateDir, "state", "openclaw.sqlite"), {
    readOnly: true,
  });
  try {
    const ids = fixture.bundles.map(({ record }) => record.id);
    const rows = (table, order) =>
      database
        .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = ?")
        .get(table)
        ? database
            .prepare(`SELECT * FROM ${table} WHERE proposal_id IN (?, ?) ORDER BY ${order}`)
            .all(...ids)
            .map((row) => Object.assign({}, row))
        : [];
    return {
      files,
      database: {
        proposals: rows("skill_workshop_proposals", "proposal_id"),
        rollbacks: rows("skill_workshop_proposal_rollbacks", "proposal_id"),
        events: rows("skill_workshop_proposal_events", "sequence"),
      },
    };
  } finally {
    database.close();
  }
}

export function assertWorkshopLegacyImported(stateDir, fixture, current) {
  assert(current, "Missing Doctor legacy exit snapshot");
  const recovered = fixture.bundles.find((bundle) => bundle.recover);
  const expectedFiles = { ...fixture.files, "skill-workshop/proposals.json": null };
  for (const name of ["proposal.json", "rollback.json"]) {
    expectedFiles[`${recovered.directory}/${name}`] = null;
  }
  for (const name of ["SKILL.md", "references/proof.md"]) {
    expectedFiles[`${recovered.destination}/${name}`] =
      fixture.files[`${recovered.target}/${name}`];
    expectedFiles[`${recovered.target}/${name}`] = null;
  }
  assert.deepEqual(
    current.files,
    expectedFiles,
    "Doctor changed or lost retained Workshop artifact bytes",
  );
  const { proposals, rollbacks, events } = current.database;
  assert.equal(
    proposals.length,
    1,
    "Candidate Doctor did not import exactly the owned legacy proposal",
  );
  const row = proposals[0];
  const record = JSON.parse(row.record_json);
  assert.match(record.appliedAt, /^\d{4}-\d{2}-\d{2}T/u);
  assert.equal(record.updatedAt, record.appliedAt);
  assert.deepEqual(record, {
    ...recovered.record,
    status: "applied",
    updatedAt: record.appliedAt,
    appliedAt: record.appliedAt,
    target: {
      ...recovered.record.target,
      skillDir: path.join(stateDir, recovered.destination),
      skillFile: path.join(stateDir, recovered.destination, "SKILL.md"),
      source: "openclaw-workshop",
    },
  });
  assert.deepEqual(
    row,
    {
      proposal_id: record.id,
      record_json: row.record_json,
      owner_agent_id: "main",
      kind: record.kind,
      status: record.status,
      created_at: record.createdAt,
      updated_at: record.updatedAt,
      draft_hash: record.draftHash,
      origin_agent_id: record.origin?.agentId ?? null,
      origin_session_key: record.origin?.sessionKey ?? null,
      origin_run_id: record.origin?.runId ?? null,
      origin_message_id: record.origin?.messageId ?? null,
      applied_at: record.appliedAt ?? null,
      rejected_at: record.rejectedAt ?? null,
      quarantined_at: record.quarantinedAt ?? null,
      stale_at: record.staleAt ?? null,
      status_reason: record.statusReason ?? null,
    },
    "Authoritative Workshop proposal columns disagree with the recovered record",
  );
  assert.equal(rollbacks.length, 1, "Imported rollback metadata was lost or duplicated");
  assert.deepEqual(
    { ...rollbacks[0] },
    {
      proposal_id: recovered.record.id,
      written_at: recovered.rollback.writtenAt,
      target_skill_file: recovered.rollback.targetSkillFile,
      action: "create",
      previous_content_hash: null,
      previous_content: null,
      support_files_json: JSON.stringify(recovered.rollback.supportFiles),
    },
    "Imported rollback payload changed",
  );
  assert.equal(events.length, 1, "Recovery must record exactly one applied event");
  const event = events[0];
  assert.equal(event.proposal_id, recovered.record.id);
  assert.equal(event.event_type, "applied");
  assert.equal(event.proposed_version, "v1");
  assert.equal(event.occurred_at, record.appliedAt);
  assert.deepEqual(JSON.parse(event.actor_json), { type: "system" });
  assert.deepEqual(
    JSON.parse(event.payload_json),
    [1, { recovered: true }, null],
    "Recovered Workshop event payload changed",
  );
  assert.equal(
    event.revision_hash,
    sha256(
      JSON.stringify({
        proposedVersion: "v1",
        contentSha256: record.draftHash,
        supportFiles: record.supportFiles.map((file) => ({
          path: file.path,
          sha256: file.hash,
          sizeBytes: file.sizeBytes,
        })),
      }),
    ),
  );
  return current;
}

export function assertWorkshopLegacyWarning(fixture, outputs) {
  assert(
    Array.isArray(outputs) && outputs.every((output) => typeof output === "string"),
    "Missing Doctor warning output",
  );
  const normalize = (text) =>
    stripVTControlCharacters(text)
      .split(/\r?\n/u)
      .map((line) => line.replace(/^\s*[│|]\s?/u, "").replace(/\s*[│|]\s*$/u, ""))
      .join(" ")
      .replace(/\s+/gu, " ")
      .trim();
  const expected = normalize(fixture.retainedWarning);
  const observed = outputs.find((output) => normalize(output).includes(expected));
  assert(observed !== undefined, "Missing complete recoverable Workshop manual-review warning");
  return { warning: fixture.retainedWarning, outputSha256: sha256(observed) };
}
