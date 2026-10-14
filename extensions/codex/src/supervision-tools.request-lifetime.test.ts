import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import {
  ensureAuthProfileStore,
  ensureAuthProfileStoreAsync,
  resolveAuthProfileOrder,
} from "openclaw/plugin-sdk/provider-auth";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createCodexAuthProfileSelection } from "./app-server/auth-profile-selection.js";
import { resolveCodexSupervisionAppServerRuntimeOptions } from "./app-server/config-runtime.js";
import { createClientHarness } from "./app-server/test-support.js";
import { createCodexSupervisionTools } from "./supervision-tools.js";

const { resolveCodexAppServerAuthProfileIdForAgent, resolveCodexAppServerAuthProfileIdAtEffect } =
  createCodexAuthProfileSelection({
    ensureAuthProfileStore,
    ensureAuthProfileStoreAsync,
    resolveAuthProfileOrder,
  });

const sharedClientMocks = vi.hoisted(() => ({
  createIsolatedCodexAppServerClient: vi.fn(),
  getLeasedSharedCodexAppServerClient: vi.fn(),
  releaseLeasedSharedCodexAppServerClient: vi.fn(),
  retireSharedCodexAppServerClientIfCurrent: vi.fn(),
}));

vi.mock("./app-server/shared-client.js", () => sharedClientMocks);

describe("Codex supervision request lifetime", () => {
  beforeEach(() => {
    sharedClientMocks.getLeasedSharedCodexAppServerClient.mockReset();
    sharedClientMocks.releaseLeasedSharedCodexAppServerClient.mockReset();
  });

  it("uses the injected account selection at the final request guard", async () => {
    const pluginConfig = {
      appServer: { homeScope: "agent" as const },
      supervision: { enabled: true, allowRawTranscripts: true },
    };
    const harness = createClientHarness({
      onWrite(line, send) {
        const request = JSON.parse(line) as { id: number };
        send({
          id: request.id,
          result: { thread: { id: "thread-1", status: { type: "idle" } } },
        });
      },
    });
    sharedClientMocks.getLeasedSharedCodexAppServerClient.mockResolvedValue(harness.client);
    const resolveAuthProfileIdAtEffect = vi.fn(() => "synthetic:account");
    const tool = createCodexSupervisionTools({
      getPluginConfig: () => pluginConfig,
      senderIsOwner: true,
      env: {},
      resolveAuthProfileId: async () => "synthetic:account",
      resolveAuthProfileIdAtEffect,
      resolveRuntimeOptions: resolveCodexSupervisionAppServerRuntimeOptions,
    }).find((candidate) => candidate.name === "codex_session_read")!;
    try {
      await expect(
        tool.execute("read", { endpoint_id: "local", thread_id: "thread-1" }),
      ).resolves.toMatchObject({
        details: { response: { thread: { id: "thread-1" } } },
      });
      expect(resolveAuthProfileIdAtEffect).toHaveBeenCalled();
    } finally {
      harness.client.close();
    }
  });

  it.each(
    ["codex_session_read", "codex_sessions_list", "codex_endpoint_probe"].flatMap((toolName) =>
      ["response", "final-auth"].map((timing) => ({ toolName, timing })),
    ),
  )("$toolName honors policy revocation at $timing", async ({ toolName, timing }) => {
    const privateText = "private transcript contents";
    let pluginConfig = {
      appServer: { homeScope: "agent" as const },
      supervision: { enabled: true, allowRawTranscripts: true },
    };
    let responseReturned = false;
    const revoke = () => {
      pluginConfig = {
        ...pluginConfig,
        supervision: {
          enabled: toolName !== "codex_endpoint_probe",
          allowRawTranscripts: false,
        },
      };
    };
    const harness = createClientHarness({
      onWrite(line, send) {
        const request = JSON.parse(line) as { id: number; method: string };
        if (request.method === "thread/read" || toolName === "codex_endpoint_probe") {
          responseReturned = true;
          if (timing === "response") {
            revoke();
          }
        }
        send({
          id: request.id,
          result:
            request.method === "thread/loaded/list"
              ? { data: toolName === "codex_endpoint_probe" ? [] : ["thread-1"] }
              : {
                  thread: {
                    id: "thread-1",
                    status: { type: "idle" },
                    preview: privateText,
                    name: privateText,
                    turns: [{ text: privateText }],
                  },
                },
        });
      },
    });
    sharedClientMocks.getLeasedSharedCodexAppServerClient.mockResolvedValue(harness.client);
    const tool = createCodexSupervisionTools({
      getPluginConfig: () => pluginConfig,
      senderIsOwner: true,
      env: {},
      resolveAuthProfileId: async () => {
        if (responseReturned && timing === "final-auth") {
          revoke();
        }
        return "synthetic:account";
      },
      resolveAuthProfileIdAtEffect: () => "synthetic:account",
      resolveRuntimeOptions: resolveCodexSupervisionAppServerRuntimeOptions,
    }).find((candidate) => candidate.name === toolName)!;
    try {
      const { result, error } = await Promise.resolve(
        tool.execute("read", { endpoint_id: "local", thread_id: "thread-1" }),
      ).then(
        (value) => ({ result: value, error: undefined }),
        (cause: unknown) => ({ result: undefined, error: cause }),
      );
      if (error) {
        expect(error).toBeInstanceOf(Error);
        expect(error).toMatchObject({
          message: expect.stringMatching(/Codex (?:supervision|session reads).*disabled/),
        });
      }
      expect(result !== undefined && !pluginConfig.supervision.enabled).toBe(false);
      expect(
        JSON.stringify(result)?.includes(privateText) &&
          !pluginConfig.supervision.allowRawTranscripts,
      ).not.toBe(true);
    } finally {
      harness.client.close();
    }
  });

  it.each([
    { toolName: "codex_session_send", method: "turn/steer" },
    { toolName: "codex_session_interrupt", method: "turn/interrupt" },
  ])(
    "keeps $method bound to current policy through client acquisition",
    async ({ toolName, method }) => {
      for (const change of ["none", "policy", "endpoint"] as const) {
        let pluginConfig = {
          supervision: {
            enabled: true,
            allowWriteControls: true,
            endpoints: [{ id: "local", transport: "stdio-proxy" as const, command: "codex-a" }],
          },
        };
        const harness = createClientHarness({
          onWrite(line, send) {
            const request = JSON.parse(line) as { id: number; method: string };
            send({
              id: request.id,
              result:
                request.method === "thread/read"
                  ? {
                      thread: {
                        id: "thread-1",
                        status: { type: "active" },
                        turns: [{ id: "turn-1", status: "inProgress" }],
                      },
                    }
                  : {},
            });
          },
        });
        const acquiringMutation = createDeferred<void>();
        const acquired = createDeferred<typeof harness.client>();
        sharedClientMocks.getLeasedSharedCodexAppServerClient
          .mockResolvedValueOnce(harness.client)
          .mockImplementationOnce(() => {
            acquiringMutation.resolve();
            return acquired.promise;
          });
        const tool = createCodexSupervisionTools({
          getPluginConfig: () => pluginConfig,
          senderIsOwner: true,
          env: {},
          resolveAuthProfileId: resolveCodexAppServerAuthProfileIdForAgent,
          resolveAuthProfileIdAtEffect: resolveCodexAppServerAuthProfileIdAtEffect,
          resolveRuntimeOptions: resolveCodexSupervisionAppServerRuntimeOptions,
        }).find((candidate) => candidate.name === toolName)!;
        const mutation = tool.execute("control", {
          endpoint_id: "local",
          thread_id: "thread-1",
          text: "continue",
        });
        void mutation.catch(() => {});
        try {
          await Promise.race([acquiringMutation.promise, mutation]);
          if (change === "policy") {
            pluginConfig = {
              supervision: { ...pluginConfig.supervision, allowWriteControls: false },
            };
          } else if (change === "endpoint") {
            pluginConfig = {
              supervision: {
                ...pluginConfig.supervision,
                endpoints: [{ id: "local", transport: "stdio-proxy", command: "codex-b" }],
              },
            };
          }
          acquired.resolve(harness.client);
          if (change === "none") {
            await expect(mutation).resolves.toMatchObject({
              details: { result: { threadId: "thread-1", turnId: "turn-1" } },
            });
          } else {
            await expect(mutation).rejects.toThrow(
              change === "policy" ? "write controls are disabled" : "was removed or changed",
            );
          }
          expect(
            harness.writes.map((line) => (JSON.parse(line) as { method: string }).method),
          ).toEqual(change === "none" ? ["thread/read", method] : ["thread/read"]);
        } finally {
          acquired.resolve(harness.client);
          harness.client.close();
          await mutation.catch(() => {});
        }
      }
    },
  );
});
