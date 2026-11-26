/**
 * Always-sent tool definition size for a default unsandboxed vision run; synthetic, no Gateway.
 * Builds the real core tool set, applies the real Tool Search or Code Mode catalog, and sums the
 * provider-visible definitions. Run it against a checkout of each revision:
 *   node --import ./scripts/tsx.mjs scripts/perf/on-demand-tool-surface-measure.ts \
 *     --root /path/to/checkout --samples 5
 * Sizes are JSON characters of { name, description, parameters }; tokens are chars / 4.
 * Compaction time covers tool construction excluded; it is not whole-turn latency.
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    root: { type: "string", default: "." },
    samples: { type: "string", default: "5" },
    iterations: { type: "string", default: "200" },
  },
});
const root = resolve(values.root);
const samples = Number(values.samples);
const iterations = Number(values.iterations);
assert(Number.isSafeInteger(samples) && samples > 0);
assert(Number.isSafeInteger(iterations) && iterations > 0);
// Never touch a real installation's state; tool construction may open the state database.
process.env.OPENCLAW_STATE_DIR = mkdtempSync(join(tmpdir(), "openclaw-on-demand-measure-"));
const load = async <T>(path: string): Promise<T> =>
  (await import(pathToFileURL(resolve(root, path)).href)) as T;

const { createOpenClawCodingTools } = await load<typeof import("../../src/agents/agent-tools.js")>(
  "src/agents/agent-tools.ts",
);
const { createAgentHarnessToolSurfaceRuntimeCore } = await load<
  typeof import("../../src/agents/harness/tool-surface-bridge.js")
>("src/agents/harness/tool-surface-bridge.ts");
const { setActivePluginRegistry } =
  await load<typeof import("../../src/plugins/runtime.js")>("src/plugins/runtime.ts");
const { createEmptyPluginRegistry } = await load<
  typeof import("../../src/plugins/registry-empty.js")
>("src/plugins/registry-empty.ts");
setActivePluginRegistry(createEmptyPluginRegistry());

type Mode = "tools" | "code-mode";
const chars = (tool: { name: string; description?: string; parameters?: unknown }) =>
  JSON.stringify({ name: tool.name, description: tool.description, parameters: tool.parameters })
    .length;

function surface(mode: Mode) {
  const config = {
    agents: { entries: { main: {} } },
    tools:
      mode === "tools"
        ? { codeMode: false, toolSearch: { enabled: true, mode: "tools" as const } }
        : { codeMode: true, toolSearch: false as const },
  };
  // The embedded attempt's surface runtime; the opt-in is inert on the baseline.
  const runtime = createAgentHarnessToolSurfaceRuntimeCore({
    config,
    agentId: "main",
    sessionKey: "agent:main:main",
    modelToolsEnabled: true,
    loadsOnDemandTools: true,
  });
  assert.equal(runtime.codeModeControlsEnabled, mode === "code-mode");
  const tools = createOpenClawCodingTools({
    config,
    agentId: "main",
    sessionKey: "agent:main:main",
    sessionId: "measure",
    workspaceDir: "/tmp/openclaw-on-demand-measure",
    modelProvider: "anthropic",
    modelId: "measure-model",
    includeToolSearchControls: runtime.includeToolSearchControls,
    githubPublicationAvailable: true,
    toolSearchCatalogRef: runtime.toolSearchCatalogRef,
  });
  return { tools, cleanup: runtime.cleanup, run: () => runtime.compactTools(tools) };
}

const report: Record<string, unknown> = { root, samples, iterations };
for (const mode of ["tools", "code-mode"] as const) {
  const sizes: number[] = [];
  let visibleNames: string[] = [];
  let heavy: Record<string, number> = {};
  for (let sample = 0; sample < samples; sample++) {
    const { tools, cleanup, run } = surface(mode);
    const visible = run().tools;
    sizes.push(visible.reduce((sum, tool) => sum + chars(tool), 0));
    visibleNames = visible.map((tool) => tool.name);
    heavy = Object.fromEntries(
      tools
        .filter((tool) => tool.name === "computer" || tool.name === "github_publish")
        .map((tool) => [tool.name, chars(tool)]),
    );
    cleanup();
  }
  assert(
    sizes.every((size) => size === sizes[0]),
    "definition size must be deterministic",
  );
  const timing = surface(mode);
  for (let warm = 0; warm < 20; warm++) {
    timing.run();
  }
  const started = performance.now();
  for (let index = 0; index < iterations; index++) {
    timing.run();
  }
  const perCallMs = (performance.now() - started) / iterations;
  timing.cleanup();
  report[mode] = {
    alwaysSentChars: sizes[0],
    estimatedTokens: Math.round(sizes[0]! / 4),
    visibleToolCount: visibleNames.length,
    sendsComputer: visibleNames.includes("computer"),
    sendsGithubPublish: visibleNames.includes("github_publish"),
    heavyToolDefinitionChars: heavy,
    compactionMsPerCall: Number(perCallMs.toFixed(4)),
  };
}
const { createGitHubPublishTool } = await load<
  typeof import("../../src/agents/tools/github-publish-tool.js")
>("src/agents/tools/github-publish-tool.ts");
report.githubPublishDescriptionChars = {
  unsandboxed: createGitHubPublishTool().description.length,
  withoutPublication: createGitHubPublishTool({ publicationAvailable: false }).description.length,
  observationOnly: createGitHubPublishTool({ observationOnly: true }).description.length,
};
console.log(JSON.stringify(report, null, 2));
process.exit(0);
