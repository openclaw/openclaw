import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, promisify } from "node:util";
import { asOptionalRecord as record } from "@openclaw/normalization-core/record-coerce";
import { readToolEffectReceipt } from "../../src/agents/tool-effect-receipt.js";
import { isToolResultError } from "../../src/agents/tool-result-error.js";
import { createToolTerminalObserver } from "../../src/agents/tool-terminal-outcome.js";
import { createComputerTool } from "../../src/agents/tools/computer-tool.js";
import { listNodes } from "../../src/agents/tools/nodes-utils.js";
import { captureRuntimeConfigAsyncReader } from "../../src/config/config.js";
import {
  type ComputerActResult,
  parseComputerActResult,
} from "../../src/plugins/computer-use-contract.js";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const initialText = "P05 RECEIPT BEFORE";
const proofId = randomUUID();
const marker = `OpenClaw receipt proof ${proofId}`;
const interrupted = new AbortController();
const onInterrupt = () => interrupted.abort();
type ToolResult = Awaited<ReturnType<ReturnType<typeof createComputerTool>["execute"]>>;
type ReceiptState = NonNullable<ReturnType<typeof readToolEffectReceipt>>["state"];
let phase = "preflight";
let failure: string | null = null;
let outputDirectory: string | undefined;
let cleanup: ((reason: string) => Promise<void>) | undefined;
const evidence = {
  ok: false,
  route: "computer tool -> Gateway node.invoke -> paired Linux CUA -> terminal observer",
  source: { commit: "", tree: "", harnessSha256: "", trackedRuntimeClean: false },
  runtime: { platform: process.platform, version: process.version },
  provider: { id: "", generationSha256: "" },
  action: {
    name: "type",
    deliveryMode: "background",
    nativeRoute: null as "accessibility" | "synthetic_events" | null,
    nativeDeliveryMode: null as "background" | null,
    attempts: 0,
    ok: false,
    effect: null as ComputerActResult["effect"] | null,
  },
  observation: {
    exactWindowMatches: 0,
    beforeEditableControls: 0,
    beforeMatchesFixture: false,
    followUpOk: false,
    freshWindowObservation: false,
    afterEditableControls: 0,
    markerOccurrences: 0,
  },
  receipt: {
    privateState: null as ReceiptState | null,
    terminalState: null as ReceiptState | null,
    executionStarted: false,
  },
  cleanup: { requested: false, callbackReturned: false },
};

function requireProof(condition: unknown, code: string): asserts condition {
  if (!condition) {
    failure = code;
    throw new Error(code);
  }
}

function actionResult(result: ToolResult): ComputerActResult {
  return parseComputerActResult(record(result.details)?.result);
}

function editors(result: ComputerActResult) {
  return (result.observation?.elements ?? []).filter((element) =>
    /text.?area|text.?field|^(?:text|entry|edit|editable text)$/iu.test(element.role),
  );
}

process.on("SIGINT", onInterrupt);
process.on("SIGTERM", onInterrupt);
try {
  const { values } = parseArgs({
    options: {
      "window-title": { type: "string" },
      artifacts: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
    strict: true,
  });
  if (values.help) {
    console.log(
      "Usage: node --import ./scripts/tsx.mjs scripts/dev/computer-use-effect-receipt-proof.ts --window-title <exact-fixture-title> --artifacts <empty-directory>\n" +
        "Use the isolated Linux X11 paired-node rig, built checkout, and real CUA provider. Its sole editable fixture control must contain exactly P05 RECEIPT BEFORE. Set OPENCLAW_CONFIG_PATH and OPENCLAW_STATE_DIR to the rig's gateway.json and agent-state; remove Gateway URL/token/password overrides.\n" +
        "Sends one background type action, with no retry or foreground fallback. Both base and candidate require an uncertain terminal receipt; the original base should fail that assertion. Writes only allowlisted result.json. The caller owns Gateway, node, fixture, and desktop shutdown.",
    );
    process.exit(0);
  }
  requireProof(values.artifacts && values["window-title"], "arguments_required");
  const artifacts = path.resolve(values.artifacts);
  await mkdir(artifacts, { recursive: true, mode: 0o700 });
  requireProof((await readdir(artifacts)).length === 0, "artifact_directory_not_empty");
  outputDirectory = artifacts;
  requireProof(process.platform === "linux", "linux_required");
  requireProof(
    process.env.DISPLAY &&
      process.env.XDG_SESSION_TYPE !== "wayland" &&
      !process.env.WAYLAND_DISPLAY,
    "x11_session_required",
  );
  requireProof(
    process.env.OPENCLAW_CONFIG_PATH &&
      path.isAbsolute(process.env.OPENCLAW_CONFIG_PATH) &&
      process.env.OPENCLAW_STATE_DIR &&
      path.isAbsolute(process.env.OPENCLAW_STATE_DIR),
    "explicit_rig_config_and_state_required",
  );
  const git = async (...args: string[]) =>
    (
      await execFileAsync("git", args, {
        cwd: repoRoot,
        encoding: "utf8",
        timeout: 10_000,
        maxBuffer: 8_192,
        signal: interrupted.signal,
      })
    ).stdout.trim();
  const commit = await git("rev-parse", "HEAD");
  const tree = await git("rev-parse", "HEAD^{tree}");
  requireProof(/^[a-f0-9]{40}$/u.test(commit), "source_commit_unavailable");
  requireProof(/^[a-f0-9]{40}$/u.test(tree), "source_tree_unavailable");
  evidence.source.commit = commit;
  evidence.source.tree = tree;
  evidence.source.harnessSha256 = createHash("sha256")
    .update(await readFile(fileURLToPath(import.meta.url)))
    .digest("hex");
  await git("diff", "--quiet", "HEAD", "--", "src", "packages", "extensions", "scripts");
  evidence.source.trackedRuntimeClean = true;

  phase = "gateway-config";
  const config = await captureRuntimeConfigAsyncReader()();
  requireProof(
    ["OPENCLAW_GATEWAY_URL", "OPENCLAW_GATEWAY_TOKEN", "OPENCLAW_GATEWAY_PASSWORD"].every(
      (name) => process.env[name] === undefined,
    ),
    "gateway_overrides_not_allowed",
  );
  const port = config.gateway?.port;
  requireProof(
    config.gateway?.mode === "local" &&
      config.gateway.bind === "loopback" &&
      config.gateway.auth?.mode === "token" &&
      typeof config.gateway.auth.token === "string" &&
      config.gateway.auth.token.length > 0 &&
      typeof port === "number" &&
      Number.isInteger(port) &&
      port >= 1024 &&
      port <= 65535 &&
      port !== 18789 &&
      (process.env.OPENCLAW_GATEWAY_PORT === undefined ||
        process.env.OPENCLAW_GATEWAY_PORT === String(port)),
    "isolated_token_gateway_required",
  );

  phase = "node-selection";
  const nodes = (await listNodes({ timeoutMs: 30_000 }, interrupted.signal)).filter(
    (node) =>
      node.connected &&
      node.commands?.includes("computer.act") &&
      node.commands.includes("screen.snapshot"),
  );
  requireProof(nodes.length === 1, "one_computer_node_required");
  const node = nodes[0]!;
  requireProof(node.platform === "linux", "linux_node_required");
  const capability = node.computerUse;
  requireProof(capability?.provider.id === "cua-computer", "real_cua_provider_required");
  requireProof(
    ["list_windows", "get_window_state", "type"].every((action) =>
      capability.actions.some((advertised) => advertised === action),
    ) && capability.deliveryModes.includes("background"),
    "required_cua_surface_unavailable",
  );
  evidence.provider.id = capability.provider.id;
  evidence.provider.generationSha256 = createHash("sha256")
    .update(capability.provider.generation)
    .digest("hex");
  const tool = createComputerTool({
    config,
    computerExecutionId: proofId,
    idempotencyScope: proofId,
    registerRunCleanup: (callback) => {
      cleanup = callback;
    },
  });
  const call = (toolCallId: string, args: Record<string, unknown>) =>
    tool.execute(
      toolCallId,
      { target: "node", node: node.nodeId, timeoutMs: 30_000, ...args },
      interrupted.signal,
    );
  phase = "target-observation";
  const listed = actionResult(await call("windows", { action: "list_windows" }));
  requireProof(listed.ok, "window_listing_failed");
  const windows = Array.isArray(listed.details?.windows)
    ? listed.details.windows.flatMap((value) => {
        const window = record(value);
        return window?.title === values["window-title"] ? [window] : [];
      })
    : [];
  evidence.observation.exactWindowMatches = windows.length;
  requireProof(windows.length === 1, "unique_fixture_window_required");
  const windowRef = windows[0]!.windowRef;
  requireProof(typeof windowRef === "string", "fixture_window_ref_missing");
  const before = actionResult(await call("before", { action: "get_window_state", windowRef }));
  const beforeEditors = editors(before);
  evidence.observation.beforeEditableControls = beforeEditors.length;
  evidence.observation.beforeMatchesFixture =
    beforeEditors.length === 1 && beforeEditors[0]!.value === initialText;
  requireProof(before.ok && before.observation?.observationId, "before_observation_failed");
  requireProof(evidence.observation.beforeMatchesFixture, "single_fixture_editor_required");

  // CUA 0.37 can acknowledge a window-addressed AT-SPI insert without an element
  // readback. The isolated fixture has one process, window, and editable control;
  // this proof never injects an effect, replaces a transport, or retries input.
  const args = {
    action: "type",
    windowRef,
    observationId: before.observation.observationId,
    deliveryMode: "background",
    text: marker,
  };
  phase = "native-action";
  evidence.action.attempts++;
  const result = await call("input", args);
  // Observe the actual object before JSON can discard its private provenance.
  const terminal = createToolTerminalObserver(proofId)({
    toolCallId: "input",
    toolName: "computer",
    arguments: args,
    result,
    executionStarted: true,
    outcome: isToolResultError(result) ? "failure" : "success",
  });
  evidence.receipt.privateState = readToolEffectReceipt(result)?.state ?? null;
  evidence.receipt.terminalState = terminal.effectReceipt.state;
  evidence.receipt.executionStarted = terminal.executionStarted;
  const original = actionResult(result);
  evidence.action.ok = original.ok;
  evidence.action.effect = original.effect ?? null;
  if (
    original.details?.route === "accessibility" ||
    original.details?.route === "synthetic_events"
  ) {
    evidence.action.nativeRoute = original.details.route;
  }
  if (original.details?.deliveryMode === "background") {
    evidence.action.nativeDeliveryMode = "background";
  }
  phase = "follow-up-observation";
  const followUp = parseComputerActResult(record(result.details)?.followUpObservation);
  evidence.observation.followUpOk = followUp.ok;
  evidence.observation.freshWindowObservation =
    followUp.observation?.kind === "window" &&
    typeof followUp.observation.observationId === "string" &&
    followUp.observation.observationId !== before.observation.observationId;
  const afterEditors = editors(followUp);
  evidence.observation.afterEditableControls = afterEditors.length;
  const afterValue = afterEditors.length === 1 ? afterEditors[0]!.value : undefined;
  evidence.observation.markerOccurrences =
    typeof afterValue === "string" ? afterValue.split(marker).length - 1 : 0;
  requireProof(!isToolResultError(result), "computer_tool_result_unsuccessful");
  requireProof(original.ok, "native_action_unsuccessful");
  requireProof(
    original.effect === "unverifiable" || original.effect === "suspected_noop",
    "uncertain_provider_result_required",
  );
  requireProof(
    followUp.ok && evidence.observation.freshWindowObservation,
    "successful_fresh_follow_up_required",
  );
  requireProof(evidence.observation.markerOccurrences === 1, "single_marker_readback_required");
  phase = "terminal-receipt";
  requireProof(terminal.executionStarted, "terminal_execution_not_started");
  requireProof(terminal.effectReceipt.state === "uncertain", "terminal_receipt_was_upgraded");
  requireProof(evidence.receipt.privateState === "uncertain", "private_uncertain_receipt_required");
} catch {
  // Upstream errors can contain endpoints or desktop content. Keep only our
  // fixed phase/code; the runner retains private diagnostic logs separately.
  failure ??= `${phase}_failed`;
} finally {
  if (cleanup) {
    evidence.cleanup.requested = true;
    try {
      await cleanup("completion");
      // Paired-node cleanup is best effort. Process exit is the rig owner's proof.
      evidence.cleanup.callbackReturned = true;
    } catch {
      failure ??= "cleanup_callback_failed";
    }
  }
  process.off("SIGINT", onInterrupt);
  process.off("SIGTERM", onInterrupt);
  evidence.ok = failure === null;
  const report = `${JSON.stringify({ ...evidence, phase, failure }, null, 2)}\n`;
  if (outputDirectory) {
    try {
      await writeFile(path.join(outputDirectory, "result.json"), report, {
        flag: "wx",
        mode: 0o600,
      });
    } catch {
      evidence.ok = false;
      failure = "artifact_write_failed";
    }
  }
  process.stdout.write(`${JSON.stringify({ ...evidence, phase, failure }, null, 2)}\n`);
  process.exitCode = evidence.ok ? 0 : 1;
}
