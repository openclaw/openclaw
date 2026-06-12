import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MATERIALIZE_ONLY_SECRET_RESOLUTION_MESSAGE,
  resetPlatformSecretMetadataCacheForTests,
} from "../secrets/platform-runtime.js";
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

  it("rejects native echo/head proof without resolving plaintext", async () => {
    const fetchMock = vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url.endsWith("/api/secrets/metadata")) {
        return jsonResponse({
          known: { OPENAI_API_KEY: { category: "api_key" } },
          unknown: [],
        });
      }
      if (url.endsWith("/api/secrets/resolve")) {
        throw new Error("gateway exec must not resolve plaintext secrets");
      }
      throw new Error(`unexpected URL: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const tool = createExecTool({ host: "gateway", security: "full", ask: "off" });
    await expect(
      tool.execute("secret-proof", {
        command: "echo $OPENAI_API_KEY | head -c 9",
      }),
    ).rejects.toThrow(MATERIALIZE_ONLY_SECRET_RESOLUTION_MESSAGE);
    expect(fetchMock.mock.calls.map(([input]) => String(input))).toEqual([
      "https://api.rockielab.com/api/secrets/metadata",
    ]);
  });

  it("rejects stored secret refs before gateway subprocess env injection", async () => {
    const fetchMock = vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url.endsWith("/api/secrets/metadata")) {
        return jsonResponse({
          known: { OPENAI_API_KEY: { category: "api_key" } },
          unknown: [],
        });
      }
      if (url.endsWith("/api/secrets/resolve")) {
        throw new Error("gateway exec must not resolve plaintext secrets");
      }
      throw new Error(`unexpected URL: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const tool = createExecTool({ host: "gateway", security: "full", ask: "off" });
    await expect(
      tool.execute("secret-inject", {
        command: "printf %s $OPENAI_API_KEY",
      }),
    ).rejects.toThrow(MATERIALIZE_ONLY_SECRET_RESOLUTION_MESSAGE);
    expect(fetchMock.mock.calls.map(([input]) => String(input))).toEqual([
      "https://api.rockielab.com/api/secrets/metadata",
    ]);
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
    ).rejects.toThrow(MATERIALIZE_ONLY_SECRET_RESOLUTION_MESSAGE);
    expect(buildExecSpec).not.toHaveBeenCalled();
  });
});
