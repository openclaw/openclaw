/**
 * Pure renderer workload: 100 skills near the 18k-char cap; no filesystem/DB scan.
 * Save the baseline owner beside the current one so relative imports resolve:
 * git show <base>:src/agents/system-prompt-skills.ts > src/agents/.skills-prompt-baseline.ts
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/skills-prompt-measure.ts \
 *   --baseline src/agents/.skills-prompt-baseline.ts
 * Remove the saved owner after measurement. Output contains synthetic data only.
 */
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { Type } from "typebox";
import { buildKnowledgeMemoryPrompt } from "../../extensions/knowledge/src/memory-prompt.js";
import { buildMemoryPromptSection } from "../../extensions/memory-core/src/memory-tool-contract.js";
import { buildCodeModeCatalogPrompt } from "../../src/agents/code-mode.js";
import { searchInstalledSkills } from "../../src/agents/installed-skill-catalog.js";
import { buildSkillsSection } from "../../src/agents/system-prompt-skills.js";
import { buildAgentSystemPrompt } from "../../src/agents/system-prompt.js";
import type { ToolSearchCatalogEntry } from "../../src/agents/tool-search-types.js";
import { createEmptyPluginRegistry } from "../../src/plugins/registry-empty.js";
import { setActivePluginRegistry } from "../../src/plugins/runtime.js";
import { prepareSkillsForPrompt } from "../../src/skills/loading/skill-prompt-limits.js";
import { createCanonicalFixtureSkill } from "../../src/skills/test-support/test-helpers.js";

const { values } = parseArgs({
  options: {
    baseline: { type: "string" },
    iterations: { type: "string", default: "2000" },
    output: { type: "string" },
  },
});
assert(values.baseline, "--baseline must name the saved baseline owner");
assert(global.gc, "Use --expose-gc");
const baseline: typeof import("../../src/agents/system-prompt-skills.js") = await import(
  pathToFileURL(resolve(values.baseline)).href
);
const iterations = Number(values.iterations);
assert(Number.isSafeInteger(iterations) && iterations > 0);
const skills = Array.from({ length: 100 }, (_, i) =>
  createCanonicalFixtureSkill({
    name: `workflow-${String(i).padStart(3, "0")}`,
    description:
      "Inspect the requested maintenance task, collect evidence and follow its verification workflow.",
    filePath: `/synthetic/agent/skills/workflow-${String(i).padStart(3, "0")}/SKILL.md`,
    baseDir: "/synthetic/agent/skills",
    source: "workspace",
  }),
);
const catalog = prepareSkillsForPrompt({ skills, maxSkillsInPrompt: 100 });
assert.equal(catalog.skills.length, 100);
const toolNames = [
  "exec",
  "wait",
  "computer",
  "message",
  "github_publish",
  "openclaw",
  "sessions_yield",
  "view_image",
];
const capabilityToolNames = [
  "read",
  "write",
  "edit",
  "process",
  "skills_search",
  "skills_read",
  "sessions_spawn",
  "sessions_list",
  "session_status",
  "skill_workshop",
  "automations",
  "web_search",
  "web_fetch",
  "dashboard",
  "portal",
  "progress_card",
];
capabilityToolNames.push(
  "memory_search",
  "memory_get",
  "sessions_search",
  "sessions_history",
  "knowledge_lookup",
  "knowledge_grep",
  "knowledge_record",
  "knowledge_recall",
  "knowledge_remember",
  "knowledge_save_page",
  "knowledge_status",
  "knowledge_ontology",
  "knowledge_attach",
  "knowledge_publish_batch",
  "knowledge_verify",
  "knowledge_correct",
  "knowledge_withdraw",
  "knowledge_merge",
);
// Production-shaped inventory; no private tool or skill metadata is required.
while (capabilityToolNames.length < 113) {
  capabilityToolNames.push(`synthetic_tool_${capabilityToolNames.length}`);
}
const toolCatalog: ToolSearchCatalogEntry[] = capabilityToolNames.map((name) => ({
  id: `openclaw:core:${name}`,
  source: "openclaw",
  sourceName: "core",
  name,
  description: "Inspect synthetic maintenance state.",
  parameters: Type.Object({ query: Type.String(), limit: Type.Optional(Type.Integer()) }),
  tool: {
    name,
    label: name,
    description: "Synthetic maintenance tool",
    parameters: Type.Object({}),
    execute: async () => {
      throw new Error("Measurement tools cannot execute");
    },
  },
}));
for (let i = 0; i < 80; i++) {
  const name = `remote_tool_${i}`,
    serverName = i < 2 ? "alpha" : "beta";
  toolCatalog.push({
    ...toolCatalog[0]!,
    id: `mcp:${serverName}:${name}`,
    name,
    source: "mcp",
    sourceName: serverName,
    mcp: { serverName, safeServerName: serverName, toolName: name, operation: "tool" },
  });
}
const params: Parameters<typeof buildSkillsSection>[0] = {
  skillsPrompt: catalog.prompt,
  readToolName: "read",
  codeModeActive: true,
  promptSurface: "openclaw_main",
  visibleTools: new Map(toolNames.map((name) => [name, name])),
  availableTools: new Set([...toolNames, ...capabilityToolNames]),
};
const before = () => baseline.buildSkillsSection(params);
const after = () => buildSkillsSection(params);
const beforeSection = before().section.filter(Boolean).join("\n");
const afterSection = after().section.filter(Boolean).join("\n");
assert(beforeSection.includes("<available_skills>"));
assert(!afterSection.includes("<available_skills>"));
assert(afterSection.includes("skills.search") && afterSection.includes("skills.read"));
const registry = createEmptyPluginRegistry();
registry.memoryCapabilities.push({
  pluginId: "knowledge",
  capability: { promptBuilder: buildKnowledgeMemoryPrompt },
});
registry.memoryPromptSupplements.push({
  pluginId: "memory-core",
  builder: buildMemoryPromptSection,
});
setActivePluginRegistry(registry);
const candidate = buildAgentSystemPrompt({
  workspaceDir: "/synthetic/loop",
  toolNames,
  capabilityToolNames,
  codeModeActive: true,
  skillsPrompt: catalog.prompt,
  toolSchemaDirectoryPrompt: buildCodeModeCatalogPrompt({}, toolCatalog),
  runtimeInfo: {
    channel: "webchat",
    agentId: "synthetic",
    sessionKey: "agent:synthetic:dashboard:loop",
  },
  contextFiles: [
    {
      path: "/synthetic/loop/AGENTS.md",
      content: "Run maintenance checks and report verified results.",
    },
  ],
});
assert(candidate.includes(afterSection));
const original = candidate.replace(afterSection, beforeSection);
function sections(prompt: string) {
  const headings = [...prompt.matchAll(/^#{1,3} .+$/gm)];
  return headings
    .map((heading, i) => ({
      name: heading[0],
      chars: (headings[i + 1]?.index ?? prompt.length) - heading.index,
    }))
    .toSorted((a, b) => b.chars - a.chars);
}
let checksum = 0;
function batch(run: typeof before) {
  for (let i = 0; i < iterations; i++) {
    checksum += run().section.length;
  }
}
for (let i = 0; i < 100; i++) {
  before();
  after();
}
function timing(run: typeof before) {
  global.gc!();
  const cpu = process.cpuUsage(),
    started = performance.now();
  batch(run);
  const wallMs = performance.now() - started,
    used = process.cpuUsage(cpu);
  return { wallMs, cpuMs: (used.user + used.system) / 1000 };
}
const aa = Array.from({ length: 5 }, () => [timing(before), timing(before)]);
const ab = Array.from({ length: 5 }, (_, i) =>
  i % 2
    ? { after: timing(after), before: timing(before) }
    : { before: timing(before), after: timing(after) },
);
async function allocation(run: typeof before) {
  global.gc!();
  const inspector = new Session();
  inspector.connect();
  try {
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: 1024,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
    batch(run);
    const { profile } = await inspector.post("HeapProfiler.stopSampling");
    return profile.samples.reduce((sum, sample) => sum + sample.size, 0) / iterations;
  } finally {
    inspector.disconnect();
  }
}
const allocations = [];
for (let i = 0; i < 5; i++) {
  allocations.push(
    i % 2
      ? { after: await allocation(after), before: await allocation(before) }
      : { before: await allocation(before), after: await allocation(after) },
  );
}
// Search is unchanged but may run more often without the listing. Separate its
// first body-index preparation from warm queries; in-memory content excludes disk I/O.
const search = [];
for (let i = 0; i < 5; i++) {
  const installed = skills.map((skill) => ({
    name: skill.name,
    description: skill.description,
    location: skill.filePath,
    source: {
      filePath: skill.filePath,
      readContent: `Inspect maintenance evidence ${i}. `.repeat(140),
    },
  }));
  const times = [];
  for (let query = 0; query < 2; query++) {
    const cpu = process.cpuUsage(),
      start = performance.now();
    const found = await searchInstalledSkills(
      installed,
      "maintenance evidence",
      5,
      undefined,
      () => true,
    );
    const used = process.cpuUsage(cpu);
    assert(found.skills.length > 0);
    times.push({
      wallMs: performance.now() - start,
      cpuMs: (used.user + used.system) / 1000,
      coverage: found.coverage,
    });
  }
  search.push({ cold: times[0], warm: times[1] });
}
const result = {
  workload: {
    skills: skills.length,
    catalogChars: catalog.prompt.length,
    iterations,
    catalogTools: toolCatalog.length,
    scope:
      "skills section renderer; synthetic core/Code Mode/knowledge/memory prompt excludes unknown plugin/hook contributions",
    loadavg: loadavg(),
  },
  chars: {
    before: original.length,
    after: candidate.length,
    saved: original.length - candidate.length,
  },
  estimatedTokensAtFourChars: {
    before: Math.ceil(original.length / 4),
    after: Math.ceil(candidate.length / 4),
  },
  sections: { before: sections(original), after: sections(candidate) },
  aa,
  ab,
  allocations,
  search,
  checksum,
};
if (values.output) {
  await writeFile(
    values.output,
    JSON.stringify({ ...result, prompts: { before: original, after: candidate } }, null, 2),
  );
}
console.log(JSON.stringify(result, null, 2));
