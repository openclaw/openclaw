import { describe, expect, it } from "vitest";
import {
  captureAnthropicExchange,
  captureAnthropicRequest,
  registerParityHostLifecycle,
} from "./provider-transport-parity.test-support.js";
import { resetLearnedClaudeCodeVersionForTest } from "./providers/anthropic-model-contract.js";

const versionTooOld = (required: string) => () =>
  new Response(
    JSON.stringify({
      type: "error",
      error: {
        type: "invalid_request_error",
        message: `Claude Code 2.1.280 does not support this model; version ${required} or newer is required. Run 'claude update', or update the Claude desktop app, then try again.`,
        details: { error_code: "claude_code_version_too_old" },
      },
    }),
    { status: 400, headers: { "content-type": "application/json" } },
  );

describe("Anthropic OAuth client identity", () => {
  registerParityHostLifecycle();

  it.each<{ name: string; headers?: Record<string, string>; expected: string }>([
    { name: "missing CLI", headers: undefined, expected: "2.1.280" },
    { name: "older CLI", headers: { "user-agent": "claude-cli/2.1.234" }, expected: "2.1.280" },
    {
      name: "newer CLI",
      headers: { "User-Agent": "claude-cli/3.0.0", "Anthropic-Beta": "synthetic-beta" },
      expected: "3.0.0",
    },
    {
      name: "prerelease",
      headers: { "user-agent": "claude-cli/3.0.0-beta.1" },
      expected: "2.1.280",
    },
  ])("uses one floor-bounded identity for $name", async ({ headers, expected }) => {
    for (const implementation of ["provider", "transport"] as const) {
      const request = await captureAnthropicRequest(implementation, {
        apiKey: "sk-ant-oat01-synthetic",
        model: { id: "claude-fable-5-1" },
        headers,
      });
      expect(request.headers.get("user-agent")).toBe(`claude-cli/${expected}`);
      if (headers?.["Anthropic-Beta"]) {
        expect(request.headers.get("anthropic-beta")).toBe("synthetic-beta");
      }
      expect(request.payload.system).toEqual(
        expect.arrayContaining([
          {
            type: "text",
            text: `x-anthropic-billing-header: cc_version=${expected}; cc_entrypoint=sdk-cli;`,
          },
        ]),
      );
    }
  });

  it.each(["anthropic", "github-copilot", "microsoft-foundry", "cloudflare-ai-gateway"])(
    "keeps non-OAuth %s requests free of Claude identity",
    async (provider) => {
      for (const implementation of ["provider", "transport"] as const) {
        const request = await captureAnthropicRequest(implementation, {
          model: {
            provider,
            ...(provider === "microsoft-foundry" ? { authHeader: true } : {}),
          },
        });
        expect(request.headers.get("user-agent") ?? "").not.toContain("claude-cli/");
        expect(JSON.stringify(request.payload.system)).not.toContain("cc_version=");
      }
    },
  );

  // Body shape captured from api.anthropic.com for claude-fable-5-2 on 2026-11-10.
  it("adopts the Claude Code version Anthropic requires and keeps it", async () => {
    for (const implementation of ["provider", "transport"] as const) {
      resetLearnedClaudeCodeVersionForTest();
      const recorded: string[] = [];
      const first = await captureAnthropicExchange(implementation, {
        apiKey: "sk-ant-oat01-synthetic",
        model: { id: "claude-zzz-9-9" },
        leadingResponses: [versionTooOld("2.1.290")],
        onClaudeCodeVersionRequired: (version) => recorded.push(version),
      });
      expect(recorded).toEqual(["2.1.290"]);
      expect(first.terminal.stopReason).toBe("stop");
      expect(first.requests.map((request) => request.headers.get("user-agent"))).toEqual([
        "claude-cli/2.1.280",
        "claude-cli/2.1.290",
      ]);
      expect(JSON.stringify(first.requests[1]?.payload.system)).toContain("cc_version=2.1.290;");
      const next = await captureAnthropicRequest(implementation, {
        apiKey: "sk-ant-oat01-synthetic",
      });
      expect(next.headers.get("user-agent")).toBe("claude-cli/2.1.290");
    }
    resetLearnedClaudeCodeVersionForTest();
  });

  it("retries a version rejection at most once and never for API keys", async () => {
    for (const implementation of ["provider", "transport"] as const) {
      resetLearnedClaudeCodeVersionForTest();
      const twice = await captureAnthropicExchange(implementation, {
        apiKey: "sk-ant-oat01-synthetic",
        leadingResponses: [versionTooOld("2.1.290"), versionTooOld("2.1.300")],
      });
      expect(twice.requests).toHaveLength(2);
      expect(twice.terminal.stopReason).toBe("error");
      const apiKey = await captureAnthropicExchange(implementation, {
        leadingResponses: [versionTooOld("2.1.290")],
      });
      expect(apiKey.requests).toHaveLength(1);
      expect(apiKey.terminal.stopReason).toBe("error");
    }
    resetLearnedClaudeCodeVersionForTest();
  });

  // Body shape captured from api.anthropic.com for claude-sonnet-5-5 on 2026-11-10.
  it("resends at standard speed when the model has no fast mode and tells the owner", async () => {
    const speedUnsupported = () =>
      new Response(
        JSON.stringify({
          type: "error",
          error: {
            type: "invalid_request_error",
            message:
              "'claude-zzz-9-9' does not support the `speed` parameter. This feature is only available on supported models.",
          },
        }),
        { status: 400, headers: { "content-type": "application/json" } },
      );
    for (const implementation of ["provider", "transport"] as const) {
      const unsupported: string[] = [];
      const exchange = await captureAnthropicExchange(implementation, {
        model: { id: "claude-zzz-9-9" },
        leadingResponses: [speedUnsupported, speedUnsupported],
        onPayloadPatch: (payload) => {
          payload.speed = "fast";
        },
        onFastModeUnsupported: (id) => unsupported.push(id),
      });
      expect(exchange.terminal.stopReason).toBe("error");
      expect(exchange.requests.map((request) => request.payload.speed)).toEqual([
        "fast",
        undefined,
      ]);
      expect(unsupported).toEqual(["claude-zzz-9-9"]);
    }
  });
});
