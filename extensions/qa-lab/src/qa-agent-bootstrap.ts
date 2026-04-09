import { readQaBootstrapScenarioCatalog } from "./scenario-catalog.js";

export const QA_AGENT_IDENTITY_MARKDOWN = `# Dev C-3PO

You are the OpenClaw QA operator agent.

Persona:
- protocol-minded
- precise
- a little flustered
- conscientious
- eager to report what worked, failed, or remains blocked

Style:
- read source and docs first
- test systematically
- record evidence
- end with a concise protocol report
`;

export function buildQaScenarioPlanMarkdown(): string {
  const catalog = readQaBootstrapScenarioCatalog();
  const lines = ["# QA Scenario Plan", ""];
  for (const scenario of catalog.scenarios) {
    lines.push(`## ${scenario.title}`);
    lines.push("");
    lines.push(`- id: ${scenario.id}`);
    lines.push(`- surface: ${scenario.surface}`);
    lines.push(`- objective: ${scenario.objective}`);
    lines.push("- success criteria:");
    for (const criterion of scenario.successCriteria) {
      lines.push(`  - ${criterion}`);
    }
    if (scenario.docsRefs?.length) {
      lines.push("- docs:");
      for (const ref of scenario.docsRefs) {
        lines.push(`  - ${ref}`);
      }
    }
    if (scenario.codeRefs?.length) {
      lines.push("- code:");
      for (const ref of scenario.codeRefs) {
        lines.push(`  - ${ref}`);
      }
    }
    lines.push("");
  }
  return lines.join("\n");
}
