import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import * as providerAuth from "openclaw/plugin-sdk/provider-auth";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCodexAuthProfileSelection } from "./app-server/auth-profile-selection.js";
import { resolveCodexSupervisionAppServerRuntimeOptions } from "./app-server/config-runtime.js";
import { createClientHarness } from "./app-server/test-support.js";
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

const clients: Array<ReturnType<typeof createClientHarness>["client"]> = [];
const threadResponse = (type = "idle", fields = {}) => ({
  thread: { id: "thread-1", status: { type }, ...fields },
});
function respondingClient(result: (method: string) => unknown) {
  const harness = createClientHarness({
    onWrite(line, send) {
      const { id, method } = JSON.parse(line) as { id: number; method: string };
      send({ id, result: result(method) });
    },
  });
  clients.push(harness.client);
  return harness;
}

describe("Codex supervision request lifetime", () => {
  beforeEach(() => {
    sharedClientMocks.getLeasedSharedCodexAppServerClient.mockReset();
    sharedClientMocks.releaseLeasedSharedCodexAppServerClient.mockReset();
  });
  afterEach(() => clients.splice(0).forEach((client) => client.close()));

  it("refuses a transcript when the selected account is revoked after the server response", async () => {
    let selected: string | undefined = "synthetic:account";
    const harness = respondingClient(() => {
      selected = undefined;
      return threadResponse("idle", { turns: [{ text: "private transcript" }] });
    });
    sharedClientMocks.getLeasedSharedCodexAppServerClient.mockResolvedValue(harness.client);
    const tool = createTool("codex_session_read", readConfig, {
      resolveAuthProfileId: async () => "synthetic:account",
      withAuthProfileIdAtEffect: async (_params, consume) =>
        consume({
          read: async () => selected,
          assertCurrent() {},
        }),
    });
    await expect(tool.execute("read", sessionParams)).rejects.toThrow(
      "endpoint local was removed or changed",
    );
  });

  it.each(
    ["codex_session_read", "codex_sessions_list", "codex_endpoint_probe"].flatMap((toolName) =>
      ["response", "final-auth"].map((timing) => ({ toolName, timing })),
    ),
  )("$toolName honors policy revocation at $timing", async ({ toolName, timing }) => {
    const privateText = "private transcript contents";
    const pluginConfig = readConfig();
    let responseReturned = false;
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
            return "synthetic:account";
          },
          assertCurrent() {},
        }),
    });
    const result = await Promise.resolve(tool.execute("read", sessionParams)).catch(
      (error: unknown) => {
        expect(error).toBeInstanceOf(Error);
        expect(error).toHaveProperty(
          "message",
          expect.stringMatching(/Codex (?:supervision|session reads).*disabled/),
        );
      },
    );
    expect(result !== undefined && !pluginConfig.supervision.enabled).toBe(false);
    expect(
      JSON.stringify(result)?.includes(privateText) &&
        !pluginConfig.supervision.allowRawTranscripts,
    ).not.toBe(true);
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
