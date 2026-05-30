import crypto from "node:crypto";
import { createCapturedPluginRegistration } from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, describe, expect, it } from "vitest";
import entry from "./index.js";

const TOKEN_ENV = "OPENCLAW_TEST_CAPABILITY_MANIFEST_JWT";
const SECRET_ENV = "OPENCLAW_TEST_CAPABILITY_MANIFEST_SECRET";
const SECRET = "test-secret-for-capability-manifest-verifier";

function base64UrlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function signManifest(payload: Record<string, unknown>, secret = SECRET): string {
  const header = base64UrlJson({ alg: "HS256", typ: "JWT" });
  const body = base64UrlJson(payload);
  const signature = crypto
    .createHmac("sha256", secret)
    .update(`${header}.${body}`)
    .digest("base64url");
  return `${header}.${body}.${signature}`;
}

function setManifest(payload: Record<string, unknown>): void {
  process.env[TOKEN_ENV] = signManifest(payload);
  process.env[SECRET_ENV] = SECRET;
}

async function evaluateTool(toolName: string, pluginConfig: Record<string, unknown> = {}) {
  const captured = createCapturedPluginRegistration({ id: "capability-manifest-verifier" });
  captured.api.pluginConfig = {
    manifestJwtEnv: TOKEN_ENV,
    manifestSecretEnv: SECRET_ENV,
    ...pluginConfig,
  };

  entry.register(captured.api);

  expect(captured.trustedToolPolicies).toHaveLength(1);
  return captured.trustedToolPolicies[0]?.evaluate({ toolName, params: {} }, {
    toolName,
  } as Parameters<NonNullable<(typeof captured.trustedToolPolicies)[0]>["evaluate"]>[1]);
}

afterEach(() => {
  delete process.env[TOKEN_ENV];
  delete process.env[SECRET_ENV];
});

describe("capability-manifest-verifier plugin", () => {
  it("registers a trusted policy and exposes a bounded config schema", () => {
    const captured = createCapturedPluginRegistration({ id: "capability-manifest-verifier" });

    entry.register(captured.api);

    expect(captured.trustedToolPolicies).toHaveLength(1);
    expect(entry.configSchema.jsonSchema).toMatchObject({
      type: "object",
      additionalProperties: false,
      properties: {
        enabled: { type: "boolean" },
        manifestJwtEnv: { type: "string" },
        manifestPath: { type: "string" },
        manifestSecretEnv: { type: "string" },
        defaultDecision: { enum: ["allow", "deny"] },
      },
    });
  });

  it("allows tools with an explicit allowed grant", async () => {
    setManifest({
      agent_id: "agent-1",
      grants: {
        desktop_bridge_status: "allowed",
      },
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    });

    await expect(evaluateTool("desktop_bridge_status")).resolves.toBeUndefined();
  });

  it("requires approval for tools with an approval grant", async () => {
    setManifest({
      grants: {
        desktop_bridge_codex_send_visible_message: "requires_approval",
      },
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    });

    const decision = await evaluateTool("desktop_bridge_codex_send_visible_message");

    expect(decision).toMatchObject({
      requireApproval: {
        title: "Capability manifest approval required",
        severity: "warning",
        timeoutBehavior: "deny",
        allowedDecisions: ["allow-once", "deny"],
      },
    });
  });

  it("blocks explicitly denied tools and missing grants by default", async () => {
    setManifest({
      grants: {
        shell_exec: "denied",
      },
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    });

    await expect(evaluateTool("shell_exec")).resolves.toMatchObject({
      block: true,
      blockReason: "Capability manifest denies tool: shell_exec.",
    });
    await expect(evaluateTool("unknown_tool")).resolves.toMatchObject({
      block: true,
      blockReason: "Capability manifest has no grant for tool: unknown_tool.",
    });
  });

  it("supports wildcard grants before the default policy", async () => {
    setManifest({
      grants: {
        "*": "requires_approval",
      },
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    });

    await expect(evaluateTool("unlisted_tool")).resolves.toMatchObject({
      requireApproval: {
        title: "Capability manifest approval required",
      },
    });
    await expect(
      evaluateTool("unlisted_tool", { defaultDecision: "allow" }),
    ).resolves.toMatchObject({
      requireApproval: {
        title: "Capability manifest approval required",
      },
    });
  });

  it("supports explicit default allow for tools without grants", async () => {
    setManifest({
      grants: {},
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    });

    await expect(
      evaluateTool("unlisted_tool", { defaultDecision: "allow" }),
    ).resolves.toBeUndefined();
  });

  it("does not enforce when disabled", async () => {
    await expect(evaluateTool("unlisted_tool", { enabled: false })).resolves.toBeUndefined();
  });

  it("fails closed when manifest secret material is unavailable", async () => {
    process.env[TOKEN_ENV] = signManifest({
      grants: {
        desktop_bridge_status: "allowed",
      },
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    });

    await expect(evaluateTool("desktop_bridge_status")).resolves.toMatchObject({
      block: true,
      blockReason: "Capability manifest check failed: manifest secret unavailable.",
    });
  });

  it("supports object grant decisions", async () => {
    setManifest({
      grants: {
        desktop_bridge_status: { decision: "requires_approval" },
      },
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    });

    await expect(evaluateTool("desktop_bridge_status")).resolves.toMatchObject({
      requireApproval: {
        title: "Capability manifest approval required",
      },
    });
  });

  it("fails closed for invalid signatures without leaking secret material", async () => {
    setManifest({
      grants: {
        desktop_bridge_status: "allowed",
      },
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    });
    process.env[TOKEN_ENV] = `${process.env[TOKEN_ENV]}tampered`;

    const decision = await evaluateTool("desktop_bridge_status");

    expect(decision).toMatchObject({
      block: true,
      blockReason: "Capability manifest check failed: invalid manifest signature.",
    });
    expect(JSON.stringify(decision)).not.toContain(SECRET);
    expect(JSON.stringify(decision)).not.toContain(TOKEN_ENV);
  });

  it("fails closed for expired manifests and agent id mismatches", async () => {
    setManifest({
      agent_id: "agent-1",
      grants: {
        desktop_bridge_status: "allowed",
      },
      expires_at: new Date(Date.now() - 1_000).toISOString(),
    });

    await expect(evaluateTool("desktop_bridge_status")).resolves.toMatchObject({
      block: true,
      blockReason: "Capability manifest check failed: manifest expired.",
    });

    setManifest({
      agent_id: "agent-2",
      grants: {
        desktop_bridge_status: "allowed",
      },
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    });

    await expect(
      evaluateTool("desktop_bridge_status", { agentId: "agent-1" }),
    ).resolves.toMatchObject({
      block: true,
      blockReason: "Capability manifest check failed: manifest agent mismatch.",
    });
  });
});
