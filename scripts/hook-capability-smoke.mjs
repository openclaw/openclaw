#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const args = process.argv.slice(2);

function readArg(name) {
  const index = args.indexOf(name);
  if (index === -1) {
    return undefined;
  }
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${name} requires a value`);
  }
  return value;
}

const json = args.includes("--json");
const skipTests = args.includes("--skip-tests");
const outputPath = readArg("--output");

function readRepoFile(relativePath) {
  const absolutePath = path.join(repoRoot, relativePath);
  return readFileSync(absolutePath, "utf8");
}

function checkSource(relativePath, description, matcher) {
  let ok = false;
  let detail = "";
  try {
    const source = readRepoFile(relativePath);
    const result = matcher(source);
    ok = result === true || result?.ok === true;
    detail = typeof result === "object" && result?.detail ? result.detail : description;
  } catch (error) {
    detail = error instanceof Error ? error.message : String(error);
  }
  return { name: description, ok, file: relativePath, detail };
}

const sourceChecks = [
  checkSource(
    "src/plugins/hook-types.ts",
    "llm_input is observe-only in the installed/source hook contract",
    (source) => ({
      ok: /llm_input:\s*\([^)]*\)\s*=>\s*Promise<void>\s*\|\s*void/.test(source),
      detail: "expected llm_input handler return type Promise<void> | void",
    }),
  ),
  checkSource(
    "src/plugins/hook-types.ts",
    "llm_output is observe-only in the installed/source hook contract",
    (source) => ({
      ok: /llm_output:\s*\([^)]*\)\s*=>\s*Promise<void>\s*\|\s*void/.test(source),
      detail: "expected llm_output handler return type Promise<void> | void",
    }),
  ),
  checkSource(
    "src/plugins/inspect-shape.ts",
    "plugin shape inspection keeps typed hooks separate from explicit capabilities",
    (source) => ({
      ok:
        source.includes("buildPluginCapabilityEntries") &&
        source.includes("typedHookCount") &&
        source.includes("customHookCount"),
      detail:
        "expected inspect-shape to classify typed hooks separately from capability registrations",
    }),
  ),
  checkSource(
    "src/plugins/hook-types.ts",
    "before_tool_call remains a modifying/blocking hook",
    (source) => ({
      ok: source.includes("PluginHookBeforeToolCallResult") && source.includes("before_tool_call"),
      detail: "expected before_tool_call to reference PluginHookBeforeToolCallResult",
    }),
  ),
  checkSource(
    "extensions/codex/src/app-server/openclaw-owned-tool-runtime-contract.test.ts",
    "Codex dynamic tools have fail-closed before_tool_call coverage",
    (source) => ({
      ok: source.includes("fails closed when before_tool_call blocks a dynamic tool"),
      detail: "expected Codex dynamic tool blocking contract test",
    }),
  ),
  checkSource(
    "extensions/codex/src/app-server/openclaw-owned-tool-runtime-contract.test.ts",
    "Codex dynamic tools have after_tool_call observation coverage",
    (source) => ({
      ok: source.includes("wraps unwrapped dynamic tools with before/after tool hooks"),
      detail: "expected Codex dynamic tool before/after contract test",
    }),
  ),
  checkSource(
    "src/agents/harness/native-hook-relay.test.ts",
    "Codex native PreToolUse relay has a blocking parity test",
    (source) => ({
      ok: source.includes(
        "maps Codex PreToolUse to OpenClaw before_tool_call and blocks before execution",
      ),
      detail: "expected native relay test for Codex PreToolUse blocking",
    }),
  ),
  checkSource(
    "src/agents/harness/native-hook-relay.test.ts",
    "Codex native PostToolUse relay has an observation parity test",
    (source) => ({
      ok: source.includes("maps Codex PostToolUse to OpenClaw after_tool_call observation"),
      detail: "expected native relay test for Codex PostToolUse observation",
    }),
  ),
  checkSource(
    "src/agents/openclaw-owned-tool-runtime-contract.test.ts",
    "OpenClaw-owned Pi tools have fail-closed before_tool_call coverage",
    (source) => ({
      ok: source.includes("fails closed when before_tool_call blocks a Pi dynamic tool"),
      detail: "expected Pi dynamic tool blocking contract test",
    }),
  ),
  checkSource(
    "src/agents/openclaw-owned-tool-runtime-contract.test.ts",
    "OpenClaw-owned Pi tools have after_tool_call observation coverage",
    (source) => ({
      ok: source.includes(
        "preserves partially adjusted before_tool_call params through execution and after_tool_call",
      ),
      detail: "expected Pi dynamic tool after_tool_call contract test",
    }),
  ),
];

const vitestFiles = [
  "src/agents/openclaw-owned-tool-runtime-contract.test.ts",
  "extensions/codex/src/app-server/openclaw-owned-tool-runtime-contract.test.ts",
  "src/agents/harness/native-hook-relay.test.ts",
  "src/plugins/wired-hooks-llm.test.ts",
];

let testResult = {
  skipped: skipTests,
  ok: true,
  command: "not run",
  status: 0,
  stdout: "",
  stderr: "",
};

if (!skipTests) {
  const command = ["node", "scripts/run-vitest.mjs", "run", ...vitestFiles];
  const result = spawnSync(command[0], command.slice(1), {
    cwd: repoRoot,
    encoding: "utf8",
    env: { ...process.env, CI: process.env.CI ?? "1" },
    maxBuffer: 1024 * 1024 * 10,
  });
  testResult = {
    skipped: false,
    ok: result.status === 0,
    command: command.join(" "),
    status: result.status ?? 1,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

const packageJson = JSON.parse(readRepoFile("package.json"));
const generatedAt = new Date().toISOString();
const checksOk = sourceChecks.every((check) => check.ok);
const ok = checksOk && testResult.ok;
const summary = {
  ok,
  generatedAt,
  packageVersion: packageJson.version,
  sourceChecks,
  testResult: {
    skipped: testResult.skipped,
    ok: testResult.ok,
    command: testResult.command,
    status: testResult.status,
  },
};

function stripAnsi(text) {
  const escapeCode = String.fromCharCode(27);
  return String(text || "").replace(new RegExp(`${escapeCode}\\[[0-9;]*m`, "g"), "");
}

function escapeMarkdownTableCell(text) {
  return String(text).replace(/\|/g, "\\|").replace(/\n/g, "<br>");
}

function tail(text, lines = 24) {
  return stripAnsi(text).trim().split("\n").slice(-lines).join("\n");
}

function renderMarkdown() {
  const status = ok ? "PASS" : "FAIL";
  const rows = sourceChecks
    .map(
      (check) =>
        `| ${check.ok ? "✅" : "❌"} | ${escapeMarkdownTableCell(check.name)} | \`${check.file}\` | ${escapeMarkdownTableCell(check.detail)} |`,
    )
    .join("\n");
  const testTail = [tail(testResult.stdout), tail(testResult.stderr)].filter(Boolean).join("\n");
  return (
    `# OpenClaw hook capability smoke report\n\n` +
    `Generated: ${generatedAt}\n` +
    `OpenClaw package version: ${packageJson.version}\n` +
    `Result: **${status}**\n\n` +
    `## Capability checks\n\n` +
    `| Status | Check | File | Detail |\n|---|---|---|---|\n${rows}\n\n` +
    `## Focused verification\n\n` +
    `Command: \`${testResult.command}\`\n\n` +
    `Status: ${testResult.skipped ? "skipped" : testResult.status}\n\n` +
    (testTail ? `\`\`\`text\n${testTail}\n\`\`\`\n\n` : "") +
    `## Interpretation\n\n` +
    `- OpenClaw-owned Pi tools and Codex app-server dynamic tools are expected to fail closed through \`before_tool_call\` and emit \`after_tool_call\` observations.\n` +
    `- Codex-native \`PreToolUse\`/\`PostToolUse\` relay is expected to reach the same OpenClaw hook surfaces for harmless sentinel actions.\n` +
    `- \`llm_input\` and \`llm_output\` stay typed-hook, observe-only surfaces in the current source/inspect contract; do not depend on prompt/response mutation until stable source/types change.\n` +
    `- This is a dry-run upgrade gate. It does not enable fail-closed production enforcement by itself, and any production fail-closed rollout still needs Iris review.\n`
  );
}

const markdown = renderMarkdown();
if (outputPath) {
  const absoluteOutputPath = path.resolve(process.cwd(), outputPath);
  const outputDir = path.dirname(absoluteOutputPath);
  if (!existsSync(outputDir)) {
    mkdirSync(outputDir, { recursive: true });
  }
  writeFileSync(absoluteOutputPath, markdown);
}

if (json) {
  console.log(JSON.stringify(summary, null, 2));
} else {
  console.log(markdown);
}

process.exit(ok ? 0 : 1);
