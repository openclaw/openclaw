import { execFileSync } from "node:child_process";
import { isDirectRunUrl } from "./lib/direct-run.mjs";
import { runPerFileCountRatchet } from "./lib/shrink-ratchet.mts";

// Request and history shaping must follow declared capability (model compat, catalog rows,
// transcript policy), never a guess from a provider id, model id, API name or URL. Each line on
// the request/history path that branches on one of those counts once. Existing lines are listed
// in the allowlist, which may only shrink. Same rule as the 2026-11-27 provider-branching audit.
const BASELINE_PATH = "config/provider-branching-allowlist.txt";
const BASELINE_HEADER = [
  "# Provider, model, API and URL branches on the request/history path, per file.",
  "# Ratchet: counts may only shrink. Declare the behavior in model compat or the owning plugin.",
  "# Format: repo-relative path, tab, positive count. Zero-count files are omitted.",
  "",
].join("\n");
const PATHSPECS = [
  "src/agents/**/*.ts",
  "src/plugins/provider-replay*.ts",
  "src/plugins/provider-runtime.ts",
  "packages/ai/src/**/*.ts",
  "packages/llm-core/src/**/*.ts",
];
const NAMES =
  "Provider|Model|Anthropic|OpenAI|Openai|Google|Gemini|Bedrock|Mistral|Codex|Responses|Completions|Claude|Vertex|Ollama|Copilot|Moonshot|Kimi|Deepseek|DeepSeek|Qwen|Xai|Grok";
const IDS =
  "anthropic|openai|google|bedrock|amazon-bedrock|mistral|openai-responses|openai-completions|openai-codex-responses|anthropic-messages|google-generative-ai|google-vertex|codex|bedrock-converse-stream|ollama";
const BRANCH = new RegExp(
  [
    // A provider, API, transport, model or auth field compared with a literal.
    String.raw`(?:provider|providerId|modelApi|\bapi|transport|modelId|model\.id|model\.provider|model\.api|authMode|auth\.mode|auth\.type|endpointClass)\s*(?:===|!==|==|!=)\s*["'\x60]`,
    // A named provider/model predicate call.
    String.raw`\b(?:is|uses|supports|needs|requires)(?:[A-Z][A-Za-z]*)?(?:${NAMES})[A-Za-z]*\s*\(`,
    String.raw`case\s+["'](?:${IDS})["']`,
    String.raw`\.(?:startsWith|includes)\(["'](?:claude|gpt|gemini|o[0-9]|anthropic|openai|google|mistral|deepseek|qwen|kimi|grok)`,
    // Named URL and model-size guesses the patterns above do not see.
    String.raw`\b(?:usesExplicitProxyLikeEndpoint|isLocalModelLeanEnabled|isLocalBaseUrl|shouldDropClaudeThinkingBlocks|isSmallModel)\b`,
  ].join("|"),
  "u",
);
const EXCLUDE = [
  "*.test.ts",
  "*.test-*.ts",
  "*.e2e.ts",
  "*test-support*",
  "*test-harness*",
  "*test-helpers*",
  "*.generated.ts",
  "test/**",
  "test-helpers/**",
  "fixtures/**",
].map((glob) => `:(exclude,glob)**/${glob}`);

/** One branch per line, as the audit counted. */
export function countProviderBranches(source: string) {
  return source.split("\n").filter((line) => BRANCH.test(line)).length;
}

function collectCurrent(root: string, staged: boolean) {
  let output = "";
  try {
    output = execFileSync(
      "git",
      [
        "grep",
        "-I",
        "-P",
        ...(staged ? ["--cached"] : []),
        "-e",
        BRANCH.source,
        "--",
        ...PATHSPECS,
        ...EXCLUDE,
      ],
      { cwd: root, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 },
    );
  } catch (error) {
    // git grep exits 1 when nothing matches.
    if ((error as { status?: number }).status !== 1) {
      throw error;
    }
  }
  const counts = new Map<string, number>();
  for (const row of output.split("\n")) {
    const separator = row.indexOf(":");
    if (separator > 0) {
      const file = row.slice(0, separator);
      counts.set(file, (counts.get(file) ?? 0) + 1);
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
      countProviderBranches(
        execFileSync("git", ["show", `${ref}:${filePath}`], {
          cwd: root,
          encoding: "utf8",
          maxBuffer: 256 * 1024 * 1024,
          stdio: ["ignore", "pipe", "ignore"],
        }),
      ),
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
