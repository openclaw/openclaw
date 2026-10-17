import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { discoverGrokBotRoster } from "./local.js";

let root: string;
let directory: string;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "grok-roster-test-"));
  directory = path.join(root, "sand-client-persistence");
  await fs.mkdir(directory);
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

function filename(key: string): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of Buffer.from(key)) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      output += alphabet[(value >>> bits) & 31];
    }
  }
  if (bits > 0) {
    output += alphabet[(value << (5 - bits)) & 31];
  }
  return `${output}.blob`;
}

function rosterFile(scope = "synthetic-account") {
  return path.join(directory, filename(`sand.client.slice.account.${scope}.roster.last-roster`));
}

describe("Grok Bot local roster discovery", () => {
  it("reads only exact roster blobs and returns metadata without private bodies", async () => {
    await fs.writeFile(
      path.join(
        directory,
        filename("sand.client.slice.account.synthetic-account.transcript.replicas.private"),
      ),
      "invalid JSON must not be opened",
    );
    await fs.writeFile(path.join(root, "sand-secrets.json"), "invalid JSON must not be opened");
    await fs.writeFile(
      rosterFile(),
      JSON.stringify({
        schemaVersion: 4,
        value: {
          rows: [
            {
              id: "bot-one",
              name: "Research Bot",
              title: "Research",
              avatarShape: "hex",
              avatarColor: "violet",
              avatarPhoto: null,
              description: "Private instructions",
              lastEntry: { text: "Private conversation" },
              harness: "temporal",
              origin: "user",
            },
          ],
        },
      }),
    );
    expect(await discoverGrokBotRoster({ root })).toEqual({
      sourceRoot: root,
      accounts: [
        {
          scope: "synthetic-account",
          agents: [
            {
              id: "bot-one",
              name: "Research Bot",
              title: "Research",
              avatarShape: "hex",
              avatarColor: "violet",
              harness: "temporal",
              origin: "user",
            },
          ],
        },
      ],
    });
  });

  it("ignores symlinks instead of following a roster into unrelated files", async () => {
    const target = path.join(root, "private.json");
    await fs.writeFile(target, "unrelated private file");
    await fs.symlink(target, rosterFile());
    expect((await discoverGrokBotRoster({ root })).accounts).toEqual([]);
  });

  it("refuses unsupported schema and oversized roster data", async () => {
    await fs.writeFile(rosterFile(), JSON.stringify({ schemaVersion: 99, value: { rows: [] } }));
    await expect(discoverGrokBotRoster({ root })).rejects.toThrow(/Unsupported Grok Bot roster/);
    await fs.truncate(rosterFile(), 8 * 1024 * 1024 + 1);
    await expect(discoverGrokBotRoster({ root })).rejects.toThrow(/size limit/);
  });

  it("returns an empty inventory when Grok Bot has no local cache", async () => {
    expect(await discoverGrokBotRoster({ root: path.join(root, "absent") })).toEqual({
      sourceRoot: path.join(root, "absent"),
      accounts: [],
    });
  });
});
