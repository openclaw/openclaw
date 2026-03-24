import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "skills-hub-managed-test-"));

vi.mock("../../utils.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../utils.js")>();
  return {
    ...actual,
    CONFIG_DIR: tempRoot,
  };
});

const { enforceManagedScanPolicy, listManagedSkills } = await import("./managed.js");

beforeAll(async () => {
  await fs.mkdir(path.join(tempRoot, "skills"), { recursive: true });
});

afterAll(async () => {
  await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
});

describe("managed hub policy", () => {
  it("blocks critical findings by default", () => {
    const result = enforceManagedScanPolicy({
      summary: {
        scannedFiles: 1,
        critical: 1,
        warn: 0,
        info: 0,
        findings: [],
        policyVersion: "test",
      },
      skillName: "unsafe-skill",
      force: false,
    });
    expect(result.ok).toBe(false);
  });

  it("allows critical findings with force", () => {
    const result = enforceManagedScanPolicy({
      summary: {
        scannedFiles: 1,
        critical: 1,
        warn: 0,
        info: 0,
        findings: [],
        policyVersion: "test",
      },
      skillName: "unsafe-skill",
      force: true,
    });
    expect(result.ok).toBe(true);
  });

  it("lists tracked managed skills from lockfile", async () => {
    const lockPath = path.join(tempRoot, "skills", "hub.lock.json");
    await fs.writeFile(
      lockPath,
      JSON.stringify(
        {
          lockfileVersion: 1,
          skills: [
            {
              name: "calendar",
              source: "clawhub",
              url: "https://clawhub.ai/skills/calendar",
              ref: "1.0.0",
              contentHash: "hash",
              scan: { critical: 0, warn: 0, info: 0, verdict: "safe" },
            },
          ],
        },
        null,
        2,
      ),
      "utf-8",
    );
    await fs.mkdir(path.join(tempRoot, "skills", "calendar"), { recursive: true });
    const rows = await listManagedSkills();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.name).toBe("calendar");
    expect(rows[0]?.exists).toBe(true);
  });
});
