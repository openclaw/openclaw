// Codex tests cover command rpc plugin behavior.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CodexAppServerRpcError } from "./app-server/client.js";
import { codexControlRequest, safeValue } from "./command-rpc.js";

const requestCodexAppServerJson = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("./app-server/request.js", () => ({ requestCodexAppServerJson }));

beforeEach(() => {
  requestCodexAppServerJson.mockClear();
});

describe("Codex command RPC helpers", () => {
  it("formats unsupported control methods from JSON-RPC error codes", async () => {
    await expect(
      safeValue(async () => {
        throw new CodexAppServerRpcError({ code: -32601, message: "Method not found" }, "x/y");
      }),
    ).resolves.toEqual({
      ok: false,
      error: "unsupported by this Codex app-server",
    });
  });

  it("forces the remote execution policy onto control-plane thread resumes", async () => {
    await codexControlRequest(
      {
        appServer: {
          remoteWorkspaceRoot: "/remote/workspace",
          experimental: {
            remoteExecution: {
              registryUrl: "https://environment-registry.example.com/api",
              environmentId: "worker-1",
              authToken: "registry-token",
            },
          },
        },
      },
      "thread/resume",
      {
        threadId: "thread-1",
        config: {
          "features.unified_exec": false,
          "features.hooks": true,
          "shell_environment_policy.ignore_default_excludes": true,
        },
      },
    );

    expect(requestCodexAppServerJson).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "thread/resume",
        requestParams: expect.objectContaining({
          threadId: "thread-1",
          config: expect.objectContaining({
            "features.unified_exec": true,
            "features.hooks": false,
            "shell_environment_policy.ignore_default_excludes": false,
          }),
        }),
      }),
    );
  });
});
