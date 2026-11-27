import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { isDirectRunUrl } from "./lib/direct-run.mjs";
import { loadRatchetSources, runPerFileCountRatchet } from "./lib/shrink-ratchet.mts";

// Request and history shaping must follow declared capability (model compat, catalog rows,
// transcript policy), never a guess from a provider id, model id, API name or URL. This is a
// tripwire on spelling, not a parser: each comparison, predicate or probe below counts once per
// occurrence, and the per-file allowlist may only shrink.
const BASELINE_PATH = "config/provider-branching-allowlist.txt";
const BASELINE_HEADER = [
  "# Provider, model, API and URL branches on the request/history path, per file.",
  "# Ratchet: counts may only shrink. Declare the behavior in model compat or the owning plugin.",
  "# Format: repo-relative path, tab, positive count. Zero-count files are omitted.",
  "",
].join("\n");
// `glob` magic: without it, `**/` needs at least one directory and top-level files escape.
const PATHSPECS = [
  "src/agents/**/*.ts",
  "src/plugins/provider-replay*.ts",
  "src/plugins/provider-runtime.ts",
  "packages/ai/src/**/*.ts",
  "packages/llm-core/src/**/*.ts",
].map((glob) => `:(glob)${glob}`);
const EXCLUDE = [
  "**/*.test.ts",
  "**/*.test-*.ts",
  "**/*.e2e.ts",
  "**/*test-support*",
  "**/*test-harness*",
  "**/*test-helpers*",
  "**/test-support/**",
  "**/test-harness/**",
  "**/test-helpers/**",
  "**/*.generated.ts",
  // Provider identity is these owners' subject, not request shaping: CLI backend adapters,
  // per-provider credentials and model selection.
  "src/agents/cli-output*",
  "src/agents/cli-runner*",
  "src/agents/cli-runner/**",
  "src/agents/auth-profiles/**",
  "src/agents/model-auth*",
  "src/agents/model-catalog*",
  "src/agents/model-selection*",
].map((glob) => `:(exclude,glob)${glob}`);

const VENDORS =
  "anthropic|openai|google|gemini|bedrock|mistral|codex|claude|vertex|ollama|copilot|moonshot|kimi|deepseek|qwen|xai|grok|gpt|zai|glm|mimo|minimax|openrouter|azure|cloudflare|litellm|vllm|lmstudio";
const VENDOR_NAMES =
  "Anthropic|OpenAI|Openai|Google|Gemini|Bedrock|Mistral|Codex|Responses|Completions|Claude|Vertex|Ollama|Copilot|Moonshot|Kimi|Deepseek|DeepSeek|Qwen|Xai|Grok|Gpt|GPT|Zai|Glm|MiMo|Mimo|OpenRouter|Openrouter|Azure|Endpoint|BaseUrl";
const IDENTITY = String.raw`(?:\w*[pP]rovider(?:Id)?|\w*[mM]odelId|\w*[mM]odelApi|\bapi|model\.id|endpointClass|hostname)`;
const NOT_DECLARATION = String.raw`(?<!function\s{1,4})`;
const PATTERNS = [
  // An identity field compared with a literal.
  new RegExp(String.raw`${IDENTITY}\s*[!=]==?\s*["'\x60]`, "gu"),
  // A named provider, model or URL predicate, called (declarations do not count).
  new RegExp(
    String.raw`${NOT_DECLARATION}\b(?:is|uses|supports|needs|requires|should|has)\w*?(?:${VENDOR_NAMES})\w*\s*\(`,
    "gu",
  ),
  // URL and model-size guesses read as flags or named without a vendor word.
  new RegExp(
    String.raw`${NOT_DECLARATION}\b(?:usesExplicitProxyLikeEndpoint\b(?!\s*\()|isLocalModelLeanEnabled\b|isSmallModel\b)`,
    "gu",
  ),
  new RegExp(String.raw`\bcase\s+["'][\w./-]*(?:${VENDORS})[\w./-]*["']`, "gu"),
  // Substring probes of model ids, provider ids and hosts.
  new RegExp(
    String.raw`\.(?:startsWith|endsWith|includes)\(\s*["'\x60][^"'\x60\n]*(?:${VENDORS}|localhost|127\.0\.0\.1)`,
    "giu",
  ),
  new RegExp(String.raw`/\^?[^/\n]*(?:${VENDORS})[^/\n]*/[a-z]*\.test\(`, "giu"),
  // Membership of an identity field in a list or set.
  new RegExp(String.raw`\.(?:has|includes)\(\s*[\w.?]*${IDENTITY}\s*\)`, "gu"),
];
// Type checks and imports name no branch.
const IGNORED = [/\btypeof\s+[\w$.?]+\s*[!=]==?\s*["'`]\w+["'`]/gu, /^import\s[^;]*;/gmu];

/** Counts provider, model, API and URL branches in one source file. */
export function countProviderBranches(source: string) {
  const text = IGNORED.reduce((rest, pattern) => rest.replace(pattern, " "), source);
  return PATTERNS.reduce((sum, pattern) => sum + (text.match(pattern)?.length ?? 0), 0);
}

function collectCurrent(root: string, staged: boolean) {
  const files = execFileSync("git", ["ls-files", "-z", "--", ...PATHSPECS, ...EXCLUDE], {
    cwd: root,
    encoding: "utf8",
  })
    .split("\0")
    .filter(Boolean);
  const sources = staged
    ? loadRatchetSources(root, files)
    : new Map(
        files
          .filter((file) => fs.existsSync(path.join(root, file)))
          .map((file) => [file, fs.readFileSync(path.join(root, file), "utf8")]),
      );
  const counts = new Map<string, number>();
  for (const [file, source] of sources) {
    const count = countProviderBranches(source);
    if (count > 0) {
      counts.set(file, count);
    }
  }
  return counts;
}

export function main(root = process.cwd(), argv = process.argv.slice(2)) {
  return runPerFileCountRatchet(root, argv, {
    baselinePath: BASELINE_PATH,
    baselineHeader: BASELINE_HEADER,
    renameSourceRoots: ["src", "packages"],
    collectCurrent: ({ staged }) => collectCurrent(root, staged),
    countAtRef: (ref, filePath) =>
      countProviderBranches(loadRatchetSources(root, [filePath], ref).get(filePath) ?? ""),
    messages: {
      increaseTitle: "Provider/model/URL branches exceed the per-file allowlist:",
      expansionTitle: "The provider-branching allowlist may only shrink:",
      guidance:
        "Do not branch request or history shaping on a provider id, model id, API name or URL. Declare the behavior as model compat in the owning provider plugin's catalog, or read an existing compat or transcript-policy field.",
      countNoun: "branches",
      successTitle: "Provider branching ratchet OK",
    },
  });
}

if (isDirectRunUrl(process.argv[1], import.meta.url)) {
  process.exitCode = main();
}
