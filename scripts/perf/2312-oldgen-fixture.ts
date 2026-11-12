// Offline extension of the shared Team fixture; only synthetic paths and owner writes.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { OpenClawConfig } from "../../src/config/types.openclaw.js";
import { parseSkillFrontmatter } from "../../src/skills/loading/frontmatter.js";

export async function seedOldGenerationFixture(stateDir: string, env: NodeJS.ProcessEnv) {
  const configPath = path.join(stateDir, "openclaw.json");
  const config: OpenClawConfig = JSON.parse(readFileSync(configPath, "utf8"));
  const entries = Object.entries(config.agents?.entries ?? {});
  const now = JSON.parse(readFileSync(path.join(stateDir, "team-shape-summary.json"), "utf8")).now;
  const shared = path.join(stateDir, "synthetic-skills");
  mkdirSync(shared);
  const roots = Array.from({ length: 3 }, (_, index) => path.join(shared, String(index)));
  const templates = readdirSync("skills", { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => {
      try {
        return [readFileSync(path.join("skills", entry.name, "SKILL.md"), "utf8")];
      } catch {
        return [];
      }
    });
  if (!templates.length) {
    throw new Error("No public bundled skill templates");
  }
  const skillDigest = createHash("sha256");
  const writeSkill = (root: string, name: string, body: string, description: string) => {
    const directory = path.join(root, name);
    mkdirSync(directory, { recursive: true });
    const content = `---\nname: ${name}\ndescription: ${JSON.stringify(description)}\n---\n${body}\n`;
    skillDigest.update(JSON.stringify([name, content]));
    writeFileSync(path.join(directory, "SKILL.md"), content);
  };
  for (let index = 0; index < 512; index++) {
    const template = templates[index % templates.length]!;
    const bytes = [2048, 4096, 8192, 12288, 16384][index % 5]!;
    writeSkill(
      roots[Math.floor(index / 200)]!,
      `synthetic-guide-${index}`,
      template.repeat(Math.ceil(bytes / template.length)).slice(0, bytes),
      `Synthetic quasar guide ${index}: ${parseSkillFrontmatter(template).description ?? ""} ${template.replace(/^---[\s\S]*?---/, "")}`
        .replace(/\s+/g, " ")
        .slice(0, 450),
    );
  }
  config.skills = {
    ...config.skills,
    load: { ...config.skills?.load, extraDirs: roots },
  };
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  const previousEnv = process.env;
  const databaseBytes: number[] = [];
  try {
    process.env = { ...env };
    const owner = await import("../../src/state/openclaw-agent-db.js");
    const { writeSessionEntry } =
      await import("../../src/config/sessions/session-accessor.sqlite-entry-store.js");
    for (const [agentId, agent] of entries) {
      if (typeof agent.workspace !== "string") {
        throw new Error("Synthetic agent has no workspace");
      }
      writeSkill(
        path.join(agent.workspace, "skills"),
        `synthetic-owner-${agentId}`,
        `# Synthetic owner ${agentId}\nQuasar catalog search and file investigation.\n`,
        `Synthetic quasar catalog guide for ${agentId}`,
      );
      if (agentId !== "main") {
        const database = owner.openOpenClawAgentDatabase({ agentId, env });
        owner.runOpenClawAgentWriteTransaction(
          (db) => {
            for (let index = 0; index < 8; index++) {
              writeSessionEntry(db, `agent:${agentId}:synthetic-${index}`, {
                sessionId: `oldgen-${agentId}-${index}`,
                updatedAt: now,
                createdAt: now,
                visibility: "shared",
                status: "done",
                displayName: `Synthetic ${agentId} ${index}`,
              });
            }
          },
          { agentId, env },
        );
        database.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
        databaseBytes.push(statSync(database.path).size);
        // Close through the owner so every extra agent receives genuine clean-close proof.
        await owner.closeOpenClawAgentDatabasesAsync();
      }
    }
  } finally {
    process.env = previousEnv;
  }
  const result = {
    configuredAgents: entries.length,
    additionalDatabaseCount: databaseBytes.length,
    additionalSessions: databaseBytes.length * 8,
    additionalDatabaseBytes: databaseBytes.reduce((sum, bytes) => sum + bytes, 0),
    skillManifestSha256: skillDigest.digest("hex"),
    sharedSkills: 512,
    sharedDescriptionChars: 450,
    perAgentSkills: 1,
    filesystem:
      process.platform === "darwin" ? "host macOS filesystem; not btrfs" : "host filesystem",
  };
  writeFileSync(path.join(stateDir, "oldgen-fixture.json"), `${JSON.stringify(result, null, 2)}\n`);
  return result;
}
