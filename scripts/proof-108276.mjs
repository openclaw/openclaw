// Real-behavior proof for PR #108276.
//
// The change in src/agents/embedded-agent-subscribe.handlers.tools.ts uses
// sliceUtf16Safe() when building the read-tool "no path" warning preview so a
// 201-code-unit boundary cannot split a surrogate pair. This script crosses a
// process + disk boundary: the parent writes the input event to a temp file,
// spawns a child Node process that loads the production handler, captures the
// emitted warning preview, and writes the result back to disk for the parent to
// assert.

import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const CHILD_MODE = "--child";

const PREVIEW_BOUNDARY = 201;

/**
 * Detects a lone UTF-16 surrogate in a string.
 * A high surrogate (0xD800-0xDBFF) must be followed by a low surrogate, and a
 * low surrogate (0xDC00-0xDFFF) must be preceded by a high surrogate.
 */
function hasLoneSurrogate(value) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (index + 1 >= value.length || next < 0xdc00 || next > 0xdfff) {
        return true;
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      const previous = value.charCodeAt(index - 1);
      if (index === 0 || previous < 0xd800 || previous > 0xdbff) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Builds the minimal ToolHandlerContext needed to drive the read-tool start
 * warning path without booting a full subscription.
 */
function buildMinimalContext(onWarn) {
  return {
    params: {
      runId: "proof-run",
      sessionKey: "proof-session-key",
      sessionId: "proof-session-id",
      agentId: "proof-agent-id",
      onBlockReplyFlush: undefined,
      onAgentEvent: () => undefined,
      onExecutionPhase: () => undefined,
      onToolResult: undefined,
      toolProgressDetail: "explain",
    },
    flushBlockReplyBuffer: () => undefined,
    hookRunner: undefined,
    log: {
      debug: () => undefined,
      trace: () => undefined,
      isEnabled: () => false,
      info: () => undefined,
      warn: (message, meta) => {
        onWarn(message, meta);
      },
    },
    state: {
      toolMetaById: new Map(),
      toolMetas: [],
      acceptedSessionSpawns: [],
      toolSummaryById: new Set(),
      itemActiveIds: new Set(),
      itemStartedCount: 0,
      itemCompletedCount: 0,
      pendingMessagingTargets: new Map(),
      pendingMessagingTexts: new Map(),
      pendingMessagingMediaUrls: new Map(),
      pendingToolMediaUrls: [],
      pendingToolAudioAsVoice: false,
      pendingToolTrustedLocalMedia: false,
      deterministicApprovalPromptPending: false,
      replayState: { replayInvalid: false, hadPotentialSideEffects: false },
      messagingToolSentTexts: [],
      messagingToolSentTextsNormalized: [],
      messagingToolSentMediaUrls: [],
      messagingToolSentTargets: [],
      messagingToolSourceReplyPayloads: [],
      messageToolOnlySourceReplyDelivered: false,
      successfulCronAdds: 0,
      deterministicApprovalPromptSent: false,
      toolExecutionSinceLastBlockReply: false,
      assistantMessageIndex: 0,
    },
    shouldEmitToolResult: () => false,
    shouldEmitToolOutput: () => false,
    emitToolSummary: () => undefined,
    emitToolOutput: () => undefined,
    trimMessagingToolSent: () => undefined,
  };
}

async function runChild(inputPath, outputPath) {
  const { handleToolExecutionStart } =
    await import("../src/agents/embedded-agent-subscribe.handlers.tools.ts");

  const { args, toolCallId } = JSON.parse(readFileSync(inputPath, "utf8"));

  let capturedPreview;
  let capturedMessage;
  const context = buildMinimalContext((message, meta) => {
    capturedMessage = message;
    capturedPreview = meta.argsPreview;
  });

  const result = handleToolExecutionStart(context, {
    type: "tool_execution_start",
    toolName: "read",
    toolCallId,
    args,
  });
  await Promise.resolve(result);

  writeFileSync(
    outputPath,
    JSON.stringify(
      {
        capturedMessage,
        capturedPreview,
        previewLength: capturedPreview?.length,
        hasLoneSurrogate: hasLoneSurrogate(capturedPreview ?? ""),
      },
      null,
      2,
    ),
  );
}

async function runParent() {
  const tempDirectory = mkdtempSync(join(tmpdir(), "proof-108276-"));
  const inputPath = join(tempDirectory, "input.json");
  const outputPath = join(tempDirectory, "output.json");

  // 200 ASCII code units, then an emoji (U+1F600) encoded as a surrogate pair,
  // then one more ASCII character. The 201-code-unit boundary falls inside the
  // surrogate pair, so an unsafe input.slice(0, 201) would end on a high
  // surrogate and produce an invalid string.
  const args = `${"A".repeat(PREVIEW_BOUNDARY - 1)}😀.`;
  writeFileSync(inputPath, JSON.stringify({ args, toolCallId: "proof-tool-call-id" }, null, 2));

  const child = spawn(
    process.execPath,
    ["--import", "tsx", SCRIPT_PATH, CHILD_MODE, inputPath, outputPath],
    {
      cwd: process.cwd(),
      stdio: "inherit",
    },
  );

  await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve(undefined);
      } else {
        reject(new Error(`Child process exited with code ${String(code)}`));
      }
    });
  });

  const result = JSON.parse(readFileSync(outputPath, "utf8"));

  console.log("Input code units:", args.length);
  console.log("Input has lone surrogate:", hasLoneSurrogate(args));
  console.log("Warning fired:", typeof result.capturedMessage === "string");
  console.log("Captured preview length:", result.previewLength);
  console.log("Preview has lone surrogate:", result.hasLoneSurrogate);
  console.log("Preview code points:", [...(result.capturedPreview ?? "")].length);

  const unsafeSlice = args.slice(0, PREVIEW_BOUNDARY);
  console.log("Unsafe slice would have lone surrogate:", hasLoneSurrogate(unsafeSlice));

  if (!result.capturedMessage) {
    throw new Error("Expected the read-tool warning to fire");
  }
  if (result.hasLoneSurrogate) {
    throw new Error("Production preview contains a lone surrogate");
  }
  if (result.previewLength >= PREVIEW_BOUNDARY) {
    throw new Error(`Expected preview length to stay below ${String(PREVIEW_BOUNDARY)} code units`);
  }
  if (!hasLoneSurrogate(unsafeSlice)) {
    throw new Error("Test input did not place the boundary inside a surrogate pair");
  }

  console.log("PASS: read-tool warning preview is surrogate-safe.");
}

async function main() {
  if (process.argv[2] === CHILD_MODE) {
    await runChild(process.argv[3], process.argv[4]);
  } else {
    await runParent();
  }
}

await main();
