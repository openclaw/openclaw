import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AnyAgentTool } from "openclaw/plugin-sdk/agent-harness";
import { formatToolExecutionErrorMessage } from "openclaw/plugin-sdk/agent-harness-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCodexDynamicToolBridge } from "./dynamic-tools.js";

// Synthetic, non-usable credential fixture for model-visible redaction coverage.
const SYNTHETIC_BEARER_CREDENTIAL = "bearer-model-visible-credential-1234567890";
// Custom pattern that intentionally does not match the synthetic bearer, so
// formatToolExecutionErrorMessage keeps the credential under default-pattern
// bypass while sanitizeToolResult still applies TOOL_PAYLOAD_REDACT_PATTERNS.
const NONMATCHING_CUSTOM_REDACT_PATTERN = "never-match-custom-redact-pattern-141271";

function createTool(overrides: Partial<AnyAgentTool>): AnyAgentTool {
  return {
    name: "tts",
    description: "Convert text to speech.",
    parameters: { type: "object", properties: {}, additionalProperties: true },
    execute: vi.fn(),
    ...overrides,
  } as unknown as AnyAgentTool;
}

describe("createCodexDynamicToolBridge thrown-error redaction", () => {
  const originalConfigPath = process.env.OPENCLAW_CONFIG_PATH;
  let configDir: string | undefined;

  afterEach(() => {
    if (originalConfigPath === undefined) {
      delete process.env.OPENCLAW_CONFIG_PATH;
    } else {
      process.env.OPENCLAW_CONFIG_PATH = originalConfigPath;
    }
    if (configDir) {
      fs.rmSync(configDir, { force: true, recursive: true });
      configDir = undefined;
    }
  });

  it("redacts credentials from thrown dynamic tool error content items under custom logging patterns", async () => {
    configDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-redact-config-"));
    const configPath = path.join(configDir, "openclaw.json");
    fs.writeFileSync(
      configPath,
      JSON.stringify({ logging: { redactPatterns: [NONMATCHING_CUSTOM_REDACT_PATTERN] } }),
    );
    process.env.OPENCLAW_CONFIG_PATH = configPath;

    const thrown = new Error(
      `Upstream failed: Authorization: Bearer ${SYNTHETIC_BEARER_CREDENTIAL}`,
    );
    const formatted = formatToolExecutionErrorMessage(thrown, "OpenClaw dynamic tool call failed.");
    // Default Authorization/Bearer patterns are not active when only a
    // nonmatching custom pattern is configured, so the formatter still exposes
    // the synthetic credential. The bridge catch path must sanitize afterward.
    expect(formatted).toContain(SYNTHETIC_BEARER_CREDENTIAL);

    const bridge = createCodexDynamicToolBridge({
      tools: [
        createTool({
          name: "credential_lookup",
          execute: vi.fn(async () => {
            throw thrown;
          }),
        }),
      ],
      signal: new AbortController().signal,
    });

    const result = await bridge.handleToolCall({
      threadId: "thread-1",
      turnId: "turn-1",
      callId: "call-throw-credential",
      namespace: null,
      tool: "credential_lookup",
      arguments: {},
    });

    expect(result.success).toBe(false);
    const text = result.contentItems
      .map((item) => (item.type === "inputText" && typeof item.text === "string" ? item.text : ""))
      .join("");
    expect(text).not.toContain(SYNTHETIC_BEARER_CREDENTIAL);
    expect(text).toContain("Authorization: Bearer");
  });
});
