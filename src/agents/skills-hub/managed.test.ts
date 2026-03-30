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

vi.mock("../skills-clawhub.js", () => ({
  installSkillFromClawHub: vi.fn(),
}));

const { enforceManagedScanPolicy, listManagedSkills, updateManagedSkills } =
  await import("./managed.js");
const { installSkillFromClawHub } = await import("../skills-clawhub.js");

beforeAll(async () => {
  await fs.mkdir(path.join(tempRoot, "skills"), { recursive: true });
});

afterAll(async () => {
  await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
});

describe("managed hub policy", () => {
  it("blocks critical findings by default", () => {
    const result = enforceManagedScanPolicy({
      summary: { scannedFiles: 1, critical: 1, warn: 0, info: 0, findings: [] },
      skillName: "unsafe-skill",
      force: false,
    });
    expect(result.ok).toBe(false);
  });

  it("allows critical findings with force", () => {
    const result = enforceManagedScanPolicy({
      summary: { scannedFiles: 1, critical: 1, warn: 0, info: 0, findings: [] },
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

  it("restores prior skill tree when ClawHub update returns ok: false", async () => {
    vi.mocked(installSkillFromClawHub).mockResolvedValue({
      ok: false,
      error: "simulated update failure",
    });
    const lockPath = path.join(tempRoot, "skills", "hub.lock.json");
    const skillName = "restore-test-skill";
    await fs.writeFile(
      lockPath,
      JSON.stringify(
        {
          lockfileVersion: 1,
          skills: [
            {
              name: skillName,
              source: "clawhub",
              url: "https://clawhub.ai/skills/restore-test-skill",
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
    const skillDir = path.join(tempRoot, "skills", skillName);
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(path.join(skillDir, "SKILL.md"), "original content", "utf-8");

    const results = await updateManagedSkills({});
    expect(results).toEqual([
      {
        name: skillName,
        ok: false,
        message: "simulated update failure",
      },
    ]);
    expect(await fs.readFile(path.join(skillDir, "SKILL.md"), "utf-8")).toBe("original content");
  });
});
