import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  __resetSkillsManageProposalsForTests,
  approveProposal,
  createProposal,
  getProposal,
  hashSkillFileContent,
  listProposals,
  tryApplyPatch,
  validateSkillQuality,
} from "./skills-manage-proposals.js";

const goodSkillMd = [
  "## Purpose / When to use",
  "Use when deploying services.",
  "## Do not use for",
  "One-off debugging.",
  "## Inputs / prerequisites",
  "kubectl context.",
  "## Procedure",
  "1. Run tests.",
  "2. Deploy.",
  "## Verification",
  "Check pods are ready.",
  "## Pitfalls / failure recovery",
  "If apply fails, roll back.",
  "## Safety constraints",
  "Do not delete production namespaces without approval.",
].join("\n");

afterEach(() => {
  __resetSkillsManageProposalsForTests();
});

describe("validateSkillQuality", () => {
  it("accepts a well-structured draft with score >= 10", () => {
    const r = validateSkillQuality(goodSkillMd);
    expect(r.ok).toBe(true);
    expect(r.score).toBeGreaterThanOrEqual(10);
  });

  it("rejects missing sections", () => {
    const r = validateSkillQuality("# Title\n\nno sections");
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe("quality_incomplete");
  });
});

describe("tryApplyPatch", () => {
  it("applies single replacement", () => {
    const r = tryApplyPatch({ base: "hello world", oldString: "world", newString: "there" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.next).toBe("hello there");
    }
  });

  it("detects ambiguous patch", () => {
    const r = tryApplyPatch({
      base: "aa bb aa",
      oldString: "aa",
      newString: "x",
      replaceAll: false,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errorCode).toBe("patch_ambiguous");
    }
  });
});

describe("skills manage approve", () => {
  it("writes SKILL.md on approve for new proposal", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "smg-"));
    const created = createProposal({
      workspaceDir: root,
      name: "test-skill",
      contents: goodSkillMd,
      kind: "new",
    });
    expect(created.ok).toBe(true);
    if (!created.ok) {
      return;
    }
    const approved = await approveProposal({
      proposalId: created.proposal.id,
      workspaceDir: root,
    });
    expect(approved.ok).toBe(true);
    if (approved.ok) {
      expect(approved.appliedChecks).toEqual([
        "containment",
        "secrets",
        "size",
        "budget",
        "quality",
      ]);
      const md = await fs.readFile(approved.path, "utf8");
      expect(md).toContain("Purpose");
    }
  });

  it("rejects approve when patch base is stale", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "smg-"));
    const skillDir = path.join(root, "skills", "p-skill");
    await fs.mkdir(skillDir, { recursive: true });
    const mdPath = path.join(skillDir, "SKILL.md");
    const v0 = `${goodSkillMd}\nORIG`;
    await fs.writeFile(mdPath, v0, "utf8");
    const h0 = hashSkillFileContent(v0);
    const patched = v0.replace("ORIG", "NEW");
    const created = createProposal({
      workspaceDir: root,
      name: "p-skill",
      contents: patched,
      kind: "patch",
      patch: { oldString: "ORIG", newString: "NEW", baseSkillHash: h0 },
    });
    expect(created.ok).toBe(true);
    if (!created.ok) {
      return;
    }
    await fs.writeFile(mdPath, `${goodSkillMd}\nCHANGED`, "utf8");
    const result = await approveProposal({
      proposalId: created.proposal.id,
      workspaceDir: root,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errorCode).toBe("patch_base_stale");
    }
  });

  it("rejects approve for new proposal when SKILL.md appeared after propose", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "smg-"));
    const created = createProposal({
      workspaceDir: root,
      name: "race-skill",
      contents: goodSkillMd,
      kind: "new",
    });
    expect(created.ok).toBe(true);
    if (!created.ok) {
      return;
    }
    const skillDir = path.join(root, "skills", "race-skill");
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(path.join(skillDir, "SKILL.md"), goodSkillMd, "utf8");
    const approved = await approveProposal({
      proposalId: created.proposal.id,
      workspaceDir: root,
    });
    expect(approved.ok).toBe(false);
    if (!approved.ok) {
      expect(approved.errorCode).toBe("name_conflict");
    }
  });
});

describe("proposal TTL config use", () => {
  it("respects configured TTL in list/get sweeps", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "smg-"));
    const created = createProposal({
      workspaceDir: root,
      name: "ttl-skill",
      contents: goodSkillMd,
      kind: "new",
    });
    expect(created.ok).toBe(true);
    if (!created.ok) {
      return;
    }
    const listedDefault = listProposals(undefined, {});
    expect(listedDefault.some((p) => p.id === created.proposal.id)).toBe(true);

    await new Promise((resolve) => setTimeout(resolve, 5));
    const listedExpired = listProposals(undefined, {
      skills: { manage: { proposalTtlMs: 1 } },
    });
    expect(listedExpired.some((p) => p.id === created.proposal.id)).toBe(false);

    const fetched = getProposal(created.proposal.id, {
      skills: { manage: { proposalTtlMs: 1 } },
    });
    expect(fetched).toBeUndefined();
  });
});
