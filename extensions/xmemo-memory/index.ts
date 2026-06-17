// XMemo Cloud Memory plugin entrypoint.
//
// This plugin makes XMemo (xmemo.dev) the active long-term memory backend for OpenClaw.
// It implements the OpenClaw `kind: "memory"` slot contract by registering a
// MemoryPluginCapability with prompt building, flush planning, and a remote
// MemorySearchManager backed by the XMemo REST API.

import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import type { MemoryPluginRuntime } from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import { buildXMemoPromptSection } from "./src/prompt-section.js";
import { createXMemoMemoryRuntime } from "./src/runtime.js";
import { registerXMemoTools } from "./src/tools.js";

export default definePluginEntry({
  id: "xmemo-memory",
  name: "XMemo Cloud Memory",
  description: "Cloud-backed long-term memory for OpenClaw via XMemo.",
  kind: "memory",
  register(api) {
    api.registerMemoryCapability({
      promptBuilder: buildXMemoPromptSection,
      flushPlanResolver: () => ({
        // XMemo does not rely on local transcript flushing; keep conservative
        // defaults so OpenClaw does not discard context aggressively.
        softThresholdTokens: 8192,
        forceFlushTranscriptBytes: 524_288,
        reserveTokensFloor: 2048,
        prompt: "",
        systemPrompt: "",
        relativePath: "",
      }),
      runtime: createXMemoMemoryRuntime(api),
    });

    registerXMemoTools(api);
  },
});
