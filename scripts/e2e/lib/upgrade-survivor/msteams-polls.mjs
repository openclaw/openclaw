import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const LEGACY_FILE = "msteams-polls.json";
const EXPECTED_FILES = [
  "msteams-polls-upgrade.expected.json",
  "msteams-polls-doctor.expected.json",
];

export function seedMSTeamsPollMigration(stateDir, artifactRoot, phase = "upgrade") {
  const id = `upgrade-survivor-${phase}`;
  const createdAt = new Date().toISOString();
  const bytes = `${JSON.stringify(
    {
      version: 1,
      polls: {
        [id]: {
          id,
          question: "Which archive should survive? — 東京",
          options: ["First", "Second", "Both"],
          maxSelections: 2,
          createdAt,
          updatedAt: createdAt,
          conversationId: "synthetic-teams-conversation",
          messageId: `synthetic-${phase}-message`,
          votes: { "voter-one": ["0"], "voter-two": ["1", "2"], "voter-東京": ["2"] },
        },
      },
    },
    null,
    2,
  )}\n`;
  fs.mkdirSync(artifactRoot, { recursive: true });
  if (phase === "upgrade") {
    for (const file of EXPECTED_FILES) {
      fs.rmSync(path.join(artifactRoot, file), { force: true });
    }
  }
  fs.writeFileSync(path.join(artifactRoot, `msteams-polls-${phase}.expected.json`), bytes);
  fs.writeFileSync(path.join(stateDir, LEGACY_FILE), bytes, { flag: "wx" });
}

export function assertMSTeamsPollMigration(stateDir, artifactRoot, stage) {
  const expectedBytes = EXPECTED_FILES.map((file) => path.join(artifactRoot, file))
    .filter((file) => fs.existsSync(file))
    .map((file) => fs.readFileSync(file, "utf8"));
  assert(expectedBytes.length > 0, "Teams legacy poll specimen is missing");
  if (stage === "baseline") {
    assert.equal(fs.readFileSync(path.join(stateDir, LEGACY_FILE), "utf8"), expectedBytes[0]);
    return;
  }
  assert(!fs.existsSync(path.join(stateDir, LEGACY_FILE)), "Teams legacy polls were not archived");
  const archivedBytes = fs
    .readdirSync(stateDir)
    .filter(
      (file) => file === `${LEGACY_FILE}.migrated` || file.startsWith(`${LEGACY_FILE}.migrated.`),
    )
    .map((file) => fs.readFileSync(path.join(stateDir, file), "utf8"));
  assert.deepEqual(
    archivedBytes.toSorted(),
    expectedBytes.toSorted(),
    "Teams poll archive bytes changed",
  );
  const expectedPolls = Object.assign({}, ...expectedBytes.map((bytes) => JSON.parse(bytes).polls));
  const db = new DatabaseSync(path.join(stateDir, "state", "openclaw.sqlite"), { readOnly: true });
  try {
    const rows = db
      .prepare(
        "SELECT namespace, entry_key, value_json, expires_at FROM plugin_state_entries WHERE plugin_id = 'msteams' AND namespace IN ('polls', 'poll-vote-buckets') ORDER BY namespace, entry_key",
      )
      .all();
    const polls = {};
    const votes = {};
    for (const row of rows) {
      assert.equal(row.expires_at, null, "Teams poll row acquired an expiry");
      const value = JSON.parse(row.value_json);
      if (row.namespace === "polls") {
        assert.equal(row.entry_key, createHash("sha256").update(value.id).digest("hex"));
        assert(!Object.hasOwn(polls, value.id), "Teams poll metadata was duplicated");
        polls[value.id] = value;
      } else {
        const poll = expectedPolls[value.pollId];
        assert(poll, "Teams vote bucket references an unexpected poll");
        assert.equal(value.updatedAt, poll.updatedAt ?? poll.createdAt);
        assert.equal(
          row.entry_key,
          `${createHash("sha256").update(value.pollId).digest("hex")}:${value.bucket}`,
        );
        const pollVotes = (votes[value.pollId] ??= {});
        for (const [voterId, selections] of Object.entries(value.votes)) {
          const bucket =
            Number.parseInt(
              createHash("sha256")
                .update(value.pollId)
                .update("\0")
                .update(voterId)
                .digest("hex")
                .slice(0, 8),
              16,
            ) % 32;
          assert.equal(value.bucket, String(bucket).padStart(4, "0"), "Teams voter bucket changed");
          assert(!Object.hasOwn(pollVotes, voterId), "Teams voter was duplicated across buckets");
          pollVotes[voterId] = selections;
        }
      }
    }
    assert.deepEqual(
      polls,
      Object.fromEntries(
        Object.entries(expectedPolls).map(([id, { votes: _votes, ...metadata }]) => [id, metadata]),
      ),
      "Teams poll metadata changed",
    );
    assert.deepEqual(
      votes,
      Object.fromEntries(Object.entries(expectedPolls).map(([id, poll]) => [id, poll.votes])),
      "Teams poll votes changed",
    );
  } finally {
    db.close();
  }
}

export function assertMSTeamsPluginFiles(installPath, archivePath) {
  const archiveArgs = { cwd: path.dirname(archivePath) };
  const archiveName = path.basename(archivePath);
  const files = execFileSync("tar", ["-tzf", archiveName], { ...archiveArgs, encoding: "utf8" })
    .trim()
    .split("\n")
    .filter((file) => /\.(?:cjs|mjs|js)$/u.test(file));
  assert(
    files.some((file) => /(?:^|\/)doctor-contract-api\.(?:cjs|mjs|js)$/u.test(file)),
    "Candidate Teams Doctor entry is missing",
  );
  for (const file of files) {
    assert(
      file.startsWith("package/") && !file.split("/").includes(".."),
      "Invalid Teams artifact path",
    );
    const expected = execFileSync("tar", ["-xOf", archiveName, file], {
      ...archiveArgs,
      maxBuffer: 64 * 1024 * 1024,
    });
    assert.deepEqual(
      fs.readFileSync(path.join(installPath, file.slice("package/".length))),
      expected,
      `Installed candidate Teams bytes changed: ${file}`,
    );
  }
  console.log(
    `Verified ${files.length} installed Teams runtime files against the candidate artifact.`,
  );
}
