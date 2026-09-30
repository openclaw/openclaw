import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const NOW = "2026-07-29T00:00:00.000Z";
const WORKSHOP_ROOT = "agents/main/agent/workshop-skills";
const EXPORT_ROOT = `${WORKSHOP_ROOT}/.archive/.retired-proposals`;
const PROPOSALS_DIR = "skill-workshop/proposals";
export const RETIRED_WORKSHOP_TABLES = [
  "skill_workshop_collection_reviews",
  "skill_workshop_proposal_events",
  "skill_workshop_proposal_rollbacks",
  "skill_workshop_proposals",
];
// Every proposal shape the published build can hold: SQLite rows (incl. a generation draft) and a pre-SQLite JSON bundle.
const PROPOSALS = [
  {
    key: "survivor-pending",
    status: "pending",
    json: false,
    draftFile: "generations/0f5c2a8e-6d1b-4c3a-9e7f-2b8d4a6c1e90/PROPOSAL.md",
    support: true,
  },
  { key: "survivor-quarantined", status: "quarantined", json: false, draftFile: "PROPOSAL.md" },
  {
    key: "survivor-applied",
    status: "applied",
    json: false,
    draftFile: "PROPOSAL.md",
    support: true,
  },
  {
    key: "survivor-legacy-json",
    status: "pending",
    json: true,
    draftFile: "PROPOSAL.md",
    support: true,
  },
];
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const readJson = (filename) => JSON.parse(fs.readFileSync(filename, "utf8"));

function databasePath(stateDir) {
  return path.join(stateDir, "state", "openclaw.sqlite");
}

/** Independently seed published-build proposal state, without importing candidate code. */
export function seedWorkshopLegacyProposals(stateDir, artifactRoot) {
  assert.equal(
    readJson(path.join(artifactRoot, "workshop-baseline-doctor.json")).status,
    "explicit-doctor-repaired",
    "Seed legacy proposals only after the published baseline Doctor repair",
  );
  const files = {};
  const exported = {};
  const put = (relative, bytes) => {
    const filename = path.join(stateDir, relative);
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    fs.writeFileSync(filename, bytes, { flag: "wx", mode: 0o600 });
    files[relative] = sha256(bytes);
  };
  const database = new DatabaseSync(databasePath(stateDir));
  try {
    database.exec("BEGIN IMMEDIATE");
    for (const { key, status, json, draftFile, support } of PROPOSALS) {
      const id = `${key}-20260729`;
      const draft = `---\nname: "${key}"\ndescription: "Published updater Workshop fixture"\n---\n\n# ${key}\n\nPreserve the ${status} draft bytes.\n`;
      const supportBytes = `Preserved ${key} support.\n`;
      const bundle = path.posix.join(PROPOSALS_DIR, id, path.posix.dirname(draftFile));
      const record = {
        schema: "openclaw.skill-workshop.proposal.v1",
        id,
        kind: "create",
        status,
        title: `Create ${key}`,
        createdAt: NOW,
        updatedAt: NOW,
        draftFile,
        draftHash: sha256(draft),
        supportFiles: support
          ? [
              {
                path: "references/proof.md",
                sizeBytes: Buffer.byteLength(supportBytes),
                hash: sha256(supportBytes),
              },
            ]
          : [],
        target: { skillName: key },
      };
      put(`${bundle}/PROPOSAL.md`, draft);
      if (support) {
        put(`${bundle}/references/proof.md`, supportBytes);
      }
      if (json) {
        put(`${PROPOSALS_DIR}/${id}/proposal.json`, `${JSON.stringify(record, null, 2)}\n`);
      } else {
        database
          .prepare(
            `INSERT INTO skill_workshop_proposals (
              proposal_id, record_json, owner_agent_id, kind, status, created_at, updated_at, draft_hash,
              applied_at, quarantined_at
            ) VALUES (?, ?, 'main', 'create', ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            id,
            JSON.stringify(record),
            status,
            NOW,
            NOW,
            record.draftHash,
            status === "applied" ? NOW : null,
            status === "quarantined" ? NOW : null,
          );
      }
      if (status === "applied") {
        // Applied proposals already live as Workshop skills; retirement must leave them alone.
        put(`${WORKSHOP_ROOT}/${key}/SKILL.md`, draft);
        put(`${WORKSHOP_ROOT}/${key}/references/proof.md`, supportBytes);
        database
          .prepare(
            `INSERT INTO skill_workshop_proposal_rollbacks
              (proposal_id, written_at, target_skill_file, action) VALUES (?, ?, ?, 'create')`,
          )
          .run(id, NOW, path.join(stateDir, WORKSHOP_ROOT, key, "SKILL.md"));
        database
          .prepare(
            `INSERT INTO skill_workshop_proposal_events
              (event_id, proposal_id, proposed_version, revision_hash, event_type, occurred_at, actor_json)
              VALUES (?, ?, 'v1', ?, 'applied', ?, '{"type":"system"}')`,
          )
          .run(`${id}-applied`, id, record.draftHash, NOW);
        continue;
      }
      exported[`${EXPORT_ROOT}/${id}/SKILL.md`] = sha256(draft);
      if (support) {
        exported[`${EXPORT_ROOT}/${id}/references/proof.md`] = sha256(supportBytes);
      }
    }
    database.exec("COMMIT");
  } finally {
    database.close();
  }
  put("skill-workshop/proposals.json", `${JSON.stringify({ proposals: [] })}\n`);
  const fixture = {
    paths: [...Object.keys(files), ...Object.keys(exported)],
    before: {
      files: { ...files, ...Object.fromEntries(Object.keys(exported).map((key) => [key, null])) },
      exports: null,
      proposalsDir: true,
      tables: {
        skill_workshop_collection_reviews: 1,
        skill_workshop_proposal_events: 1,
        skill_workshop_proposal_rollbacks: 1,
        skill_workshop_proposals: 3,
      },
    },
    after: {
      files: Object.fromEntries(
        Object.entries({ ...files, ...exported }).map(([relative, hash]) => [
          relative,
          relative.startsWith("skill-workshop/") ? null : hash,
        ]),
      ),
      exports: PROPOSALS.filter(({ status }) => status !== "applied")
        .map(({ key }) => `${key}-20260729`)
        .toSorted(),
      proposalsDir: false,
      tables: {},
    },
  };
  assert.deepEqual(captureWorkshopLegacyState(stateDir, fixture), fixture.before);
  fs.writeFileSync(
    path.join(artifactRoot, "workshop-legacy-seeded.json"),
    `${JSON.stringify(fixture, null, 2)}\n`,
    { flag: "wx", mode: 0o600 },
  );
  return fixture;
}

export function captureWorkshopLegacyState(stateDir, fixture) {
  const files = Object.fromEntries(
    fixture.paths.map((relative) => {
      const filename = path.join(stateDir, relative);
      if (!fs.existsSync(filename)) {
        return [relative, null];
      }
      assert(fs.lstatSync(filename).isFile(), `Workshop path is not a regular file: ${relative}`);
      return [relative, sha256(fs.readFileSync(filename))];
    }),
  );
  const exportRoot = path.join(stateDir, EXPORT_ROOT);
  const database = new DatabaseSync(databasePath(stateDir), { readOnly: true });
  try {
    const tables = {};
    for (const table of RETIRED_WORKSHOP_TABLES) {
      if (
        database
          .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = ?")
          .get(table)
      ) {
        tables[table] = Number(database.prepare(`SELECT count(*) AS n FROM ${table}`).get().n);
      }
    }
    return {
      files,
      exports: fs.existsSync(exportRoot) ? fs.readdirSync(exportRoot).toSorted() : null,
      proposalsDir: fs.existsSync(path.join(stateDir, PROPOSALS_DIR)),
      tables,
    };
  } finally {
    database.close();
  }
}

/** Pending/quarantined drafts are exported, applied skills stay live, retired storage is gone. */
export function assertWorkshopProposalsRetired(fixture, current) {
  assert(current, "Missing Doctor Workshop exit snapshot");
  assert.deepEqual(current.tables, {}, "Doctor left retired Workshop tables behind");
  assert.equal(current.proposalsDir, false, "Doctor left retired proposal files behind");
  assert.deepEqual(
    current.exports,
    fixture.after.exports,
    "Doctor must export exactly the pending and quarantined proposals",
  );
  assert.deepEqual(
    current.files,
    fixture.after.files,
    "Doctor changed exported drafts or live Workshop skill bytes",
  );
  return current;
}
