import { describe, expect, it } from "vitest";
import {
  CLI_DELEGATION_SENTINEL,
  CLI_DELEGATION_AUTH_METHOD_ID,
  CLI_DELEGATION_PROFILE_ID,
  type ClaudeCliStatus,
  type AdaptedMessage,
} from "./cli-delegation.types.js";

describe("cli-delegation types", () => {
  it("sentinel is a non-empty string that does not look like a real token", () => {
    expect(CLI_DELEGATION_SENTINEL).toBe("__cli_delegation__");
    expect(CLI_DELEGATION_SENTINEL).not.toMatch(/^sk-/);
  });

  it("auth method and profile IDs are consistent", () => {
    expect(CLI_DELEGATION_AUTH_METHOD_ID).toBe("claude-code-cli-delegation");
    expect(CLI_DELEGATION_PROFILE_ID).toContain(CLI_DELEGATION_AUTH_METHOD_ID);
  });

  it("ClaudeCliStatus discriminates correctly", () => {
    const notInstalled: ClaudeCliStatus = { installed: false };
    expect(notInstalled.installed).toBe(false);

    const notAuthed: ClaudeCliStatus = {
      installed: true,
      authenticated: false,
      reason: "not_logged_in",
    };
    expect(notAuthed.installed).toBe(true);
    if (notAuthed.installed) {
      expect(notAuthed.authenticated).toBe(false);
    }

    const authed: ClaudeCliStatus = {
      installed: true,
      authenticated: true,
      subscriptionType: "max",
      authMethod: "subscription",
    };
    expect(authed.installed).toBe(true);
    if (authed.installed && authed.authenticated) {
      expect(authed.subscriptionType).toBe("max");
    }
  });

  it("AdaptedMessage discriminates by kind", () => {
    const delta: AdaptedMessage = { kind: "text_delta", text: "hello" };
    expect(delta.kind).toBe("text_delta");

    const result: AdaptedMessage = {
      kind: "result",
      status: "completed",
      sessionId: "abc",
      usage: { inputTokens: 100, outputTokens: 50 },
    };
    expect(result.kind).toBe("result");
  });
});
