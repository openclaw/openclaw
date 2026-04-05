import { describe, expect, it } from "vitest";
import { findDeep, parseClaudeAuthOutput } from "./cli-delegation.probe.js";
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

describe("parseClaudeAuthOutput", () => {
  it("detects unauthenticated signals from stdout", () => {
    const result = parseClaudeAuthOutput("Not logged in. Run `claude login` to authenticate.");
    expect(result.authenticated).toBe(false);
  });

  it("extracts subscription type from JSON output", () => {
    const json = JSON.stringify({
      status: "authenticated",
      account: { subscriptionType: "max", email: "user@example.com" },
    });
    const result = parseClaudeAuthOutput(json);
    expect(result.authenticated).toBe(true);
    if (result.authenticated) {
      expect(result.subscriptionType).toBe("max");
    }
  });

  it("extracts subscription type from nested JSON", () => {
    const json = JSON.stringify({
      data: { inner: { subscription_type: "pro" } },
    });
    const result = parseClaudeAuthOutput(json);
    expect(result.authenticated).toBe(true);
    if (result.authenticated) {
      expect(result.subscriptionType).toBe("pro");
    }
  });

  it("extracts auth method from JSON output", () => {
    const json = JSON.stringify({
      authMethod: "apiKey",
      subscriptionType: "enterprise",
    });
    const result = parseClaudeAuthOutput(json);
    expect(result.authenticated).toBe(true);
    if (result.authenticated) {
      expect(result.authMethod).toBe("apiKey");
      expect(result.subscriptionType).toBe("enterprise");
    }
  });

  it("treats non-JSON non-unauthenticated output as authenticated", () => {
    const result = parseClaudeAuthOutput("Logged in as user@example.com");
    expect(result.authenticated).toBe(true);
  });
});

describe("findDeep", () => {
  it("finds a key in a flat object", () => {
    expect(findDeep({ subscriptionType: "max" }, ["subscriptionType"])).toBe("max");
  });

  it("finds a key in nested objects", () => {
    expect(findDeep({ a: { b: { plan_type: "pro" } } }, ["plan_type"])).toBe("pro");
  });

  it("returns undefined when key is not found", () => {
    expect(findDeep({ foo: "bar" }, ["subscriptionType"])).toBeUndefined();
  });

  it("skips empty string values", () => {
    expect(findDeep({ subscriptionType: "" }, ["subscriptionType"])).toBeUndefined();
  });
});
