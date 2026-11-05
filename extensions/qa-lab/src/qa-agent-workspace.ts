import fs from "node:fs/promises";
import path from "node:path";
import {
  readQaBootstrapScenarioCatalog,
  readQaScenarioPackYamlSource,
  type QaSeedScenarioWithSource,
} from "./scenario-catalog.js";

function buildQaScenarioPlanMarkdown(scenarios: readonly QaSeedScenarioWithSource[]): string {
  const lines = ["# QA Scenario Plan", ""];
  for (const scenario of scenarios) {
    lines.push(`## ${scenario.title}`);
    lines.push("");
    lines.push(`- id: ${scenario.id}`);
    lines.push(`- surface: ${scenario.surface}`);
    lines.push(`- objective: ${scenario.objective}`);
    if (scenario.execution.summary) {
      lines.push(`- execution: ${scenario.execution.summary}`);
    }
    lines.push("- success criteria:");
    for (const criterion of scenario.successCriteria) {
      lines.push(`  - ${criterion}`);
    }
    for (const [label, refs] of [
      ["docs", scenario.docsRefs],
      ["code", scenario.codeRefs],
    ] as const) {
      if (refs?.length) {
        lines.push(`- ${label}:`, ...refs.map((ref) => `  - ${ref}`));
      }
    }
    lines.push("");
  }
  return lines.join("\n");
}

export async function seedQaAgentWorkspace(params: { workspaceDir: string; repoRoot?: string }) {
  const catalog = readQaBootstrapScenarioCatalog();
  await fs.mkdir(params.workspaceDir, { recursive: true });

  const files = new Map<string, string>([
    ["IDENTITY.md", catalog.agentIdentityMarkdown],
    ["QA_KICKOFF_TASK.md", catalog.kickoffTask],
    ["QA_SCENARIO_PLAN.md", buildQaScenarioPlanMarkdown(catalog.scenarios)],
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
    await fs.symlink(
      params.repoRoot,
      repoLinkPath,
      process.platform === "win32" ? "junction" : "dir",
    );
  }
}
