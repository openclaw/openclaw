import { beforeEach, describe, expect, it, vi } from "vitest";
import { createCodexAppServerAgentHarness } from "../../harness.js";
import { CodexAppServerStartupError } from "./attempt-timeouts.js";
import { readCodexPluginConfig } from "./config-parsing.js";
import { resolveCodexAppServerRuntimeOptions } from "./config-runtime.js";
import { codexManagedChildRecoveryFingerprint } from "./managed-child-turn.js";
import { buildCodexAppServerRuntimeFingerprint } from "./plugin-app-cache-key.js";
import {
  CodexAppServerLocalRequestCancellationError,
  CodexAppServerRpcError,
} from "./rpc-error.js";
import {
  createCodexTestBindingStore,
  sessionBindingIdentity,
} from "./session-binding.test-helpers.js";

const { connect } = vi.hoisted(() => ({ connect: vi.fn() }));
vi.mock("./shared-client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./shared-client.js")>()),
  openCodexConfiguredHistoryClient: connect,
}));

const pluginConfig: {
  appServer: { transport: "websocket"; url: string; tlsPeerCertificate?: string };
} = { appServer: { transport: "websocket", url: "wss://127.0.0.1:1234" } };
const identityInput = {
  agentId: "main",
  sessionId: "managed-session",
  sessionKey: "agent:main:subagent:child",
  lifecycleRevision: "managed-generation",
  runId: "managed-run",
};
const identity = sessionBindingIdentity(identityInput);
const threadId = "managed-thread";
const runtimeIdentity = { serverVersion: "0.164.0" };

function savedPage() {
  return {
    nextCursor: null,
    backwardsCursor: '{"turnId":"native-turn","includeAnchor":true}',
    data: [
      {
        id: "native-turn",
        status: "completed",
        completedAt: 1_700_000_000,
        error: null,
        itemsView: "full",
        items: [
          {
            id: "native-user",
            type: "userMessage",
            clientId: "64f451c1ae625e9791445ea747fee8ca61c00dbace7b90deecf651f067f389c2",
            content: [{ type: "text", text: "What did you observe?" }],
          },
          {
            id: "native-assistant",
            type: "agentMessage",
            text: "The original child produced this answer.",
            phase: null,
            delivery: null,
            memoryCitation: null,
          },
        ],
      },
    ] as const,
  };
}

async function setup(page: unknown = savedPage()) {
  const appServer = resolveCodexAppServerRuntimeOptions({
    pluginConfig: readCodexPluginConfig(pluginConfig),
  });
  const bindingStore = createCodexTestBindingStore();
  await bindingStore.mutate(identity, {
    kind: "set",
    binding: {
      threadId,
      cwd: "/fixture",
      clientId: "old-connection",
      appServerRuntimeFingerprint: buildCodexAppServerRuntimeFingerprint({
        appServer,
        runtimeIdentity,
      }),
      managedChildRecoveryFingerprint: codexManagedChildRecoveryFingerprint({
        ...identityInput,
        appServer,
      }),
    },
  });
  const request = vi.fn<() => Promise<unknown>>().mockResolvedValue(page);
  const closeAndWait = vi.fn(async () => {});
  connect.mockResolvedValue({
    request,
    closeAndWait,
    getRuntimeIdentity: () => runtimeIdentity,
    getServerVersion: () => runtimeIdentity.serverVersion,
    getCloseError: () => undefined,
  });
  let livePluginConfig = pluginConfig;
  const harness = createCodexAppServerAgentHarness({
    bindingStore,
    resolvePluginConfig: () => livePluginConfig,
  });
  const accept = vi.fn<(text: string, assertCurrent: () => void) => Promise<void>>();
  const run = (runId = identityInput.runId) =>
    harness.withInterruptedSubagentReply!({
      ...identityInput,
      runId,
      config: {},
      assertCurrent() {},
      claim: async () => {},
      accept,
    });
  return {
    run,
    accept,
    request,
    closeAndWait,
    bindingStore,
    updateSocket: (override: Partial<typeof pluginConfig.appServer>) => {
      livePluginConfig = { appServer: { ...pluginConfig.appServer, ...override } };
    },
  };
}

describe("interrupted managed Codex child reply", () => {
  beforeEach(() => connect.mockReset());

  it("keeps the current session binding available through the original owner's acceptance", async () => {
    const fixture = await setup();
    fixture.accept.mockImplementation(async (text, assertCurrent) => {
      expect(text).toBe("The original child produced this answer.");
      assertCurrent();
    });
    await fixture.run();
    expect(fixture.accept).toHaveBeenCalledOnce();
    expect(fixture.request).toHaveBeenCalledExactlyOnceWith(
      "thread/turns/list",
      { threadId, limit: 2, sortDirection: "desc", itemsView: "full" },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(fixture.closeAndWait).toHaveBeenCalledOnce();
  });

  const read = { type: "dynamicToolCall", id: "read", status: "completed", success: true };

  it("returns only the final answer after progress and a successful tool call", async () => {
    const page = savedPage();
    const [turn] = page.data;
    const [user, assistant] = turn.items;
    const fixture = await setup({
      ...page,
      data: [
        {
          ...turn,
          items: [
            user,
            { ...assistant, id: "progress", phase: "commentary", text: "Checking the file." },
            { type: "reasoning", id: "step", content: ["private reasoning"] },
            { ...read, contentItems: [{ type: "inputText", text: "private file" }] },
            { ...assistant, phase: "final_answer" },
          ],
        },
      ],
    });
    await fixture.run();
    expect(fixture.accept.mock.calls.map(([text]) => text)).toEqual([assistant.text]);
  });

  it.each<
    [
      string,
      {
        page?: { nextCursor: string };
        turn?: {
          status?: string;
          itemsView?: string;
          threadId?: string;
          completedAt?: number | null;
        };
        user?: { clientId: string };
        assistant?: { phase?: string; text?: string; attachment?: string };
        extraItem?: {
          id: string;
          type: string;
          success?: boolean;
          status?: string;
          phase?: string | null;
          delivery?: unknown;
        };
      },
    ]
  >([
    ["a different run receipt", { user: { clientId: "other-run" } }],
    ["contradictory in-progress state", { turn: { status: "inProgress" } }],
    ["implicit completion without a timestamp", { turn: { completedAt: null } }],
    ["invalid completion time", { turn: { completedAt: 0 } }],
    ["a summary page", { turn: { itemsView: "summary" } }],
    ["a different thread", { turn: { threadId: "other-thread" } }],
    ["an older page", { page: { nextCursor: "more" } }],
    ["commentary", { assistant: { phase: "commentary" } }],
    ["an unknown phase", { assistant: { phase: undefined } }],
    ["unrecognized assistant fields", { assistant: { attachment: "local-file" } }],
    ["inline reasoning", { assistant: { text: "<think>private work</think>Visible text." } }],
    ["silent reply", { assistant: { text: "NO_REPLY" } }],
    ["a pending tool", { extraItem: { ...read, status: "inProgress" } }],
    ["a failed tool", { extraItem: { ...read, success: false } }],
    ["a reused item ID", { extraItem: { ...read, id: "native-assistant" } }],
    [
      "another user message",
      { extraItem: { ...savedPage().data[0].items[0], id: "different-input" } },
    ],
    [
      "a competing answer",
      { extraItem: { ...savedPage().data[0].items[1], id: "different-reply" } },
    ],
    [
      "commentary carrying a delivery",
      {
        extraItem: {
          ...savedPage().data[0].items[1],
          id: "progress",
          phase: "commentary",
          delivery: {},
        },
      },
    ],
    ["an unsupported tool result", { extraItem: { id: "tool", type: "commandExecution" } }],
  ])("declines %s", async (_name, mutation) => {
    const saved = savedPage();
    const [turn] = saved.data;
    const [user, assistant] = turn.items;
    const page = {
      ...saved,
      ...mutation.page,
      data: [
        {
          ...turn,
          ...mutation.turn,
          items: [
            { ...user, ...mutation.user },
            ...(mutation.extraItem ? [mutation.extraItem] : []),
            { ...assistant, ...mutation.assistant },
          ],
        },
      ],
    };
    const fixture = await setup(page);
    await expect(fixture.run()).resolves.toBe("unknown");
    expect(fixture.accept).not.toHaveBeenCalled();
  });

  it.each(["failed", "interrupted"])(
    "recognizes a matching %s turn without an answer",
    async (status) => {
      const page = savedPage();
      const [turn] = page.data;
      const fixture = await setup({
        ...page,
        data: [{ ...turn, status, items: turn.items.slice(0, 1) }],
      });
      await expect(fixture.run()).resolves.toBe("interrupted");
      expect(fixture.accept).not.toHaveBeenCalled();
    },
  );

  it("leaves a matching in-progress turn pending", async () => {
    const page = savedPage();
    const [turn] = page.data;
    const fixture = await setup({
      ...page,
      data: [{ ...turn, status: "inProgress", completedAt: null, items: turn.items.slice(0, 1) }],
    });
    await expect(fixture.run()).resolves.toBe("pending");
    expect(fixture.accept).not.toHaveBeenCalled();
  });

  it("keeps a socket failure or timeout unresolved", async () => {
    const fixture = await setup();
    connect.mockRejectedValueOnce(new CodexAppServerStartupError("timed_out"));
    await expect(fixture.run()).resolves.toBe("unknown");
    fixture.request.mockRejectedValueOnce(
      new CodexAppServerLocalRequestCancellationError("thread/turns/list", "timed out", true),
    );
    await expect(fixture.run()).resolves.toBe("unknown");
    expect(fixture.accept).not.toHaveBeenCalled();
  });

  it("declines a server without the bounded history method", async () => {
    const fixture = await setup();
    fixture.request.mockRejectedValueOnce(
      new CodexAppServerRpcError({ code: -32601, message: "Unavailable" }, "thread/turns/list"),
    );
    await expect(fixture.run()).resolves.toBe("unknown");
    expect(fixture.accept).not.toHaveBeenCalled();
  });

  it("declines another run's binding before opening a connection", async () => {
    const fixture = await setup();
    await expect(fixture.run("another-run")).resolves.toBe("unknown");
    expect(connect).not.toHaveBeenCalled();
    expect(fixture.accept).not.toHaveBeenCalled();
  });

  it.each<[string, Partial<typeof pluginConfig.appServer>]>([
    ["endpoint", { url: "wss://127.0.0.1:1235" }],
    ["TLS peer pin at the same endpoint", { tlsPeerCertificate: "replacement-pin-fixture" }],
  ])("declines a changed %s before opening a connection", async (_name, change) => {
    const fixture = await setup();
    fixture.updateSocket(change);
    await expect(fixture.run()).resolves.toBe("unknown");
    expect(connect).not.toHaveBeenCalled();
    expect(fixture.accept).not.toHaveBeenCalled();
  });

  it("throws when the native binding changes while the history result is in flight", async () => {
    const fixture = await setup();
    fixture.request.mockImplementation(async () => {
      await fixture.bindingStore.mutate(identity, {
        kind: "replace-thread",
        expectedThreadId: threadId,
        binding: { threadId: "replacement-thread", cwd: "/fixture" },
      });
      return savedPage();
    });
    await expect(fixture.run()).rejects.toThrow("Codex managed child recovery binding changed");
    expect(fixture.accept).not.toHaveBeenCalled();
    expect(fixture.closeAndWait).toHaveBeenCalledOnce();
  });
});
