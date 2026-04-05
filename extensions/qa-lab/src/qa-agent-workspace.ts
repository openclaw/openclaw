import fs from "node:fs/promises";
import path from "node:path";
import { buildQaScenarioPlanMarkdown, QA_AGENT_IDENTITY_MARKDOWN } from "./qa-agent-bootstrap.js";
import { readQaBootstrapScenarioCatalog } from "./scenario-catalog.js";

export async function seedQaAgentWorkspace(params: { workspaceDir: string; repoRoot?: string }) {
  const catalog = readQaBootstrapScenarioCatalog();
  await fs.mkdir(params.workspaceDir, { recursive: true });

  const kickoffTask = catalog.kickoffTask || "QA mission unavailable.";
  const files = new Map<string, string>([
    ["IDENTITY.md", QA_AGENT_IDENTITY_MARKDOWN],
    ["QA_KICKOFF_TASK.md", kickoffTask],
    ["QA_SCENARIO_PLAN.md", buildQaScenarioPlanMarkdown()],
  ]);

  if (params.repoRoot) {
    files.set(
      "README.md",
      `# QA Workspace

- repo: ./repo/
- kickoff: ./QA_KICKOFF_TASK.md
- scenario plan: ./QA_SCENARIO_PLAN.md
- identity: ./IDENTITY.md

The mounted repo source should be available read-only under \`./repo/\`.
`,
    );
  }

  await Promise.all(
    [...files.entries()].map(async ([name, body]) => {
      await fs.writeFile(path.join(params.workspaceDir, name), `${body.trim()}\n`, "utf8");
    }),
  );
}
