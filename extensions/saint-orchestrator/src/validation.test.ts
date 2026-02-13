import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { validateConfigWrite } from "./validation.js";

async function createWorkspace(prefix: string): Promise<string> {
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  await fs.mkdir(path.join(workspaceDir, "config"), { recursive: true });
  return workspaceDir;
}

describe("validateConfigWrite cross-file compatibility", () => {
  it("rejects contacts tiers not present in current tiers.yaml", async () => {
    const workspaceDir = await createWorkspace("saint-validation-contacts-");
    try {
      await fs.writeFile(
        path.join(workspaceDir, "config", "tiers.yaml"),
        "custom:\n  intern:\n    tools: [web_search]\n",
        "utf-8",
      );
      const result = await validateConfigWrite({
        workspaceDir,
        relPath: "config/contacts.json",
        content: JSON.stringify({
          contacts: [{ slug: "alice", tier: "unknown-tier" }],
        }),
      });

      expect(result.ok).toBe(false);
      expect(result.errors.join("\n")).toContain("unknown tier");
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("fails contacts write when current tiers.yaml is invalid", async () => {
    const workspaceDir = await createWorkspace("saint-validation-invalid-tiers-");
    try {
      await fs.writeFile(path.join(workspaceDir, "config", "tiers.yaml"), "fixed: [", "utf-8");
      const result = await validateConfigWrite({
        workspaceDir,
        relPath: "config/contacts.json",
        content: JSON.stringify({
          contacts: [{ slug: "alice", tier: "owner" }],
        }),
      });

      expect(result.ok).toBe(false);
      expect(result.errors.join("\n")).toContain("tiers.yaml is invalid YAML");
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("rejects tiers.yaml updates incompatible with existing contacts.json", async () => {
    const workspaceDir = await createWorkspace("saint-validation-tiers-");
    try {
      await fs.writeFile(
        path.join(workspaceDir, "config", "contacts.json"),
        JSON.stringify({
          contacts: [{ slug: "alice", tier: "intern" }],
        }),
        "utf-8",
      );

      const result = await validateConfigWrite({
        workspaceDir,
        relPath: "config/tiers.yaml",
        content: "fixed:\n  owner:\n    tools: [read]\n",
      });

      expect(result.ok).toBe(false);
      expect(result.errors.join("\n")).toContain("contacts.json compatibility check");
      expect(result.errors.join("\n")).toContain("unknown tier");
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });
});
