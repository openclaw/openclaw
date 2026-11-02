import { describe, expect, it } from "vitest";
import type { JsonObject } from "./protocol.js";
import {
  codexDynamicToolsFingerprint,
  codexLegacyDynamicToolsFingerprint,
  fingerprintCodexThreadConfig,
  fingerprintRestrictedThreadConfig,
  fingerprintUserMcpServersConfigPatch,
  readActiveCodexTurnIdsFromResume,
} from "./thread-fingerprints.js";

it("preserves legacy JSON bytes, including literal prototype keys and escaped descriptions", () => {
  const tools = [
    {
      type: "function",
      name: "message",
      inputSchema: {
        type: "object",
        required: ["text", "__proto__"],
        properties: {
          text: { type: "string", description: 'Line one\n"Line two"' },
          ["__proto__"]: { type: "string" },
        },
      },
      description: "Send a message.",
    },
  ];
  expect(codexLegacyDynamicToolsFingerprint(tools)).toBe(
    '[{"description":"Send a message.","inputSchema":{"properties":{"__proto__":{"type":"string"},"text":{"description":"Line one\\n\\\"Line two\\\"","type":"string"}},"required":["text","__proto__"],"type":"object"},"name":"message","type":"function"}]',
  );
  expect(codexLegacyDynamicToolsFingerprint([])).toBe("[]");
});

it("keeps hashed tool fingerprints stable when tools are reordered", () => {
  const message = {
    type: "function",
    name: "message",
    inputSchema: { type: "string", description: "Current channel." },
  };
  const search = { ...message, name: "search" };

  expect(codexDynamicToolsFingerprint([message, search])).toBe(
    codexDynamicToolsFingerprint([search, message]),
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

it.each(["ordinary", "restricted"] as const)("preserves %s proxy identity", (kind) => {
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

  const original = fingerprint(41001);
  expect(fingerprint(41002)).toBe(original);
  expect(fingerprint(41002, "https://other.example.com/v1")).not.toBe(original);
  expect(fingerprint(41002, undefined, "work")).not.toBe(original);
  expect(fingerprint(41002, undefined, undefined, false)).not.toBe(original);
});

it("retains literal __proto__ MCP header keys during redaction", () => {
  const headers = (value: string) => ({
    Authorization: "synthetic",
    ["__proto__"]: value,
  });
  const config = (value: string): JsonObject => ({
    mcp_servers: { calendar: { http_headers: headers(value) } },
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
