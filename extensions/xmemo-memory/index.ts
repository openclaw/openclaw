// XMemo Cloud Memory plugin entrypoint.
//
// This plugin makes XMemo (xmemo.dev) the active long-term memory backend for OpenClaw.
// It implements the OpenClaw `kind: "memory"` slot contract by registering a
// MemoryPluginCapability with prompt building, flush planning, and a remote
// MemorySearchManager backed by the XMemo REST API.

import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { registerXMemoAutoCapture } from "./src/auto-capture.js";
import { registerXMemoCli } from "./src/cli.js";
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
      // XMemo is a remote memory backend; there is no local transcript flush
      // path. Returning null keeps OpenClaw from writing memory files locally.
      flushPlanResolver: () => null,
      runtime: createXMemoMemoryRuntime(api),
    });

    registerXMemoTools(api);
    registerXMemoAutoCapture(api);
    registerXMemoCli(api);
  },
});
