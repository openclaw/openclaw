import { describe, expect, it } from "vitest";
import type { CodexDynamicToolFunctionSpec, JsonObject } from "./protocol.js";
import {
  codexDynamicToolsFingerprint,
  fingerprintCodexThreadConfig,
  fingerprintUserMcpServersConfigPatch,
  readActiveCodexTurnIdsFromResume,
} from "./thread-fingerprints.js";

describe("codexDynamicToolsFingerprint", () => {
  const createMessageTool = (description: string, channelDescription: string) =>
    ({
      type: "function",
      name: "message",
      description,
      inputSchema: {
        type: "object",
        properties: {
          channel: {
            type: "string",
            description: channelDescription,
          },
        },
      },
    }) satisfies CodexDynamicToolFunctionSpec;

  it("remains stable when tools and schema properties are reordered", () => {
    const message = createMessageTool("Send a message.", "Current channel.");
    const reorderedMessage: CodexDynamicToolFunctionSpec = {
      name: message.name,
      type: message.type,
      inputSchema: {
        properties: {
          channel: {
            description: "Current channel.",
            type: "string",
          },
        },
        type: "object",
      },
      description: message.description,
    };
    const search: CodexDynamicToolFunctionSpec = {
      type: "function",
      name: "search",
      description: "Search the current conversation.",
      inputSchema: { type: "object", properties: {} },
    };

    expect(codexDynamicToolsFingerprint([message, search])).toBe(
      codexDynamicToolsFingerprint([search, reorderedMessage]),
    );
  });
});

describe("fingerprintCodexThreadConfig", () => {
  const request = {
    model: "gpt-5.6-sol",
    modelProvider: "openai",
    approvalPolicy: "never",
    approvalsReviewer: "user",
    sandbox: "workspace-write",
    personality: "none",
    serviceTier: "fast",
    developerInstructions: "Keep the current conversation private.",
    config: { features: { hooks: true, plugins: false } },
  };

  it.each<{ setting: string; patch: JsonObject }>([
    { setting: "requested model provider", patch: { requestedModelProvider: "custom" } },
    { setting: "native multi-agent generation", patch: { model: "gpt-5.6-luna" } },
    { setting: "named permissions profile", patch: { permissions: "read-only" } },
  ])("invalidates reuse when $setting changes", ({ patch }) => {
    expect(fingerprintCodexThreadConfig({ ...request, ...patch }, "openai:personal")).not.toBe(
      fingerprintCodexThreadConfig(request, "openai:personal"),
    );
  });

  it("invalidates reuse when the selected authentication profile changes", () => {
    expect(fingerprintCodexThreadConfig(request, "openai:work")).not.toBe(
      fingerprintCodexThreadConfig(request, "openai:personal"),
    );
  });

  it("invalidates reuse when a literal __proto__ app link policy changes", () => {
    const config = (reviewer: string) => ({
      apps: { calendar: { links: { ["__proto__"]: { approvals_reviewer: reviewer } } } },
    });

    expect(fingerprintCodexThreadConfig({ ...request, config: config("user") })).not.toBe(
      fingerprintCodexThreadConfig({ ...request, config: config("auto_review") }),
    );
  });
});

describe("fingerprintUserMcpServersConfigPatch", () => {
  it.each(["header"])("retains literal __proto__ %s keys during redaction", (scope) => {
    const config = (value: string): JsonObject => ({
      mcp_servers: {
        [scope === "server" ? "__proto__" : "calendar"]: {
          url: "https://example.test/mcp",
          http_headers: {
            Authorization: scope === "server" ? value : "synthetic-access-token",
            ...(scope === "header" ? { ["__proto__"]: value } : {}),
          },
        },
      },
    });
    const first = fingerprintUserMcpServersConfigPatch(config("synthetic-first"));
    const second = fingerprintUserMcpServersConfigPatch(config("synthetic-second"));

    expect(first).not.toBe(second);
    expect(first).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(first).not.toContain("synthetic");
    expect(second).not.toContain("synthetic");
  });
});

describe("readActiveCodexTurnIdsFromResume", () => {
  it("uses the bounded initial turns page when Codex returns one", () => {
    expect(
      readActiveCodexTurnIdsFromResume({
        thread: { turns: [{ id: "stale", status: "inProgress" }] },
        initialTurnsPage: {
          data: [{ id: "current", status: "inProgress" }],
        },
      }),
    ).toEqual(["current"]);
  });

  it("falls back to legacy resume turns when no page is returned", () => {
    expect(
      readActiveCodexTurnIdsFromResume({
        thread: { turns: [{ id: "legacy", status: "inProgress" }] },
      }),
    ).toEqual(["legacy"]);
  });
});
