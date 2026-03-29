import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  readHubLockfile,
  upsertLockSkill,
  writeHubLockfile,
  type HubLockfile,
} from "./lockfile.js";

const tmpDirs: string[] = [];

async function makeTmpDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hub-lockfile-test-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of tmpDirs) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
  tmpDirs.length = 0;
});

describe("skills hub lockfile", () => {
  it("upserts deterministically sorted by skill name", () => {
    const lock: HubLockfile = { lockfileVersion: 1, skills: [] };
    const withB = upsertLockSkill(lock, {
      name: "beta",
      source: "clawhub",
      url: "https://clawhub.ai/skills/beta",
      ref: "1.0.0",
      contentHash: "hash-b",
      scan: { critical: 0, warn: 0, info: 0, verdict: "safe" },
    });
    const withA = upsertLockSkill(withB, {
      name: "alpha",
      source: "github",
      url: "https://github.com/acme/alpha",
      ref: "abc123",
      contentHash: "hash-a",
      scan: { critical: 0, warn: 1, info: 0, verdict: "warn" },
    });
    expect(withA.skills.map((skill) => skill.name)).toEqual(["alpha", "beta"]);
  });

  it("writes and reads lockfile with stable ordering", async () => {
    const dir = await makeTmpDir();
    const lockPath = path.join(dir, "hub.lock.json");
    const lock: HubLockfile = {
      lockfileVersion: 1,
      skills: [
        {
          name: "zeta",
          source: "github",
          url: "https://github.com/acme/zeta",
          ref: "sha-z",
          contentHash: "hash-z",
          scan: { critical: 0, warn: 0, info: 0, verdict: "safe" },
        },
        {
          name: "alpha",
          source: "clawhub",
          url: "https://clawhub.ai/skills/alpha",
          ref: "1.2.3",
          contentHash: "hash-a",
          scan: { critical: 0, warn: 0, info: 0, verdict: "safe" },
        },
      ],
    };
    await writeHubLockfile(lockPath, lock);
    const parsed = await readHubLockfile(lockPath);
    expect(parsed.skills.map((skill) => skill.name)).toEqual(["alpha", "zeta"]);
  });

  it("drops skill rows missing required lockfile fields", async () => {
    const dir = await makeTmpDir();
    const lockPath = path.join(dir, "hub.lock.json");
    await fs.writeFile(
      lockPath,
      `${JSON.stringify({
        lockfileVersion: 1,
        skills: [
          { name: "incomplete" },
          {
            name: "ok",
            source: "github",
            url: "https://github.com/acme/ok",
            ref: "abc",
            contentHash: "hash-ok",
            scan: { critical: 0, warn: 0, info: 0, verdict: "safe" },
          },
        ],
      })}\n`,
      "utf-8",
    );
    const parsed = await readHubLockfile(lockPath);
    expect(parsed.skills.map((s) => s.name)).toEqual(["ok"]);
  });
});
