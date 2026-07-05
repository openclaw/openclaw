// Qa Lab plugin module implements qa agent workspace behavior.
import fs from "node:fs/promises";
import path from "node:path";
import { buildQaScenarioPlanMarkdown, readQaAgentIdentityMarkdown } from "./qa-agent-bootstrap.js";
import {
  readQaBootstrapScenarioCatalog,
  readQaScenarioPackYamlSource,
} from "./scenario-catalog.js";

<<<<<<< HEAD
function resolveQaAgentWorkspaceRepoLinkType(platform: NodeJS.Platform = process.platform) {
  return platform === "win32" ? "junction" : "dir";
}

=======
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
export async function seedQaAgentWorkspace(params: { workspaceDir: string; repoRoot?: string }) {
  const catalog = readQaBootstrapScenarioCatalog();
  await fs.mkdir(params.workspaceDir, { recursive: true });

  const kickoffTask = catalog.kickoffTask || "QA mission unavailable.";
  const files = new Map<string, string>([
    ["IDENTITY.md", readQaAgentIdentityMarkdown()],
    ["QA_KICKOFF_TASK.md", kickoffTask],
    ["QA_SCENARIO_PLAN.md", buildQaScenarioPlanMarkdown()],
    ["QA_SCENARIOS.yaml", readQaScenarioPackYamlSource()],
  ]);

  if (params.repoRoot) {
    files.set(
      "README.md",
      `# QA Workspace

- repo: ./repo/
- kickoff: ./QA_KICKOFF_TASK.md
- scenario plan: ./QA_SCENARIO_PLAN.md
- scenario pack: ./QA_SCENARIOS.yaml
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

  if (params.repoRoot) {
    const repoLinkPath = path.join(params.workspaceDir, "repo");
    await fs.rm(repoLinkPath, { force: true, recursive: true });
<<<<<<< HEAD
    await fs.symlink(params.repoRoot, repoLinkPath, resolveQaAgentWorkspaceRepoLinkType());
  }
}

const testing = {
  resolveQaAgentWorkspaceRepoLinkType,
};

export { testing as __testing };
=======
    await fs.symlink(params.repoRoot, repoLinkPath, "dir");
  }
}
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
