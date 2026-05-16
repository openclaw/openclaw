#!/usr/bin/env node
/**
 * Live repro for WebChat auto-TTS fix (PR #82701).
 * Run: pnpm exec tsx scripts/repro/webchat-auto-tts-live-proof.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { maybeApplyTtsToPayload } from "../../extensions/speech-core/src/tts.ts";
import { buildWebchatAudioContentBlocksFromReplyPayloads } from "../../src/gateway/server-methods/chat-webchat-media.ts";
import { createPluginRecord } from "../../src/plugins/loader-records.ts";
import { createPluginRegistry } from "../../src/plugins/registry.ts";
import {
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "../../src/plugins/runtime.ts";

const noopLogger = {
  info() {},
  warn() {},
  error() {},
  debug() {},
};

async function main() {
  resetPluginRuntimeStateForTest();
  const pluginRegistry = createPluginRegistry({
    logger: noopLogger,
    runtime: {},
    activateGlobalSideEffects: false,
  });
  const record = createPluginRecord({
    id: "repro-mock-tts",
    name: "Repro Mock TTS",
    source: "scripts/repro/webchat-auto-tts-live-proof.mjs",
    origin: "global",
    enabled: true,
    configSchema: false,
  });
  pluginRegistry.registerSpeechProvider(record, {
    id: "mock",
    label: "Mock",
    autoSelectOrder: 1,
    isConfigured: () => true,
    synthesize: async (request) => ({
      audioBuffer: Buffer.from("voice"),
      fileExtension: ".ogg",
      outputFormat: "ogg",
      voiceCompatible: request.target === "voice-note",
    }),
  });
  setActivePluginRegistry(pluginRegistry.registry);

  const prefsPath = path.join(os.tmpdir(), `openclaw-webchat-tts-proof-${process.pid}.json`);
  const cfg = {
    messages: {
      tts: {
        enabled: true,
        provider: "mock",
        prefsPath,
      },
    },
  };

  const blockText = "WebChat block replies should synthesize audio for auto TTS.";
  const blockResult = await maybeApplyTtsToPayload({
    payload: { text: blockText },
    cfg,
    channel: "webchat",
    kind: "block",
  });
  console.log("maybeApplyTtsToPayload(kind=block).mediaUrl =", blockResult.mediaUrl ?? "(none)");
  console.log(
    "maybeApplyTtsToPayload(kind=block).trustedLocalMedia =",
    blockResult.trustedLocalMedia ?? false,
  );

  const toolResult = await maybeApplyTtsToPayload({
    payload: { text: "Intermediate tool output should not be spoken." },
    cfg,
    channel: "webchat",
    kind: "tool",
  });
  console.log("maybeApplyTtsToPayload(kind=tool).mediaUrl =", toolResult.mediaUrl ?? "(none)");

  const mediaPath = blockResult.mediaUrl;
  if (!mediaPath || !fs.existsSync(mediaPath)) {
    throw new Error("expected block TTS to write a local media file");
  }
  const localRoots = [path.dirname(mediaPath)];
  const trustedBlocks = await buildWebchatAudioContentBlocksFromReplyPayloads(
    [{ mediaUrl: mediaPath, trustedLocalMedia: true }],
    { localRoots },
  );
  const untrustedBlocks = await buildWebchatAudioContentBlocksFromReplyPayloads(
    [{ mediaUrl: mediaPath }],
    { localRoots },
  );
  console.log(
    "buildWebchatAudioContentBlocksFromReplyPayloads(trustedLocalMedia=true).length =",
    trustedBlocks.length,
  );
  console.log(
    "buildWebchatAudioContentBlocksFromReplyPayloads(trustedLocalMedia missing).length =",
    untrustedBlocks.length,
  );

  if (blockResult.mediaUrl) {
    fs.rmSync(path.dirname(blockResult.mediaUrl), { recursive: true, force: true });
  }
  try {
    fs.unlinkSync(prefsPath);
  } catch {
    // optional prefs file
  }
}

await main();
