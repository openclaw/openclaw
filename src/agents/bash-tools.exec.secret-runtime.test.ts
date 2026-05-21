import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetPlatformSecretMetadataCacheForTests } from "../secrets/platform-runtime.js";
import { createExecTool } from "./bash-tools.exec.js";

function jsonResponse(payload: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => payload,
  } as Response;
}

describe("exec platform secret runtime", () => {
  beforeEach(() => {
    resetPlatformSecretMetadataCacheForTests();
    vi.stubEnv("ROCKIELAB_TENANT_ID", "tenant-a");
    vi.stubEnv("BROKER_TENANT_TOKEN", "broker-token");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    resetPlatformSecretMetadataCacheForTests();
  });

  it("accepts only native echo/head proof without leaking prefix bytes", async () => {
    const fetchMock = vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url.endsWith("/api/secrets/metadata")) {
        return jsonResponse({
          known: { OPENAI_API_KEY: { category: "api_key" } },
          unknown: [],
        });
      }
      if (url.endsWith("/api/secrets/resolve")) {
        return jsonResponse({
          resolved: { OPENAI_API_KEY: "sk-test-canary-secret" },
          categories: { OPENAI_API_KEY: "api_key" },
          missing: [],
        });
      }
      throw new Error(`unexpected URL: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const tool = createExecTool({ host: "gateway", security: "full", ask: "off" });
    const result = await tool.execute("secret-proof", {
      command: "echo $OPENAI_API_KEY | head -c 9",
    });

    const text = result.content.find((entry) => entry.type === "text")?.text ?? "";
    expect(text).toBe("<redacted:OPENAI_API_KEY>");
    expect(text).not.toContain("sk-test");
    expect(text).not.toContain("sk-t");
    expect(result.details).toMatchObject({
      status: "completed",
      accepted: true,
      name: "OPENAI_API_KEY",
      requestedCount: 9,
      aggregated: "<redacted:OPENAI_API_KEY>",
    });
  });

  it("rejects stored secret references outside the broker-native exact form", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          known: { OPENAI_API_KEY: { category: "api_key" } },
          unknown: [],
        }),
      ),
    );

    const tool = createExecTool({ host: "gateway", security: "full", ask: "off" });
    await expect(
      tool.execute("secret-reject", {
        command: "printf %s $OPENAI_API_KEY",
      }),
    ).rejects.toThrow(/Secret references are only allowed in exact broker-native form/);
  });

  it("rejects platform-secret sandbox commands before backend materialization", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          known: { DEPLOY_KEY: { category: "ssh_key" } },
          unknown: [],
        }),
      ),
    );
    const buildExecSpec = vi.fn();
    const tool = createExecTool({
      host: "sandbox",
      security: "full",
      ask: "off",
      sandbox: {
        containerName: "ssh-sandbox",
        workspaceDir: process.cwd(),
        containerWorkdir: "/workspace",
        buildExecSpec,
      },
    });

    await expect(
      tool.execute("secret-ssh-reject", {
        command: "printf %s $DEPLOY_KEY",
      }),
    ).rejects.toThrow(/Secret references are only allowed in exact broker-native form/);
    expect(buildExecSpec).not.toHaveBeenCalled();
  });
});
