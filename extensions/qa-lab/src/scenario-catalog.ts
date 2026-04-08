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
  config: z.record(z.string(), z.unknown()).optional(),
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
});

export type QaScenarioExecution = z.infer<typeof qaScenarioExecutionSchema>;
export type QaSeedScenario = z.infer<typeof qaSeedScenarioSchema>;
export type QaScenarioPack = z.infer<typeof qaScenarioPackSchema> & {
  scenarios: QaSeedScenario[];
};

export type QaBootstrapScenarioCatalog = {
  agentIdentityMarkdown: string;
  kickoffTask: string;
  scenarios: QaSeedScenario[];
};

const QA_SCENARIO_PACK_INDEX_PATH = "qa/scenarios/index.md";
const QA_SCENARIO_LEGACY_OVERVIEW_PATH = "qa/scenarios.md";
const QA_SCENARIO_DIR_PATH = "qa/scenarios";
const QA_PACK_FENCE_RE = /```ya?ml qa-pack\r?\n([\s\S]*?)\r?\n```/i;
const QA_SCENARIO_FENCE_RE = /```ya?ml qa-scenario\r?\n([\s\S]*?)\r?\n```/i;

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

function resolveRepoPath(relativePath: string, kind: "file" | "directory" = "file"): string | null {
  for (const dir of walkUpDirectories(import.meta.dirname)) {
    const candidate = path.join(dir, relativePath);
    if (!fs.existsSync(candidate)) {
      continue;
    }
    const stat = fs.statSync(candidate);
    if ((kind === "file" && stat.isFile()) || (kind === "directory" && stat.isDirectory())) {
      return candidate;
    }
  }
  return null;
}

function readTextFile(relativePath: string): string {
  const resolved = resolveRepoPath(relativePath, "file");
  if (!resolved) {
    return "";
  }
  return fs.readFileSync(resolved, "utf8");
}

function readDirEntries(relativePath: string): string[] {
  const resolved = resolveRepoPath(relativePath, "directory");
  if (!resolved) {
    return [];
  }
  return fs.readdirSync(resolved);
}

function extractQaPackYaml(content: string) {
  const match = content.match(QA_PACK_FENCE_RE);
  if (!match?.[1]) {
    throw new Error(
      `qa scenario pack missing \`\`\`yaml qa-pack fence in ${QA_SCENARIO_PACK_INDEX_PATH}`,
    );
  }
  return match[1];
}

function extractQaScenarioYaml(content: string, relativePath: string) {
  const match = content.match(QA_SCENARIO_FENCE_RE);
  if (!match?.[1]) {
    throw new Error(`qa scenario file missing \`\`\`yaml qa-scenario fence in ${relativePath}`);
  }
  return match[1];
}

export function readQaScenarioPackMarkdown(): string {
  const chunks = [readTextFile(QA_SCENARIO_PACK_INDEX_PATH).trim()];
  for (const relativePath of listQaScenarioMarkdownPaths()) {
    chunks.push(readTextFile(relativePath).trim());
  }
  return chunks.filter(Boolean).join("\n\n");
}

export function readQaScenarioPack(): QaScenarioPack {
  const packMarkdown = readTextFile(QA_SCENARIO_PACK_INDEX_PATH).trim();
  if (!packMarkdown) {
    throw new Error(`qa scenario pack not found: ${QA_SCENARIO_PACK_INDEX_PATH}`);
  }
  const parsedPack = qaScenarioPackSchema.parse(
    YAML.parse(extractQaPackYaml(packMarkdown)) as unknown,
  );
  const scenarios = listQaScenarioMarkdownPaths().map((relativePath) =>
    qaSeedScenarioSchema.parse(
      YAML.parse(extractQaScenarioYaml(readTextFile(relativePath), relativePath)) as unknown,
    ),
  );
  return {
    ...parsedPack,
    scenarios,
  };
}

export function listQaScenarioMarkdownPaths(): string[] {
  return readDirEntries(QA_SCENARIO_DIR_PATH)
    .filter((entry) => entry.endsWith(".md") && entry !== "index.md")
    .map((entry) => `${QA_SCENARIO_DIR_PATH}/${entry}`)
    .toSorted();
}

export function readQaScenarioOverviewMarkdown(): string {
  return readTextFile(QA_SCENARIO_LEGACY_OVERVIEW_PATH).trim();
}

export function readQaBootstrapScenarioCatalog(): QaBootstrapScenarioCatalog {
  const pack = readQaScenarioPack();
  return {
    agentIdentityMarkdown: pack.agent.identityMarkdown,
    kickoffTask: pack.kickoffTask,
    scenarios: pack.scenarios,
  };
}

export function readQaScenarioById(id: string): QaSeedScenario {
  const scenario = readQaScenarioPack().scenarios.find((candidate) => candidate.id === id);
  if (!scenario) {
    throw new Error(`unknown qa scenario: ${id}`);
  }
  return scenario;
}

export function readQaScenarioExecutionConfig(id: string): Record<string, unknown> | undefined {
  return readQaScenarioById(id).execution?.config;
}
