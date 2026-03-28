import { describe, expect, it, vi, beforeEach } from "vitest";
import type { OpenClawConfig, PluginRuntime } from "../runtime-api.js";
import type { MSTeamsActivityHandler, MSTeamsMessageHandlerDeps } from "./monitor-handler.js";
import { registerMSTeamsHandlers } from "./monitor-handler.js";
import {
  createActivityHandler,
  createMSTeamsMessageHandlerDeps,
} from "./monitor-handler.test-helpers.js";
import { setMSTeamsRuntime } from "./runtime.js";
import type { MSTeamsTurnContext } from "./sdk-types.js";

const pluginRuntimeState = vi.hoisted(() => ({
  dispatchPluginInteractiveHandler: vi.fn(),
}));

const conversationRuntimeState = vi.hoisted(() => ({
  parsePluginBindingApprovalCustomId: vi.fn(),
  resolvePluginConversationBindingApproval: vi.fn(),
  buildPluginBindingResolvedText: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/plugin-runtime", () => ({
  dispatchPluginInteractiveHandler: pluginRuntimeState.dispatchPluginInteractiveHandler,
}));

vi.mock("openclaw/plugin-sdk/conversation-runtime", () => ({
  parsePluginBindingApprovalCustomId: conversationRuntimeState.parsePluginBindingApprovalCustomId,
  resolvePluginConversationBindingApproval:
    conversationRuntimeState.resolvePluginConversationBindingApproval,
  buildPluginBindingResolvedText: conversationRuntimeState.buildPluginBindingResolvedText,
}));

function createRuntimeStub(): PluginRuntime {
  return {
    logging: {
      shouldLogVerbose: () => false,
    },
    channel: {
      debounce: {
        resolveInboundDebounceMs: () => 0,
        createInboundDebouncer: () => ({
          enqueue: async () => {},
        }),
      },
      pairing: {
        readAllowFromStore: vi.fn(async () => []),
        upsertPairingRequest: vi.fn(async () => null),
      },
      routing: {
        resolveAgentRoute: ({ peer }: { peer: { kind: string; id: string } }) => ({
          sessionKey: `msteams:${peer.kind}:${peer.id}`,
          agentId: "default",
          accountId: "default",
        }),
      },
      session: {
        resolveStorePath: () => "/tmp",
      },
    },
  } as unknown as PluginRuntime;
}

function createDeps(cfg: OpenClawConfig = {} as OpenClawConfig): MSTeamsMessageHandlerDeps {
  setMSTeamsRuntime(createRuntimeStub());
  return createMSTeamsMessageHandlerDeps({
    cfg,
  });
}

function createTeamsInvokeContext(params?: {
  value?: unknown;
  conversationType?: string;
  conversationId?: string;
  senderId?: string;
  replyToId?: string;
}): MSTeamsTurnContext {
  return {
    activity: {
      id: "teams-ix-1",
      type: "invoke",
      name: "message/submitAction",
      channelId: "msteams",
      serviceUrl: "https://service.example.test",
      from: {
        id: "bf-user-1",
        aadObjectId: params?.senderId ?? "user-1",
        name: "Ada",
      },
      recipient: {
        id: "bot-id",
        name: "Bot",
      },
      conversation: {
        id: params?.conversationId ?? "19:teams@thread.tacv2;messageid=source-msg-1",
        conversationType: params?.conversationType ?? "channel",
        tenantId: "tenant-1",
      },
      channelData: {
        team: { id: "team-1", name: "Team 1" },
        channel: { id: "channel-1", name: "General" },
      },
      replyToId: params?.replyToId ?? "source-msg-1",
      value: params?.value ?? {
        openclawInteractive: {
          version: 1,
          data: "codexapp:resume:thread-1",
        },
      },
    },
    sendActivity: vi.fn(async () => ({ id: "sent-1" })),
    sendActivities: vi.fn(async () => []),
    updateActivity: vi.fn(async () => ({ id: "source-msg-1" })),
    deleteActivity: vi.fn(async () => undefined),
  } as unknown as MSTeamsTurnContext;
}

describe("msteams plugin interactions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    pluginRuntimeState.dispatchPluginInteractiveHandler.mockResolvedValue({
      matched: true,
      handled: true,
      duplicate: false,
    });
    conversationRuntimeState.parsePluginBindingApprovalCustomId.mockReturnValue(null);
    conversationRuntimeState.resolvePluginConversationBindingApproval.mockResolvedValue({
      status: "approved",
      decision: "allow-once",
      request: { pluginId: "codex-plugin", conversation: { channel: "msteams" } },
      binding: {
        bindingId: "binding-1",
        pluginId: "codex-plugin",
        pluginRoot: "/plugins/codex",
        channel: "msteams",
        accountId: "default",
        conversationId: "conversation:19:teams@thread.tacv2",
        boundAt: Date.now(),
      },
    });
    conversationRuntimeState.buildPluginBindingResolvedText.mockReturnValue(
      "Allowed Codex to bind this conversation once.",
    );
  });

  it("dispatches Teams submit actions to plugin interactive handlers", async () => {
    const handler = registerMSTeamsHandlers(
      createActivityHandler(),
      createDeps({} as OpenClawConfig),
    ) as MSTeamsActivityHandler & {
      run: NonNullable<MSTeamsActivityHandler["run"]>;
    };
    const context = createTeamsInvokeContext();

    await handler.run(context);

    expect(pluginRuntimeState.dispatchPluginInteractiveHandler).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "msteams",
        data: "codexapp:resume:thread-1",
        interactionId: "teams-ix-1",
        ctx: expect.objectContaining({
          conversationId: "conversation:19:teams@thread.tacv2",
          conversationType: "channel",
          teamId: "team-1",
          graphChannelId: "channel-1",
        }),
      }),
    );
  });

  it("threads Teams interactive replies to the source message", async () => {
    pluginRuntimeState.dispatchPluginInteractiveHandler.mockImplementationOnce(async (params) => {
      await params.respond.reply({ text: "Action complete." });
      return { matched: true, handled: true, duplicate: false };
    });
    const handler = registerMSTeamsHandlers(
      createActivityHandler(),
      createDeps({} as OpenClawConfig),
    ) as MSTeamsActivityHandler & {
      run: NonNullable<MSTeamsActivityHandler["run"]>;
    };
    const context = createTeamsInvokeContext();

    await handler.run(context);

    expect(context.sendActivity as unknown as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "message",
        text: "Action complete.",
        replyToId: "source-msg-1",
      }),
    );
  });

  it("preserves the source card on text-only interactive edits", async () => {
    pluginRuntimeState.dispatchPluginInteractiveHandler.mockImplementationOnce(async (params) => {
      await params.respond.editMessage({ text: "Updated status." });
      return { matched: true, handled: true, duplicate: false };
    });
    const handler = registerMSTeamsHandlers(
      createActivityHandler(),
      createDeps({} as OpenClawConfig),
    ) as MSTeamsActivityHandler & {
      run: NonNullable<MSTeamsActivityHandler["run"]>;
    };
    const context = createTeamsInvokeContext();

    await handler.run(context);

    expect(context.updateActivity as unknown as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "source-msg-1",
        text: "Updated status.",
      }),
    );
    expect(context.updateActivity as unknown as ReturnType<typeof vi.fn>).not.toHaveBeenCalledWith(
      expect.objectContaining({ attachments: [] }),
    );
  });

  it("falls through when a Teams plugin handler declines the submit action", async () => {
    pluginRuntimeState.dispatchPluginInteractiveHandler.mockResolvedValueOnce({
      matched: true,
      handled: false,
      duplicate: false,
    });
    const originalRun = vi.fn(async () => undefined);
    const handler = registerMSTeamsHandlers(
      createActivityHandler(originalRun),
      createDeps({} as OpenClawConfig),
    ) as MSTeamsActivityHandler & {
      run: NonNullable<MSTeamsActivityHandler["run"]>;
    };
    const context = createTeamsInvokeContext();

    await handler.run(context);

    expect(pluginRuntimeState.dispatchPluginInteractiveHandler).toHaveBeenCalled();
    expect(originalRun).toHaveBeenCalledWith(context);
  });

  it("resolves Teams plugin binding approvals in core before plugin dispatch", async () => {
    conversationRuntimeState.parsePluginBindingApprovalCustomId.mockReturnValue({
      approvalId: "approval-1",
      decision: "allow-once",
    });
    const handler = registerMSTeamsHandlers(
      createActivityHandler(),
      createDeps({} as OpenClawConfig),
    ) as MSTeamsActivityHandler & {
      run: NonNullable<MSTeamsActivityHandler["run"]>;
    };
    const context = createTeamsInvokeContext({
      value: {
        openclawInteractive: {
          version: 1,
          data: "pluginbind:approval-1:o",
        },
      },
    });

    await handler.run(context);

    expect(conversationRuntimeState.resolvePluginConversationBindingApproval).toHaveBeenCalledWith({
      approvalId: "approval-1",
      decision: "allow-once",
      senderId: "user-1",
    });
    expect(pluginRuntimeState.dispatchPluginInteractiveHandler).not.toHaveBeenCalled();
    expect(context.updateActivity as unknown as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "source-msg-1",
        text: "Allowed Codex to bind this conversation once.",
        attachments: [],
      }),
    );
  });

  it("does not post a duplicate follow-up for denied binding approvals", async () => {
    conversationRuntimeState.parsePluginBindingApprovalCustomId.mockReturnValue({
      approvalId: "approval-1",
      decision: "deny",
    });
    conversationRuntimeState.resolvePluginConversationBindingApproval.mockResolvedValue({
      status: "denied",
    });
    conversationRuntimeState.buildPluginBindingResolvedText.mockReturnValue(
      "Denied Codex access to this conversation.",
    );
    const handler = registerMSTeamsHandlers(
      createActivityHandler(),
      createDeps({} as OpenClawConfig),
    ) as MSTeamsActivityHandler & {
      run: NonNullable<MSTeamsActivityHandler["run"]>;
    };
    const context = createTeamsInvokeContext({
      value: {
        openclawInteractive: {
          version: 1,
          data: "pluginbind:approval-1:d",
        },
      },
    });

    await handler.run(context);

    expect(context.updateActivity as unknown as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "source-msg-1",
        text: "Denied Codex access to this conversation.",
        attachments: [],
      }),
    );
    expect(context.sendActivity as unknown as ReturnType<typeof vi.fn>).not.toHaveBeenCalledWith(
      expect.objectContaining({
        text: "Denied Codex access to this conversation.",
      }),
    );
  });

  it("retries Teams follow-ups without replyToId when the source message cannot be threaded", async () => {
    conversationRuntimeState.parsePluginBindingApprovalCustomId.mockReturnValue({
      approvalId: "approval-1",
      decision: "allow-once",
    });
    conversationRuntimeState.buildPluginBindingResolvedText.mockReturnValue(
      "Allowed Codex to bind this conversation once.",
    );
    const handler = registerMSTeamsHandlers(
      createActivityHandler(),
      createDeps({} as OpenClawConfig),
    ) as MSTeamsActivityHandler & {
      run: NonNullable<MSTeamsActivityHandler["run"]>;
    };
    const context = createTeamsInvokeContext({
      value: {
        openclawInteractive: {
          version: 1,
          data: "pluginbind:approval-1:o",
        },
      },
    });
    (context.updateActivity as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("message missing"),
    );
    (context.sendActivity as unknown as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(new Error("reply target missing"))
      .mockResolvedValueOnce({ id: "sent-2" });

    await handler.run(context);

    expect(context.sendActivity as unknown as ReturnType<typeof vi.fn>).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        type: "message",
        text: "Allowed Codex to bind this conversation once.",
        replyToId: "source-msg-1",
      }),
    );
    expect(context.sendActivity as unknown as ReturnType<typeof vi.fn>).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        type: "message",
        text: "Allowed Codex to bind this conversation once.",
      }),
    );
    expect(context.sendActivity as unknown as ReturnType<typeof vi.fn>).not.toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ replyToId: "source-msg-1" }),
    );
  });
});
