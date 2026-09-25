/**
 * Real-runtime proof for PR #118555, second half: the drop marker observed at the
 * OUTGOING PROVIDER REQUEST, produced by GENUINELY INSTALLED plugins.
 *
 * `scripts/proof-prompt-build-drop-marker.ts` already pins the marker's contract
 * against the real dispatcher and all three prompt consumers, but it builds its
 * `before_prompt_build` registrations in memory and asserts on the prompt value a
 * consumer RETURNS. That leaves two things unobserved, and they are exactly the
 * two ClawSweeper named as the remaining merge blocker:
 *
 *   1. installed-plugin execution — a plugin that really went through
 *      `openclaw plugins install`, was discovered off disk, passed the operator
 *      consent gate, and had its hook registered by the loader;
 *   2. the outgoing provider request — not a returned string, but the bytes that
 *      actually leave this process on their way to the provider.
 *
 * This proof closes both in one run, and it does so without a single fake above
 * the provider edge.
 *
 * WHAT IS REAL (no vitest, no mocks of the seam under test):
 *   - `installPluginFromPath` (src/plugins/install.ts -> install-package.ts) —
 *     the same programmatic entry `openclaw plugins install <dir>` uses. Each
 *     fixture is packaged, validated (`openclaw.extensions` and manifest checks
 *     really run and really reject a malformed package), and committed to an
 *     install root as a normal installed plugin.
 *   - `loadOpenClawPlugins` (src/plugins/loader.ts) — the real loader:
 *     discovery off disk, provenance/trust reporting, and
 *     `registerTypedHook`'s real consent gate. `before_prompt_build` is a
 *     CONVERSATION hook, so a non-bundled plugin's registration is REFUSED
 *     unless the operator sets
 *     `plugins.entries.<id>.hooks.allowConversationAccess`. This proof sets it
 *     in its own isolated config, exactly as an operator would; it does not
 *     bypass the gate. (Remove that config key and the hooks stop registering —
 *     the loader, not the fixture, decides.)
 *   - `createHookRunner` / `initializeGlobalHookRunner` — the real process
 *     singleton with production options, fed the REAL loaded registry.
 *   - `runCliAgent` (src/agents/cli-runner.ts) end to end: real preparation,
 *     real `before_prompt_build` dispatch, real prompt assembly, real backend
 *     resolution through `setActivePluginRegistry`, and a real child process.
 *   - `withTestRunAdmission` — real `prepareSystemAgentRunAdmission`, so the CLI
 *     path's live-authority assertions run for real.
 *
 * WHERE THE STUB IS, AND WHY IT IS THE ONLY ONE:
 *   The provider edge itself — and nothing above it. One fixture plugin
 *   registers a CLI backend (`api.registerCliBackend`) whose `command` is a
 *   tiny recorder process. `resolvePromptInput` (cli-runner/helpers.ts) routes
 *   the assembled prompt to that process's stdin under `input: "stdin"`, so the
 *   runtime performs a real spawn and the recorder's stdin IS the outgoing
 *   provider request. Substituting the provider binary is the allowed
 *   stub-at-the-very-edge; every byte of the path from the installed plugin's
 *   handler to that spawn is production code.
 *
 * ISOLATION:
 *   `OPENCLAW_HOME` / `OPENCLAW_STATE_DIR` are pointed at a fresh temp tree
 *   before any OpenClaw module is imported (which is why every import below is
 *   dynamic), so installs, state and sessions land in that tree and a running
 *   gateway's real state is never read or written. The tree is removed on exit.
 *
 * SCENARIOS (each one installs its plugins fresh into its own isolated root):
 *   1. Healthy-only turn — ONE installed plugin contributes normally. Its block
 *      is present in the outgoing provider request and there is NO marker. This
 *      is the negative control: a marker that fired unconditionally would
 *      otherwise look like a pass, and ClawSweeper asked for this case by name.
 *   2. Installed healthy/throwing pair — the throwing plugin's handler raises an
 *      error carrying credential-shaped text. The outgoing provider request
 *      RETAINS the healthy plugin's content, carries EXACTLY ONE bounded notice
 *      naming the failing plugin with a fixed reason code, does NOT contain the
 *      exception text, does NOT contain the failing plugin's own block, and does
 *      NOT blame the healthy plugin.
 *   3. Bounded under load — one healthy plugin plus SEVEN throwing plugins, all
 *      installed. The outgoing provider request still carries exactly one
 *      notice: five plugins named, "+2 more", under the byte cap, healthy
 *      content still retained, no exception text.
 *
 * RUN: pnpm tsx scripts/proof-118555-installed-plugin-provider-request.ts
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { OpenClawConfig } from "../src/config/types.openclaw.js";

const MARKER_OPEN = '<dropped_plugin_context hook="before_prompt_build">';
const MARKER_CLOSE = "</dropped_plugin_context>";
/** Mirrors MAX_MARKER_BYTES in src/plugins/prompt-build-drop.ts. */
const MAX_MARKER_BYTES = 640;
/** Mirrors MAX_LISTED_DROPS in src/plugins/prompt-build-drop.ts. */
const MAX_LISTED_DROPS = 5;
/** Stands in for a credential/endpoint a plugin might throw inside an error. */
const SECRET = "AUTH_TOKEN=sk-live-9f3c-PROOF https://internal.invalid/v1/queue";
const HEALTHY_BLOCK =
  "<plans_and_tasks><ready_issues><issue id='openclaw-beads-201'/></ready_issues></plans_and_tasks>";
/** Sentinel the throwing plugin would have contributed had it not failed. */
const FAILING_BLOCK = "<never_contributed_block/>";
const BASE_ASK = "latest ask";

// --- isolation, established before any OpenClaw module is imported ----------
const PROOF_ROOT = fs.realpathSync(
  fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-proof-118555-")),
);
const PROOF_HOME = path.join(PROOF_ROOT, "home");
const PROOF_STATE_DIR = path.join(PROOF_HOME, ".openclaw");
fs.mkdirSync(PROOF_STATE_DIR, { recursive: true });
process.env.OPENCLAW_HOME = PROOF_HOME;
process.env.OPENCLAW_STATE_DIR = PROOF_STATE_DIR;
// Only the fixtures should register, so the assertions cannot be satisfied or
// polluted by a bundled plugin that happens to contribute prompt context.
process.env.OPENCLAW_DISABLE_BUNDLED_PLUGINS = "1";

let checks = 0;

function assert(condition: boolean, description: string): void {
  checks += 1;
  if (!condition) {
    throw new Error(`ASSERTION FAILED: ${description}`);
  }
  console.log(`  ok  ${description}`);
}

const markerBytes = (text: string): number => new TextEncoder().encode(text).length;

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index >= 0) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

/** Extracts the marker out of an outgoing request so its caps can be measured. */
function markerFrom(request: string): string {
  const start = request.indexOf(MARKER_OPEN);
  if (start < 0) {
    return "";
  }
  const end = request.indexOf(MARKER_CLOSE, start);
  return end < 0 ? request.slice(start) : request.slice(start, end + MARKER_CLOSE.length);
}

type FixtureSpec = {
  id: string;
  /** Contribute this text, or throw carrying SECRET when omitted. */
  contributes?: string;
  /** Register the recorder CLI backend from this plugin. */
  providesBackend?: boolean;
};

/** The observed outgoing provider request: the real child process's input. */
type ProviderRequest = {
  argv: string[];
  stdin: string;
};

/**
 * Writes the recorder that stands in for the provider binary. Its stdin is the
 * outgoing provider request; it writes that verbatim to `capturePath`.
 */
function writeRecorder(scenarioDir: string, capturePath: string): string {
  const recorderPath = path.join(scenarioDir, "recorder.mjs");
  fs.writeFileSync(
    recorderPath,
    `import fs from "node:fs";
let stdin = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  stdin += chunk;
});
process.stdin.on("end", () => {
  fs.writeFileSync(
    ${JSON.stringify(capturePath)},
    JSON.stringify({ argv: process.argv.slice(2), stdin }),
  );
  process.stdout.write("recorded\\n");
  process.exit(0);
});
`,
    "utf-8",
  );
  return recorderPath;
}

/** Builds one installable plugin package on disk, in the shape npm would ship. */
function writeFixturePackage(params: {
  spec: FixtureSpec;
  sourceRoot: string;
  recorderPath: string;
}): string {
  const { spec } = params;
  const dir = path.join(params.sourceRoot, spec.id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "openclaw.plugin.json"),
    `${JSON.stringify(
      {
        id: spec.id,
        name: spec.id,
        description: `proof-118555 fixture (${spec.contributes ? "healthy" : "throwing"})`,
        version: "0.0.1",
        main: "index.mjs",
        activation: { onStartup: true },
        configSchema: { type: "object", additionalProperties: false, properties: {} },
      },
      null,
      2,
    )}\n`,
    "utf-8",
  );
  fs.writeFileSync(
    path.join(dir, "package.json"),
    `${JSON.stringify(
      {
        name: spec.id,
        version: "0.0.1",
        type: "module",
        main: "index.mjs",
        openclaw: { extensions: ["./index.mjs"] },
      },
      null,
      2,
    )}\n`,
    "utf-8",
  );
  const handlerBody = spec.contributes
    ? `return { prependContext: ${JSON.stringify(spec.contributes)} };`
    : `throw new Error(${JSON.stringify(`ready-work query failed: ${SECRET}`)});`;
  const backendRegistration = spec.providesBackend
    ? `    api.registerCliBackend({
      id: "proof-118555-cli",
      config: {
        command: process.execPath,
        args: [${JSON.stringify(params.recorderPath)}],
        input: "stdin",
        output: "text",
        sessionMode: "none",
      },
    });
`
    : "";
  fs.writeFileSync(
    path.join(dir, "index.mjs"),
    `export default {
  id: ${JSON.stringify(spec.id)},
  register(api) {
    api.on("before_prompt_build", async () => {
      ${handlerBody}
    });
${backendRegistration}  },
};
`,
    "utf-8",
  );
  return dir;
}

/**
 * Installs the fixtures for real, loads them through the real loader, runs one
 * real CLI turn, and returns the bytes the runtime handed the provider process.
 */
async function runScenario(params: {
  label: string;
  specs: readonly FixtureSpec[];
}): Promise<ProviderRequest> {
  const scenarioDir = fs.mkdtempSync(path.join(PROOF_ROOT, `${params.label}-`));
  const capturePath = path.join(scenarioDir, "provider-request.json");
  const recorderPath = writeRecorder(scenarioDir, capturePath);
  const sourceRoot = path.join(scenarioDir, "packages");
  fs.mkdirSync(sourceRoot, { recursive: true });
  const extensionsDir = path.join(scenarioDir, "extensions");

  const { installPluginFromPath } = await import("../src/plugins/install.js");
  for (const spec of params.specs) {
    const packageDir = writeFixturePackage({ spec, sourceRoot, recorderPath });
    const installed = await installPluginFromPath({ path: packageDir, extensionsDir });
    if (!installed.ok) {
      throw new Error(`install failed for ${spec.id}: ${installed.error}`);
    }
    // The real install committed a real artifact; nothing below reads the
    // source package again, so every registration comes off the install root.
    if (!fs.existsSync(path.join(extensionsDir, spec.id, "index.mjs"))) {
      throw new Error(`install did not commit an artifact for ${spec.id}`);
    }
  }
  fs.rmSync(sourceRoot, { recursive: true, force: true });

  // Operator-side consent, written the way an operator writes it. Conversation
  // hooks from non-bundled plugins do not register without this.
  const config = {
    plugins: {
      allow: params.specs.map((spec) => spec.id),
      entries: Object.fromEntries(
        params.specs.map((spec) => [spec.id, { hooks: { allowConversationAccess: true } }]),
      ),
    },
  } as unknown as OpenClawConfig;

  const { loadOpenClawPlugins } = await import("../src/plugins/loader.js");
  const registry = loadOpenClawPlugins({
    env: { ...process.env, OPENCLAW_STATE_DIR: scenarioDir },
    config,
    activate: true,
    workspaceDir: scenarioDir,
    cache: false,
  });

  const registeredHookPlugins = registry.typedHooks
    .filter((hook) => hook.hookName === "before_prompt_build")
    .map((hook) => hook.pluginId)
    .toSorted();
  const expectedHookPlugins = params.specs.map((spec) => spec.id).toSorted();
  assert(
    registeredHookPlugins.join(",") === expectedHookPlugins.join(","),
    `${params.label}: loader registered before_prompt_build for every INSTALLED fixture (${expectedHookPlugins.length})`,
  );
  assert(
    registry.cliBackends.some((entry) => entry.backend.id === "proof-118555-cli"),
    `${params.label}: the installed plugin's CLI backend is the resolved provider`,
  );

  const { setActivePluginRegistry } = await import("../src/plugins/runtime.js");
  const { initializeGlobalHookRunner } = await import("../src/plugins/hook-runner-global.js");
  setActivePluginRegistry(registry);
  initializeGlobalHookRunner(registry);

  const { CURRENT_SESSION_VERSION } = await import("../src/config/sessions/version.js");
  const sessionFile = path.join(scenarioDir, "session.jsonl");
  fs.writeFileSync(
    sessionFile,
    `${JSON.stringify({
      type: "session",
      version: CURRENT_SESSION_VERSION,
      id: "proof-session",
      timestamp: new Date(0).toISOString(),
      cwd: scenarioDir,
    })}\n`,
    "utf-8",
  );

  const { createTestAdmittedRunContext, withTestRunAdmission } =
    await import("../src/agents/admitted-run-context.test-support.js");
  const { runCliAgent } = await import("../src/agents/cli-runner.js");
  const runId = `proof-118555-${params.label}`;
  const admittedRunContext = createTestAdmittedRunContext(runId);
  await withTestRunAdmission({ admittedRunContext, runId }, async (context) =>
    runCliAgent({
      sessionId: "proof-session",
      sessionFile,
      workspaceDir: scenarioDir,
      prompt: BASE_ASK,
      provider: "proof-118555-cli",
      model: "proof-model",
      timeoutMs: 30_000,
      runId,
      admittedRunContext: context,
      config,
    } as never),
  );

  if (!fs.existsSync(capturePath)) {
    throw new Error(`${params.label}: the provider process was never handed a request`);
  }
  return JSON.parse(fs.readFileSync(capturePath, "utf-8")) as ProviderRequest;
}

/** Asserts the parts of the contract every drop scenario shares. */
function assertDropContract(params: {
  label: string;
  request: string;
  healthyBlock: string;
  failingIds: readonly string[];
}): void {
  const { label, request } = params;
  assert(
    request.includes(params.healthyBlock),
    `${label}: healthy plugin's content is RETAINED in the outgoing provider request`,
  );
  assert(
    countOccurrences(request, MARKER_OPEN) === 1,
    `${label}: outgoing provider request carries EXACTLY ONE loss notice`,
  );
  assert(
    !request.includes("sk-live-9f3c-PROOF") &&
      !request.includes("internal.invalid") &&
      !request.includes("ready-work query failed"),
    `${label}: no exception text reached the outgoing provider request`,
  );
  assert(
    !request.includes(FAILING_BLOCK),
    `${label}: the dropped contribution really is absent (the notice is not the block surviving)`,
  );
  const marker = markerFrom(request);
  assert(
    markerBytes(marker) <= MAX_MARKER_BYTES,
    `${label}: notice is ${markerBytes(marker)} bytes, within the ${MAX_MARKER_BYTES}-byte cap`,
  );
  assert(
    marker.endsWith(MARKER_CLOSE),
    `${label}: notice is a closed, bounded frame in the outgoing request`,
  );
  for (const failingId of params.failingIds) {
    assert(
      marker.includes(`${failingId} (handler-failed)`),
      `${label}: notice names ${failingId} with a fixed reason code`,
    );
  }
}

async function main(): Promise<void> {
  console.log(`isolated install/state root: ${PROOF_ROOT}`);
  console.log(
    "\n[1] healthy-only turn: installed contribution reaches the provider, NO loss notice",
  );
  const healthyOnly = await runScenario({
    label: "healthy-only",
    specs: [{ id: "proof-healthy", contributes: HEALTHY_BLOCK, providesBackend: true }],
  });
  assert(
    healthyOnly.stdin.includes(HEALTHY_BLOCK),
    "healthy-only: installed plugin's block is in the outgoing provider request",
  );
  assert(
    healthyOnly.stdin.includes(BASE_ASK),
    "healthy-only: the user's ask is in the outgoing provider request",
  );
  assert(
    !healthyOnly.stdin.includes(MARKER_OPEN),
    "healthy-only: NO loss notice on a healthy turn (the notice is not unconditional)",
  );

  console.log("\n[2] installed healthy/throwing pair: healthy retained, one bounded notice");
  const pair = await runScenario({
    label: "healthy-throwing-pair",
    specs: [
      { id: "proof-healthy", contributes: HEALTHY_BLOCK, providesBackend: true },
      { id: "proof-throwing" },
    ],
  });
  assertDropContract({
    label: "pair",
    request: pair.stdin,
    healthyBlock: HEALTHY_BLOCK,
    failingIds: ["proof-throwing"],
  });
  assert(
    !markerFrom(pair.stdin).includes("proof-healthy"),
    "pair: the healthy plugin is not blamed in the notice",
  );
  assert(
    pair.stdin.includes(BASE_ASK),
    "pair: the user's ask still reaches the provider alongside the notice",
  );
  console.log("\n--- outgoing provider request (scenario 2), verbatim ---");
  console.log(pair.stdin);
  console.log("--- end outgoing provider request ---");

  console.log("\n[3] seven installed throwing plugins: notice stays bounded at the provider");
  const bulkFailingIds = Array.from({ length: 7 }, (_unused, index) => `proof-bulk-${index}`);
  const bulk = await runScenario({
    label: "bounded-under-load",
    specs: [
      { id: "proof-healthy", contributes: HEALTHY_BLOCK, providesBackend: true },
      ...bulkFailingIds.map((id) => ({ id })),
    ],
  });
  const bulkMarker = markerFrom(bulk.stdin);
  const named = bulkMarker.match(/\(handler-failed\)/gu) ?? [];
  assert(
    named.length === MAX_LISTED_DROPS,
    `bulk: exactly ${MAX_LISTED_DROPS} plugins are named in the outgoing request`,
  );
  assert(
    bulkMarker.includes(`+${bulkFailingIds.length - MAX_LISTED_DROPS} more`),
    `bulk: overflow summary counts the ${bulkFailingIds.length - MAX_LISTED_DROPS} unlisted drops`,
  );
  assertDropContract({
    label: "bulk",
    request: bulk.stdin,
    healthyBlock: HEALTHY_BLOCK,
    failingIds: [],
  });

  console.log(`\nAll runtime assertions passed. (${checks} checks)`);
}

main()
  .then(() => {
    fs.rmSync(PROOF_ROOT, { recursive: true, force: true });
    process.exit(0);
  })
  .catch((error: unknown) => {
    console.error(`\nPROOF FAILED after ${checks} checks:`, error);
    fs.rmSync(PROOF_ROOT, { recursive: true, force: true });
    process.exit(1);
  });
