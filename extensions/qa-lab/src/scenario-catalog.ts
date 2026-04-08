import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { z } from "zod";

export const DEFAULT_QA_AGENT_IDENTITY_MARKDOWN = `# Dev C-3PO

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
- end with a concise protocol report`;

const qaScenarioExecutionSchema = z.object({
  kind: z.literal("custom").default("custom"),
  handler: z.string().trim().min(1),
  summary: z.string().trim().min(1).optional(),
});

const qaSeedScenarioSchema = z.object({
  id: z.string().trim().min(1),
  title: z.string().trim().min(1),
  surface: z.string().trim().min(1),
  objective: z.string().trim().min(1),
  successCriteria: z.array(z.string().trim().min(1)).min(1),
  docsRefs: z.array(z.string().trim().min(1)).optional(),
  codeRefs: z.array(z.string().trim().min(1)).optional(),
  execution: qaScenarioExecutionSchema.optional(),
});

const qaScenarioPackSchema = z.object({
  version: z.number().int().positive(),
  agent: z
    .object({
      identityMarkdown: z.string().trim().min(1),
    })
    .default({
      identityMarkdown: DEFAULT_QA_AGENT_IDENTITY_MARKDOWN,
    }),
  kickoffTask: z.string().trim().min(1),
  scenarios: z.array(qaSeedScenarioSchema).min(1),
});

export type QaScenarioExecution = z.infer<typeof qaScenarioExecutionSchema>;
export type QaSeedScenario = z.infer<typeof qaSeedScenarioSchema>;
export type QaScenarioPack = z.infer<typeof qaScenarioPackSchema>;

export type QaBootstrapScenarioCatalog = {
  agentIdentityMarkdown: string;
  kickoffTask: string;
  scenarios: QaSeedScenario[];
};

const QA_SCENARIO_PACK_PATH = "qa/scenarios.md";
const QA_PACK_FENCE_RE = /```ya?ml qa-pack\r?\n([\s\S]*?)\r?\n```/i;

function walkUpDirectories(start: string): string[] {
  const roots: string[] = [];
  let current = path.resolve(start);
  while (true) {
    roots.push(current);
    const parent = path.dirname(current);
    if (parent === current) {
      return roots;
    }
    current = parent;
  }
}

function resolveRepoFile(relativePath: string): string | null {
  for (const dir of walkUpDirectories(import.meta.dirname)) {
    const candidate = path.join(dir, relativePath);
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return candidate;
    }
  }
  return null;
}

function readTextFile(relativePath: string): string {
  const resolved = resolveRepoFile(relativePath);
  if (!resolved) {
    return "";
  }
  return fs.readFileSync(resolved, "utf8");
}

function extractQaPackYaml(content: string) {
  const match = content.match(QA_PACK_FENCE_RE);
  if (!match?.[1]) {
    throw new Error(
      `qa scenario pack missing \`\`\`yaml qa-pack fence in ${QA_SCENARIO_PACK_PATH}`,
    );
  }
  return match[1];
}

export function readQaScenarioPackMarkdown(): string {
  return readTextFile(QA_SCENARIO_PACK_PATH).trim();
}

export function readQaScenarioPack(): QaScenarioPack {
  const markdown = readQaScenarioPackMarkdown();
  if (!markdown) {
    throw new Error(`qa scenario pack not found: ${QA_SCENARIO_PACK_PATH}`);
  }
  const parsed = YAML.parse(extractQaPackYaml(markdown)) as unknown;
  return qaScenarioPackSchema.parse(parsed);
}

export function readQaBootstrapScenarioCatalog(): QaBootstrapScenarioCatalog {
  const pack = readQaScenarioPack();
  return {
    agentIdentityMarkdown: pack.agent.identityMarkdown,
    kickoffTask: pack.kickoffTask,
    scenarios: pack.scenarios,
  };
}
