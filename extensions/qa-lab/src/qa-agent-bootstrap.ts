import {
  DEFAULT_QA_AGENT_IDENTITY_MARKDOWN,
  readQaBootstrapScenarioCatalog,
} from "./scenario-catalog.js";

export function readQaAgentIdentityMarkdown(): string {
  return (
    readQaBootstrapScenarioCatalog().agentIdentityMarkdown || DEFAULT_QA_AGENT_IDENTITY_MARKDOWN
  );
}

export function buildQaScenarioPlanMarkdown(): string {
  const catalog = readQaBootstrapScenarioCatalog();
  const lines = ["# QA Scenario Plan", ""];
  for (const scenario of catalog.scenarios) {
    lines.push(`## ${scenario.title}`);
    lines.push("");
    lines.push(`- id: ${scenario.id}`);
    lines.push(`- surface: ${scenario.surface}`);
    lines.push(`- objective: ${scenario.objective}`);
    if (scenario.execution?.summary) {
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
