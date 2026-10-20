import { describe, expect, it } from "vitest";
import type { CodexDynamicToolFunctionSpec, JsonObject } from "./protocol.js";
import {
  codexDynamicToolsFingerprint,
  fingerprintCodexThreadConfig,
  fingerprintRestrictedThreadConfig,
  fingerprintUserMcpServersConfigPatch,
  readActiveCodexTurnIdsFromResume,
} from "./thread-fingerprints.js";

it("keeps tool fingerprints stable when tools and schema properties are reordered", () => {
  const message: CodexDynamicToolFunctionSpec = {
    type: "function",
    name: "message",
    description: "Send a message.",
    inputSchema: {
      type: "object",
      properties: { channel: { type: "string", description: "Current channel." } },
    },
  };
  const reorderedMessage: CodexDynamicToolFunctionSpec = {
    name: message.name,
    type: message.type,
    inputSchema: {
      properties: { channel: { description: "Current channel.", type: "string" } },
      type: "object",
    },
    description: message.description,
  };
  const search = { ...message, name: "search" };

  expect(codexDynamicToolsFingerprint([message, search])).toBe(
    codexDynamicToolsFingerprint([search, reorderedMessage]),
  );
});

describe("fingerprintCodexThreadConfig", () => {
  const request = { model: "gpt-5.6-sol", modelProvider: "openai" };

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

describe.each(["ordinary", "restricted"] as const)("%s proxied thread fingerprint", (kind) => {
  function fingerprint(
    port: number,
    upstream = "https://api.example.com/v1",
    auth = "personal",
    hooks = true,
  ) {
    const route = {
      baseUrl: `http://127.0.0.1:${port}/private-route`,
      configurationIdentity: upstream,
    };
    const request = {
      config: {
        openai_base_url: route.baseUrl,
        model_providers: { custom: { base_url: route.baseUrl } },
        "model_providers.custom": { base_url: route.baseUrl },
        "model_providers.custom.base_url": route.baseUrl,
        features: { hooks },
      },
    };
    const inference = {
      inferenceRoute: route,
      inferenceProviderRoutes: new Map([["custom", route]]),
    };
    return kind === "ordinary"
      ? fingerprintCodexThreadConfig(request, auth, "tools", undefined, inference)
      : fingerprintRestrictedThreadConfig(request, auth, "tools", {}, false, undefined, inference);
  }

  it("keeps identity across proxy restarts", () => {
    expect(fingerprint(41001)).toBe(fingerprint(41002));
  });

  it("retains upstream, auth profile, and other configuration identity", () => {
    const original = fingerprint(41001);
    expect(fingerprint(41002, "https://other.example.com/v1")).not.toBe(original);
    expect(fingerprint(41002, undefined, "work")).not.toBe(original);
    expect(fingerprint(41002, undefined, undefined, false)).not.toBe(original);
  });
});

it("retains literal __proto__ MCP header keys during redaction", () => {
  const config = (value: string): JsonObject => ({
    mcp_servers: {
      calendar: {
        http_headers: {
          Authorization: "synthetic-access-token",
          ["__proto__"]: value,
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

it.each([true, false])("reads active turn IDs with an initial page: %s", (hasPage) => {
  expect(
    readActiveCodexTurnIdsFromResume({
      thread: { turns: [{ id: "legacy", status: "inProgress" }] },
      ...(hasPage && { initialTurnsPage: { data: [{ id: "current", status: "inProgress" }] } }),
    }),
  ).toEqual([hasPage ? "current" : "legacy"]);
});
