import { expectPairingReplyText } from "openclaw/plugin-sdk/channel-test-helpers";
import { buildPairingReply } from "openclaw/plugin-sdk/conversation-runtime";
import type * as SessionTranscriptRuntime from "openclaw/plugin-sdk/session-transcript-runtime";
import { expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authorize: vi.fn(),
  buildEventPlan: vi.fn(),
  buildPreparedModelsProviderData: vi.fn(),
  deliverReply: vi.fn(),
  dispatch: vi.fn(),
  parseContext: vi.fn(),
  runDetachedWebhookWork: vi.fn(),
  recordDeliveredCommandExchange: vi.fn(
    async (
      _params: Parameters<typeof SessionTranscriptRuntime.recordDeliveredCommandExchange>[0],
    ) => ({ ok: true }),
  ),
}));

vi.mock("openclaw/plugin-sdk/webhook-request-guards", () => ({
  runDetachedWebhookWork: mocks.runDetachedWebhookWork,
}));

vi.mock("openclaw/plugin-sdk/session-transcript-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof SessionTranscriptRuntime>()),
  recordDeliveredCommandExchange: mocks.recordDeliveredCommandExchange,
}));

vi.mock("./model-picker.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./model-picker.js")>()),
  parseMattermostModelPickerContext: mocks.parseContext,
  resolveMattermostModelPickerCurrentModel: async () => "openai/gpt-5.4",
}));

vi.mock("./monitor-auth.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./monitor-auth.js")>()),
  authorizeMattermostCommandInvocation: mocks.authorize,
}));

vi.mock("./monitor-event-plan.js", () => ({
  buildMattermostEventPlan: mocks.buildEventPlan,
}));

vi.mock("./reply-delivery.js", () => ({
  deliverMattermostReplyPayload: mocks.deliverReply,
}));

vi.mock("./runtime-api.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./runtime-api.js")>()),
  buildPreparedModelsProviderData: mocks.buildPreparedModelsProviderData,
}));

import { createMattermostModelPickerInteractionHandler } from "./monitor-model-picker.js";
import type { MattermostMonitorContext } from "./monitor-types.js";

const scenarios = [
  { action: "providers", catalogStatus: "ready" },
  { action: "list", catalogStatus: "ready" },
  { action: "select", catalogStatus: "ready" },
  { action: "select", catalogStatus: "empty" },
  ...["removed-model", "unlisted-provider"].map((catalogStatus) => ({
    action: "select",
    catalogStatus,
  })),
];
const replyToId = "interaction:picker-post-1:select:openai/gpt-5.4";
it.each(scenarios)(
  "handles the $action picker with $catalogStatus catalog availability",
  async ({ action, catalogStatus }) => {
    vi.clearAllMocks();
    mocks.authorize.mockResolvedValue({
      ok: true,
      commandAuthorized: true,
      channelInfo: { id: "channel-1", team_id: "team-1", type: "O" },
    });
    mocks.deliverReply.mockResolvedValue({
      outcome: "text",
      visibleReplySent: true,
      messageIds: ["confirmation-1"],
      content: "model updated",
    });
    mocks.buildEventPlan.mockResolvedValue({
      channelId: "channel-1",
      channelDisplay: "Lifecycle",
      kind: "channel",
      roomLabel: "#lifecycle",
      route: { agentId: "main", dmScope: "per-peer", sessionKey: "agent:main:mm" },
      thread: { sessionKey: "agent:main:mm", effectiveReplyToId: undefined },
      to: "channel:channel-1",
      finalizeContext: (context: Record<string, unknown>) => context,
      createReplyPlan: () => ({
        replyOptions: {},
        replyPipeline: {},
        tableMode: "off",
        textLimit: 4000,
      }),
    });
    mocks.dispatch.mockImplementation(
      async (
        params: Parameters<MattermostMonitorContext["core"]["channel"]["inbound"]["dispatch"]>[0],
      ) => {
        await params.delivery.deliver({ text: "model updated", replyToId }, { kind: "final" });
        return {};
      },
    );
    const order: string[] = [];
    const hasModels = catalogStatus !== "empty";
    const mixedSelection = action === "select" && !hasModels;
    const refreshWarning =
      catalogStatus === "ready" ? undefined : "Some models could not be refreshed.";
    mocks.parseContext.mockReturnValue({
      action,
      ownerUserId: "user-1",
      provider: mixedSelection ? "OpenAI" : "openai",
      model: mixedSelection ? " GPT-5.4 " : "gpt-5.4",
      page: 0,
    });
    mocks.buildPreparedModelsProviderData.mockImplementationOnce(async () => {
      order.push("load");
      return {
        providers: hasModels
          ? [catalogStatus === "unlisted-provider" ? "anthropic" : "openai"]
          : [],
        byProvider: new Map(
          hasModels
            ? [["openai", new Set([catalogStatus === "removed-model" ? "gpt-4.1" : "gpt-5.4"])]]
            : [],
        ),
        modelNames: new Map(),
        modelCatalog: [],
        resolvedDefault: { provider: "openai", model: "gpt-5.4" },
        refreshWarning,
      };
    });
    let detachedRun: (() => Promise<void>) | undefined;
    mocks.runDetachedWebhookWork.mockImplementation((run: () => Promise<void>) => {
      order.push("detach");
      detachedRun = run;
      return Promise.resolve();
    });
    const updateModelPickerPost = vi.fn<
      MattermostMonitorContext["resources"]["updateModelPickerPost"]
    >(async () => {
      expect(mocks.recordDeliveredCommandExchange).not.toHaveBeenCalled();
      order.push("update");
      return {};
    });
    const monitor = {
      account: { accountId: "default", config: {} },
      cfg: {},
      core: {
        channel: {
          commands: { shouldHandleTextCommands: vi.fn(() => true) },
          inbound: { dispatch: mocks.dispatch },
          text: {
            convertMarkdownTables: vi.fn((text: string) => text),
            hasControlCommand: vi.fn(() => true),
          },
        },
      },
      pairing: { readAllowFromStore: vi.fn(async () => []) },
      resources: {
        resolveChannelInfo: vi.fn(async () => ({ id: "channel-1", type: "O" })),
        updateModelPickerPost,
      },
      runtime: { error: vi.fn() },
    } as unknown as MattermostMonitorContext;
    const handler = createMattermostModelPickerInteractionHandler(monitor);

    const response = await handler({
      payload: {
        channel_id: "channel-1",
        post_id: "picker-post-1",
        team_id: "team-1",
        user_id: "user-1",
        ...(catalogStatus === "empty" ? {} : { trigger_id: `trigger-${action}` }),
      },
      userName: "tester",
      context: {},
      post: { id: "picker-post-1", channel_id: "channel-1", message: "picker" },
    });

    expect(mocks.dispatch).not.toHaveBeenCalled();
    if (catalogStatus === "removed-model" || catalogStatus === "unlisted-provider") {
      expect(response).toEqual({
        ephemeral_text: "That model is no longer available: openai/gpt-5.4",
      });
      expect(order).toEqual(["load"]);
      expect(mocks.recordDeliveredCommandExchange).not.toHaveBeenCalled();
      return;
    }
    expect(response).toEqual({});
    const selectsModel = action === "select" && hasModels;
    const visibleText = !hasModels
      ? "No models available."
      : selectsModel
        ? "Select a model to switch immediately."
        : action === "list"
          ? "Select a model"
          : "Select a provider";
    if (selectsModel) {
      expect(order).toEqual(["load", "detach"]);
      await detachedRun?.();
      expect(mocks.deliverReply).toHaveBeenCalledWith(
        expect.objectContaining({ channelId: "channel-1", replyToId: "picker-post-1" }),
      );
    } else {
      expect(detachedRun).toBeUndefined();
    }
    expect(order).toEqual(selectsModel ? ["load", "detach", "update"] : ["load", "update"]);
    const sent = updateModelPickerPost.mock.calls[0]?.[0];
    expect(sent?.message).toContain(visibleText);
    expect(sent?.message.includes("Some models could not be refreshed.")).toBe(
      refreshWarning !== undefined,
    );
    if (hasModels) {
      expect(JSON.stringify(sent?.buttons)).toContain(
        action === "list" || selectsModel ? '"model":"gpt-5.4"' : '"provider":"openai"',
      );
    }
    expect(mocks.recordDeliveredCommandExchange.mock.calls[0]?.[0]).toMatchObject({
      sessionKey: "agent:main:mm",
      commandText:
        action === "select"
          ? mixedSelection
            ? "/model OpenAI/ GPT-5.4 "
            : "/model openai/gpt-5.4"
          : action === "list"
            ? "/models openai"
            : "/models",
      commandId:
        action === "select"
          ? '["mattermost","default","channel:channel-1","interaction:picker-post-1:select:openai/gpt-5.4"]'
          : catalogStatus === "empty"
            ? expect.stringMatching(/^mattermost:default:channel-1:picker-post-1:/)
            : `mattermost:default:channel-1:trigger-${action}`,
      replyText: expect.stringContaining(visibleText),
    });
  },
);

it.each([
  { code: "PAIR1234", pairing: true },
  { code: "", pairing: false },
])("answers a DM pairing picker action with code=$code", async ({ code, pairing }) => {
  vi.clearAllMocks();
  mocks.parseContext.mockReturnValue({ action: "providers", ownerUserId: "user-1" });
  mocks.authorize.mockResolvedValue({ ok: false, denyReason: "dm-pairing" });
  const buildReply = vi.fn(buildPairingReply);
  const monitor = {
    account: { accountId: "default", config: {} },
    cfg: {},
    core: {
      channel: {
        commands: { shouldHandleTextCommands: vi.fn(() => true) },
        pairing: { buildPairingReply: buildReply },
        text: { hasControlCommand: vi.fn(() => true) },
      },
    },
    pairing: {
      readAllowFromStore: vi.fn(async () => []),
      upsertPairingRequest: vi.fn(async () => ({ code, created: false })),
    },
    resources: {
      resolveChannelInfo: vi.fn(async () => ({ id: "channel-1", type: "D" })),
      updateModelPickerPost: vi.fn(),
    },
    runtime: { error: vi.fn() },
  } as unknown as MattermostMonitorContext;

  const response = await createMattermostModelPickerInteractionHandler(monitor)({
    payload: {
      channel_id: "channel-1",
      post_id: "picker-post-1",
      user_id: "user-1",
    },
    userName: "tester",
    context: {},
    post: { id: "picker-post-1", channel_id: "channel-1", message: "picker" },
  });

  if (pairing) {
    expectPairingReplyText(response?.ephemeral_text ?? "", {
      channel: "mattermost",
      idLine: "Your Mattermost user id: user-1",
      code,
    });
    expect(buildReply).toHaveBeenCalledOnce();
  } else {
    expect(response?.ephemeral_text).toContain("DM pairing is full");
    expect(response?.ephemeral_text).toContain("no pairing request was saved");
    expect(response?.ephemeral_text).not.toContain("pairing approve");
    expect(buildReply).not.toHaveBeenCalled();
  }
  expect(mocks.dispatch).not.toHaveBeenCalled();
});
