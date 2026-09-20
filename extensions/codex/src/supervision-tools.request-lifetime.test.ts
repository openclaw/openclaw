import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveCodexAppServerAuthProfileIdForAgent } from "./app-server/auth-profile.js";
import { resolveCodexSupervisionAppServerRuntimeOptions } from "./app-server/config-runtime.js";
import { createClientHarness } from "./app-server/test-support.js";
import { createCodexSupervisionTools } from "./supervision-tools.js";

const sharedClientMocks = vi.hoisted(() => ({
  createIsolatedCodexAppServerClient: vi.fn(),
  getLeasedSharedCodexAppServerClient: vi.fn(),
  releaseLeasedSharedCodexAppServerClient: vi.fn(),
  retireSharedCodexAppServerClientIfCurrent: vi.fn(),
  isCodexAppServerStartSelectionChangedError: () => false,
}));

vi.mock("./app-server/shared-client.js", () => sharedClientMocks);

describe("Codex supervision request lifetime", () => {
  beforeEach(() => {
    sharedClientMocks.getLeasedSharedCodexAppServerClient.mockReset();
    sharedClientMocks.releaseLeasedSharedCodexAppServerClient.mockReset();
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
