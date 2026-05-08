import { describe, expect, it, vi } from "vitest";
import { resolveAgentkitPluginConfig } from "./config.js";
import type { AgentkitPendingApproval } from "./hitl-approvals.js";
import {
  resolveAgentkitHumanApprovalRequestConfig,
  runAgentkitWorldHumanApproval,
} from "./human-approval.js";

function createApproval(id = "plugin:approval-123"): AgentkitPendingApproval {
  return {
    id,
    createdAtMs: 1,
    expiresAtMs: 1000,
    request: {
      pluginId: "agentkit",
      title: "World proof required for agents_list",
      description: "test",
      severity: "warning",
      toolName: "agents_list",
      toolCallId: "tool-call-1",
      agentId: "main",
      sessionKey: "agent:main:test",
    },
  };
}

function createPluginConfig() {
  return resolveAgentkitPluginConfig({
    hitl: {
      enabled: true,
      mode: "human-approval",
      protectedTools: ["agents_list"],
      humanApproval: {
        appId: "app_test",
        rpId: "rp_test",
        signingKey: "0xabc",
        actionPrefix: "openclaw-approval",
      },
    },
  });
}

function createHostedPluginConfig() {
  return resolveAgentkitPluginConfig({
    hitl: {
      enabled: true,
      mode: "human-approval",
      protectedTools: ["agents_list"],
      humanApproval: {
        provider: "hosted",
        brokerUrl: "http://localhost:4123/world-id/sign-request",
        actionPrefix: "openclaw-approval",
      },
    },
  });
}

function fetchInputUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.toString();
  }
  return input.url;
}

function requestBodyText(init: RequestInit | undefined): string {
  const body = init?.body;
  if (typeof body !== "string") {
    throw new Error("expected string request body");
  }
  return body;
}

describe("agentkit world human approval", () => {
  it("resolves human approval credentials from config and env", () => {
    const pluginConfig = resolveAgentkitPluginConfig({
      hitl: {
        enabled: true,
        mode: "human-approval",
        humanApproval: {
          appId: "app_test",
          rpId: "rp_test",
          signingKeyEnvVar: "WORLD_SIGNING_KEY",
        },
      },
    });

    expect(
      resolveAgentkitHumanApprovalRequestConfig({
        pluginConfig,
        env: { WORLD_SIGNING_KEY: "0xabc" },
      }),
    ).toEqual({
      provider: "custom",
      brokerUrl: null,
      appId: "app_test",
      rpId: "rp_test",
      signingKeyHex: "0xabc",
      environment: "production",
      actionPrefix: "openclaw-approval",
    });
  });

  it("recommends environment-backed signing keys when credentials are missing", () => {
    const pluginConfig = resolveAgentkitPluginConfig({
      hitl: {
        enabled: true,
        mode: "human-approval",
        humanApproval: {
          appId: "app_test",
          rpId: "rp_test",
        },
      },
    });

    expect(() =>
      resolveAgentkitHumanApprovalRequestConfig({
        pluginConfig,
        env: {},
      }),
    ).toThrow("humanApproval.signingKeyEnvVar");
  });

  it("resolves hosted human approval through the configured broker", async () => {
    const worldIdRuntime = {
      signRequest: vi.fn(),
      IDKit: {
        request: vi.fn((config: { action: string }) => ({
          preset: vi.fn(async () => ({
            connectorURI: "https://world.org/verify?t=hosted",
            requestId: "request-hosted",
            pollUntilCompletion: vi.fn(async () => ({
              success: true,
              result: {
                protocol_version: "4.0",
                nonce: "nonce-hosted",
                action: config.action,
                environment: "production",
                responses: [{ nullifier: "0xhostednullifier" }],
              },
            })),
          })),
        })),
      },
      orbLegacy: vi.fn(() => ({ type: "OrbLegacy" })),
    };
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      if (fetchInputUrl(input).startsWith("http://localhost:4123/")) {
        return new Response(
          JSON.stringify({
            appId: "app_hosted",
            rpId: "rp_hosted",
            nonce: "nonce-hosted",
            createdAt: 100,
            expiresAt: 200,
            signature: "0xhostedsig",
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      }
      return new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    const result = await runAgentkitWorldHumanApproval({
      approval: createApproval("plugin:approval-hosted"),
      pluginConfig: createHostedPluginConfig(),
      fetchImpl,
      renderQrCode: async () => {},
      logLine: () => {},
      worldIdRuntime: worldIdRuntime as never,
      timeoutMs: 5000,
    });

    expect(worldIdRuntime.signRequest).not.toHaveBeenCalled();
    expect(fetchImpl).toHaveBeenCalledWith(
      "http://localhost:4123/world-id/sign-request",
      expect.objectContaining({
        method: "POST",
      }),
    );
    const brokerRequest = JSON.parse(requestBodyText(fetchImpl.mock.calls[0]?.[1]));
    expect(brokerRequest).toEqual(
      expect.objectContaining({
        action: expect.stringMatching(/^openclaw-approval-/),
        action_description: "Approve agents_list in OpenClaw",
        environment: "production",
        ttl: 30,
      }),
    );
    expect(brokerRequest).not.toHaveProperty("approval");
    expect(worldIdRuntime.IDKit.request).toHaveBeenCalledWith(
      expect.objectContaining({
        app_id: "app_hosted",
        rp_context: expect.objectContaining({
          rp_id: "rp_hosted",
          nonce: "nonce-hosted",
          signature: "0xhostedsig",
        }),
      }),
    );
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://developer.worldcoin.org/api/v4/verify/rp_hosted",
      expect.objectContaining({
        method: "POST",
      }),
    );
    expect(result.success).toBe(true);
    expect(result.nullifier).toBe("0xhostednullifier");
  });

  it("creates a QR approval request, verifies the result, and surfaces the nullifier", async () => {
    const pendingSessions: Array<{
      approvalId: string;
      action: string;
      connectorURI: string;
      requestId: string;
    }> = [];
    const worldIdRuntime = {
      signRequest: vi.fn(() => ({
        sig: "0xsig",
        nonce: "nonce-1",
        createdAt: 100,
        expiresAt: 200,
      })),
      IDKit: {
        request: vi.fn(() => ({
          preset: vi.fn(async () => ({
            connectorURI: "https://world.org/verify?t=test",
            requestId: "request-1",
            pollUntilCompletion: vi.fn(async () => ({
              success: true,
              result: {
                protocol_version: "3.0",
                nonce: "nonce-1",
                environment: "production",
                responses: [{ nullifier: "0xnullifier" }],
              },
            })),
          })),
        })),
      },
      orbLegacy: vi.fn(() => ({ type: "OrbLegacy" })),
    };
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ success: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    const renderQrCode = vi.fn(async () => {});
    const logLine = vi.fn();

    const result = await runAgentkitWorldHumanApproval({
      approval: createApproval(),
      pluginConfig: createPluginConfig(),
      fetchImpl,
      logLine,
      onPending: (session) => {
        pendingSessions.push(session);
      },
      renderQrCode,
      worldIdRuntime: worldIdRuntime as never,
      timeoutMs: 5000,
    });

    expect(pendingSessions).toEqual([
      {
        approvalId: "plugin:approval-123",
        action: expect.stringMatching(/^openclaw-approval-/),
        connectorURI: "https://world.org/verify?t=test",
        requestId: "request-1",
      },
    ]);
    expect(worldIdRuntime.signRequest).toHaveBeenCalled();
    expect(worldIdRuntime.IDKit.request).toHaveBeenCalledWith(
      expect.objectContaining({
        app_id: "app_test",
        rp_context: expect.objectContaining({
          rp_id: "rp_test",
          nonce: "nonce-1",
          signature: "0xsig",
        }),
      }),
    );
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://developer.worldcoin.org/api/v4/verify/rp_test",
      expect.objectContaining({
        method: "POST",
      }),
    );
    expect(result.success).toBe(true);
    expect(result.nullifier).toBe("0xnullifier");
    expect(result.action).toMatch(/^openclaw-approval-/);
  });

  it("rejects completed World proofs with an unexpected nonce before verification", async () => {
    const worldIdRuntime = {
      signRequest: vi.fn(() => ({
        sig: "0xsig",
        nonce: "nonce-expected",
        createdAt: 100,
        expiresAt: 200,
      })),
      IDKit: {
        request: vi.fn(() => ({
          preset: vi.fn(async () => ({
            connectorURI: "https://world.org/verify?t=test",
            requestId: "request-mismatch",
            pollUntilCompletion: vi.fn(async () => ({
              success: true,
              result: {
                protocol_version: "4.0",
                nonce: "nonce-other",
                environment: "production",
                responses: [{ nullifier: "0xnullifier" }],
              },
            })),
          })),
        })),
      },
      orbLegacy: vi.fn(() => ({ type: "OrbLegacy" })),
    };
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ success: true })));

    const result = await runAgentkitWorldHumanApproval({
      approval: createApproval("plugin:approval-mismatch"),
      pluginConfig: createPluginConfig(),
      fetchImpl,
      renderQrCode: async () => {},
      logLine: () => {},
      worldIdRuntime: worldIdRuntime as never,
      timeoutMs: 5000,
    });

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
    expect(result.errorCode).toBe("unexpected_nonce");
  });

  it("surfaces the World error code when the user does not complete the request", async () => {
    const worldIdRuntime = {
      signRequest: vi.fn(() => ({
        sig: "0xsig",
        nonce: "nonce-1",
        createdAt: 100,
        expiresAt: 200,
      })),
      IDKit: {
        request: vi.fn(() => ({
          preset: vi.fn(async () => ({
            connectorURI: "https://world.org/verify?t=test",
            requestId: "request-1",
            pollUntilCompletion: vi.fn(async () => ({
              success: false,
              error: "timeout",
            })),
          })),
        })),
      },
      orbLegacy: vi.fn(() => ({ type: "OrbLegacy" })),
    };

    const result = await runAgentkitWorldHumanApproval({
      approval: createApproval("plugin:approval-timeout"),
      pluginConfig: createPluginConfig(),
      worldIdRuntime: worldIdRuntime as never,
      renderQrCode: async () => {},
      logLine: () => {},
    });

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe("timeout");
    expect(result.verifyStatus).toBeNull();
  });
});
