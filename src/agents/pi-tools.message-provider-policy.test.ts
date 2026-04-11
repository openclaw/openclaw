import { describe, expect, it } from "vitest";
import { filterToolNamesByMessageProvider } from "./pi-tools.message-provider-policy.js";

const ALL_TOOL_NAMES = [
  "canvas",
  "edit",
  "edit_file",
  "exec",
  "image",
  "multi_edit",
  "pdf",
  "read",
  "read_file",
  "tts",
  "web_fetch",
  "web_search",
  "write",
  "write_file",
];

const DANGEROUS_TOOLS = [
  "edit",
  "edit_file",
  "exec",
  "multi_edit",
  "read",
  "read_file",
  "write",
  "write_file",
];

describe("createOpenClawCodingTools message provider policy", () => {
  it.each(["voice", "VOICE", " Voice "])(
    "does not expose tts tool for normalized voice provider: %s",
    (messageProvider) => {
      const names = new Set(filterToolNamesByMessageProvider(ALL_TOOL_NAMES, messageProvider));
      expect(names.has("tts")).toBe(false);
      // voice merges its own deny list with the default deny list
      for (const tool of DANGEROUS_TOOLS) {
        expect(names.has(tool), `${tool} should be denied for voice`).toBe(false);
      }
    },
  );

  it("keeps tts tool for non-voice providers", () => {
    const names = new Set(filterToolNamesByMessageProvider(ALL_TOOL_NAMES, "discord"));
    expect(names.has("tts")).toBe(true);
  });

  it.each(["telegram", "discord", "slack", "wechat", "signal"])(
    "denies dangerous tools for channel provider: %s",
    (provider) => {
      const names = new Set(filterToolNamesByMessageProvider(ALL_TOOL_NAMES, provider));
      for (const tool of DANGEROUS_TOOLS) {
        expect(names.has(tool), `${tool} should be denied for ${provider}`).toBe(false);
      }
      // safe tools remain available
      expect(names.has("web_search")).toBe(true);
      expect(names.has("tts")).toBe(true);
    },
  );

  it("node provider allowlist restricts to allowed tools only", () => {
    const names = new Set(filterToolNamesByMessageProvider(ALL_TOOL_NAMES, "node"));
    expect(names).toEqual(new Set(["canvas", "image", "pdf", "tts", "web_fetch", "web_search"]));
  });

  it("passes all tools through when provider is undefined", () => {
    const names = filterToolNamesByMessageProvider(ALL_TOOL_NAMES, undefined);
    expect(names).toEqual(ALL_TOOL_NAMES);
  });

  it("passes all tools through when provider is empty string", () => {
    const names = filterToolNamesByMessageProvider(ALL_TOOL_NAMES, "");
    expect(names).toEqual(ALL_TOOL_NAMES);
  });
});
