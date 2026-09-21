import { describe, expect, it } from "vitest";
import {
  captureAnthropicRequest,
  registerParityHostLifecycle,
} from "./provider-transport-parity.test-support.js";

describe("Anthropic OAuth client identity", () => {
  registerParityHostLifecycle();

  it.each<{ name: string; headers?: Record<string, string>; expected: string }>([
    { name: "missing CLI", headers: undefined, expected: "2.1.278" },
    { name: "older CLI", headers: { "user-agent": "claude-cli/2.1.234" }, expected: "2.1.278" },
    { name: "newer CLI", headers: { "User-Agent": "claude-cli/3.0.0" }, expected: "3.0.0" },
    {
      name: "prerelease",
      headers: { "user-agent": "claude-cli/3.0.0-beta.1" },
      expected: "2.1.278",
    },
  ])("uses one floor-bounded identity for $name", async ({ headers, expected }) => {
    for (const implementation of ["provider", "transport"] as const) {
      const request = await captureAnthropicRequest(implementation, {
        apiKey: "sk-ant-oat01-synthetic",
        model: { id: "claude-fable-5-1" },
        headers,
      });
      expect(request.headers.get("user-agent")).toBe(`claude-cli/${expected}`);
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

  it("preserves case-insensitive header replacement on OAuth requests", async () => {
    for (const implementation of ["provider", "transport"] as const) {
      const request = await captureAnthropicRequest(implementation, {
        apiKey: "sk-ant-oat01-synthetic",
        headers: { "Anthropic-Beta": "synthetic-beta", "User-Agent": "claude-cli/3.0.0" },
      });
      expect(request.headers.get("anthropic-beta")).toBe("synthetic-beta");
      expect(request.headers.get("user-agent")).toBe("claude-cli/3.0.0");
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
});
