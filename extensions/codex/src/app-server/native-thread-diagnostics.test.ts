import {
  onInternalDiagnosticEvent,
  resetDiagnosticEventsForTest,
  waitForDiagnosticEventsDrained,
} from "openclaw/plugin-sdk/diagnostic-runtime";
import { afterEach, describe, expect, it } from "vitest";
import {
  CodexNativeThreadLifecycleReason,
  emitCodexNativeThreadLifecycleDiagnostic,
} from "./native-thread-diagnostics.js";

describe("Codex native thread diagnostics", () => {
  afterEach(() => {
    resetDiagnosticEventsForTest();
  });

  it("hashes legacy raw user MCP fingerprints before emitting diagnostics", async () => {
    const events: unknown[] = [];
    const unsubscribe = onInternalDiagnosticEvent((event) => {
      if (event.type === "codex.native_thread.lifecycle") {
        events.push(event);
      }
    });
    try {
      emitCodexNativeThreadLifecycleDiagnostic({
        action: "rotated",
        reason: CodexNativeThreadLifecycleReason.McpConfigMismatch,
        previousUserMcpServersFingerprint:
          '{"mcp_servers":{"private":{"env":{"TOKEN":"secret-token"},"http_headers":{"Authorization":"Bearer hidden"}}}}',
        userMcpServersFingerprint:
          "sha256:1111111111111111111111111111111111111111111111111111111111111111",
      });
      await waitForDiagnosticEventsDrained();
    } finally {
      unsubscribe();
    }

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual(
      expect.objectContaining({
        previousUserMcpServersFingerprint: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
        userMcpServersFingerprint:
          "sha256:1111111111111111111111111111111111111111111111111111111111111111",
      }),
    );
    expect(JSON.stringify(events[0])).not.toContain("secret-token");
    expect(JSON.stringify(events[0])).not.toContain("Authorization");
  });
});
