import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import * as providerAuth from "openclaw/plugin-sdk/provider-auth";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCodexAuthProfileSelection } from "./app-server/auth-profile-selection.js";
import { resolveCodexSupervisionAppServerRuntimeOptions } from "./app-server/config-runtime.js";
import { createRequestClientHarness } from "./app-server/test-support.js";
import { createCodexSupervisionTools } from "./supervision-tools.js";

const auth = createCodexAuthProfileSelection(providerAuth);

const sharedClientMocks = vi.hoisted(() => ({
  createIsolatedCodexAppServerClient: vi.fn(),
  getLeasedSharedCodexAppServerClient: vi.fn(),
  releaseLeasedSharedCodexAppServerClient: vi.fn(),
  retireSharedCodexAppServerClientIfCurrent: vi.fn(),
}));

vi.mock("./app-server/shared-client.js", () => sharedClientMocks);

type ToolOptions = Parameters<typeof createCodexSupervisionTools>[0];
const sessionParams = { endpoint_id: "local", thread_id: "thread-1" };
const readConfig = () => ({
  appServer: { homeScope: "agent" as const },
  supervision: { enabled: true, allowRawTranscripts: true },
});
const writeConfig = (command = "codex-a", allowWriteControls = true) => ({
  supervision: {
    enabled: true,
    allowWriteControls,
    endpoints: [{ id: "local", transport: "stdio-proxy" as const, command }],
  },
});

function createTool(
  name: string,
  getPluginConfig: ToolOptions["getPluginConfig"],
  options: Partial<ToolOptions> = {},
) {
  return createCodexSupervisionTools({
    getPluginConfig,
    senderIsOwner: true,
    env: {},
    resolveAuthProfileId: auth.resolveCodexAppServerAuthProfileIdForAgent,
    withAuthProfileIdAtEffect: auth.withCodexAppServerAuthProfileIdAtEffect,
    resolveRuntimeOptions: resolveCodexSupervisionAppServerRuntimeOptions,
    ...options,
  }).find((candidate) => candidate.name === name)!;
}

const clients: Array<ReturnType<typeof createRequestClientHarness>["client"]> = [];
const threadResponse = (type = "idle", fields = {}) => ({
  thread: { id: "thread-1", status: { type }, ...fields },
});
function respondingClient(result: (method: string) => unknown) {
  const harness = createRequestClientHarness((method, id, _params, send) =>
    send({ id, result: result(method) }),
  );
  clients.push(harness.client);
  return harness;
}

describe("Codex supervision request lifetime", () => {
  beforeEach(() => {
    sharedClientMocks.getLeasedSharedCodexAppServerClient.mockReset();
    sharedClientMocks.releaseLeasedSharedCodexAppServerClient.mockReset();
  });
  afterEach(() => clients.splice(0).forEach((client) => client.close()));

  it.each([
    { toolName: "codex_session_read", timing: "account" },
    ...["codex_session_read", "codex_sessions_list", "codex_endpoint_probe"].flatMap((toolName) =>
      ["response", "final-auth"].map((timing) => ({ toolName, timing })),
    ),
  ])("$toolName honors revocation at $timing", async ({ toolName, timing }) => {
    const privateText = "private transcript contents";
    const pluginConfig = readConfig();
    let responseReturned = false;
    let selected: string | undefined = "synthetic:account";
    const revoke = () => {
      pluginConfig.supervision = {
        enabled: toolName !== "codex_endpoint_probe",
        allowRawTranscripts: false,
      };
    };
    const harness = respondingClient((method) => {
      if (method === "thread/read" || toolName === "codex_endpoint_probe") {
        responseReturned = true;
        if (timing === "response") {
          revoke();
        } else if (timing === "account") {
          selected = undefined;
        }
      }
      return method === "thread/loaded/list"
        ? { data: toolName === "codex_endpoint_probe" ? [] : ["thread-1"] }
        : threadResponse("idle", {
            preview: privateText,
            name: privateText,
            turns: [{ text: privateText }],
          });
    });
    sharedClientMocks.getLeasedSharedCodexAppServerClient.mockResolvedValue(harness.client);
    const tool = createTool(toolName, () => pluginConfig, {
      resolveAuthProfileId: async () => "synthetic:account",
      withAuthProfileIdAtEffect: async (_params, consume) =>
        consume({
          read: async () => {
            if (responseReturned && timing === "final-auth") {
              revoke();
            }
            return selected;
          },
          assertCurrent() {},
        }),
    });
    const result = tool.execute("read", sessionParams);
    if (timing === "account") {
      await expect(result).rejects.toThrow("endpoint local was removed or changed");
    } else if (toolName === "codex_sessions_list") {
      expect(JSON.stringify(await result)).not.toContain(privateText);
    } else {
      await expect(result).rejects.toThrow(/Codex (?:supervision|session reads).*disabled/);
    }
  });

  it.each([
    { toolName: "codex_session_send", method: "turn/steer" },
    { toolName: "codex_session_interrupt", method: "turn/interrupt" },
  ])(
    "keeps $method bound to current policy through client acquisition",
    async ({ toolName, method }) => {
      for (const change of ["none", "policy", "endpoint"] as const) {
        let pluginConfig = writeConfig();
        const harness = respondingClient((requestMethod) =>
          requestMethod === "thread/read"
            ? threadResponse("active", { turns: [{ id: "turn-1", status: "inProgress" }] })
            : {},
        );
        const acquiringMutation = createDeferred<void>();
        const acquired = createDeferred<typeof harness.client>();
        sharedClientMocks.getLeasedSharedCodexAppServerClient
          .mockResolvedValueOnce(harness.client)
          .mockImplementationOnce(() => {
            acquiringMutation.resolve();
            return acquired.promise;
          });
        const tool = createTool(toolName, () => pluginConfig);
        const mutation = tool.execute("control", { ...sessionParams, text: "continue" });
        void mutation.catch(() => {});
        try {
          await Promise.race([acquiringMutation.promise, mutation]);
          if (change === "policy") {
            pluginConfig = writeConfig("codex-a", false);
          } else if (change === "endpoint") {
            pluginConfig = writeConfig("codex-b");
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
