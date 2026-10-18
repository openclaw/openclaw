import { beforeEach, describe, expect, it, vi } from "vitest";

const resolveOptionMock = vi.hoisted(() => vi.fn());
const authorizeMock = vi.hoisted(() => vi.fn());
type InteractionOptions = Parameters<
  typeof import("./interactions.js").createMattermostInteractionHandler
>[0];
const createInteractionHandlerMock = vi.hoisted(() =>
  vi.fn((_options: InteractionOptions) => async () => {}),
);
const registerPluginHttpRouteMock = vi.hoisted(() => vi.fn(() => () => {}));

vi.mock("openclaw/plugin-sdk/question-gateway-runtime", () => ({
  questionGatewayRuntime: { resolveOption: resolveOptionMock },
}));
vi.mock("./monitor-auth.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./monitor-auth.js")>()),
  authorizeMattermostCommandInvocation: authorizeMock,
}));
vi.mock("./interactions.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./interactions.js")>()),
  createMattermostInteractionHandler: createInteractionHandlerMock,
}));
vi.mock("./runtime-api.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./runtime-api.js")>()),
  registerPluginHttpRoute: registerPluginHttpRouteMock,
}));

const { registerMattermostInteractions } = await import("./monitor-interactions.js");

const QUESTION_ID = "ask_0123456789abcdef0123456789abcdef";

const resolveChannelInfoMock = vi.fn(async () => ({ id: "chan-1", type: "O" }));

const error = vi.fn();
const picker = vi.fn(async (): Promise<{ ephemeral_text: string } | null> => null);
const denied = { ok: false, denyReason: "channel-no-allowlist", roomLabel: "#town-square" };
function captureHandlers() {
  registerMattermostInteractions({
    monitor: {
      account: { accountId: "main" },
      cfg: {},
      client: {},
      core: { channel: { commands: { shouldHandleTextCommands: () => true } } },
      pairing: { readAllowFromStore: async () => [] },
      resources: { resolveChannelInfo: resolveChannelInfoMock },
      runtime: { error, log: vi.fn() },
      botUserId: "bot",
    },
    interactionPath: "/mattermost/interactions/main",
    allowedSourceIps: ["127.0.0.1"],
    handleModelPickerInteraction: picker,
  } as never);
  const options = createInteractionHandlerMock.mock.calls[0]?.[0];
  if (!options?.handleInteraction || !options.authorizeButtonClick) {
    throw new Error("registration did not supply interaction handlers");
  }
  return { dispatch: options.handleInteraction, authorize: options.authorizeButtonClick };
}
let handlers: ReturnType<typeof captureHandlers>;
function expectPrompt(response: Awaited<ReturnType<typeof handlers.dispatch>>, text: string) {
  expect(response?.ephemeral_text).toBe(text);
  expect(response?.update).toBeUndefined();
}

function questionInteraction(context: Record<string, unknown>) {
  return {
    payload: {
      channel_id: "chan-1",
      post_id: "post-1",
      user_id: "user-1",
      user_name: "ada",
    },
    userName: "ada",
    actionId: "question-1",
    actionName: "production",
    originalMessage: "Which environment?",
    context,
    post: { id: "post-1", message: "Which environment?" },
  } as never;
}

const questionContext = {
  oc_question: true,
  question_id: QUESTION_ID,
  option_index: 1,
};

describe("mattermost question interactions", () => {
  beforeEach(() => {
    resolveOptionMock.mockReset();
    resolveOptionMock.mockResolvedValue({ status: "answered" });
    authorizeMock.mockReset();
    authorizeMock.mockResolvedValue({ ok: true, roomLabel: "#town-square" });
    resolveChannelInfoMock.mockClear();
    createInteractionHandlerMock.mockClear();
    error.mockReset();
    picker.mockReset();
    picker.mockResolvedValue(null);
    handlers = captureHandlers();
  });

  it("submits the clicked option to the question Gateway and retires the prompt", async () => {
    const response = await handlers.dispatch(questionInteraction(questionContext));

    expect(resolveOptionMock).toHaveBeenCalledTimes(1);
    expect(resolveOptionMock.mock.calls[0]?.[0]).toMatchObject({
      questionId: QUESTION_ID,
      optionIndex: 1,
      senderId: "user-1",
    });
    expect(response?.ephemeral_text).toBe("Answer submitted.");
    expect(response?.update?.props).toEqual({
      attachments: [{ text: "✓ **production** selected by @ada" }],
    });
    expect(picker).not.toHaveBeenCalled();
    expect(authorizeMock).toHaveBeenCalledTimes(1);
    expect(authorizeMock.mock.calls[0]?.[0]).toMatchObject({
      senderId: "user-1",
      channelId: "chan-1",
      hasControlCommand: false,
    });
    expect(resolveChannelInfoMock).toHaveBeenCalledWith("chan-1");
  });

  it("refuses a click current policy denies, before any Gateway I/O", async () => {
    authorizeMock.mockResolvedValue(denied);

    const response = await handlers.dispatch(questionInteraction(questionContext));

    expect(resolveOptionMock).not.toHaveBeenCalled();
    expectPrompt(response, "OpenClaw ignored this action for #town-square.");
  });

  // Updating a denied click would invalidate every rendered button for other users.
  it("leaves the post untouched when the transport refuses a click", async () => {
    authorizeMock.mockResolvedValue(denied);

    const result = await handlers.authorize({
      payload: { channel_id: "chan-1", user_id: "mallory", user_name: "mallory" },
      post: { id: "post-1", message: "Which environment?", props: { attachments: [] } },
    } as never);

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("expected transport authorization to refuse the click");
    }
    expect(result.response?.ephemeral_text).toBe("OpenClaw ignored this action for #town-square.");
    expect(result.response?.update).toBeUndefined();
  });

  it("refuses a click whose access is lost while the Gateway read is in flight", async () => {
    // Re-check authority after the Gateway read, before its write.
    resolveOptionMock.mockImplementation(async (params: { authorize?: () => unknown }) => {
      authorizeMock.mockResolvedValue(denied);
      return (await params.authorize?.()) === false ? { status: "denied" } : { status: "answered" };
    });

    const response = await handlers.dispatch(questionInteraction(questionContext));

    expectPrompt(response, "OpenClaw ignored this action for #town-square.");
  });

  it("keeps the prompt when the question already reached a terminal state", async () => {
    // The resolver reports both an answered and an expired question this way.
    resolveOptionMock.mockResolvedValue({ status: "already-terminal", reason: "already-terminal" });

    const response = await handlers.dispatch(questionInteraction(questionContext));

    expectPrompt(response, "This question was already answered.");
  });

  it("keeps the prompt when the Gateway rejects the answer, and tells the clicker", async () => {
    resolveOptionMock.mockRejectedValue(new Error("gateway down"));

    const response = await handlers.dispatch(questionInteraction(questionContext));

    expectPrompt(response, "Could not submit this answer.");
    expect(error).toHaveBeenCalledWith(expect.stringContaining("gateway down"));
  });

  it("still hands every other click to the model picker", async () => {
    picker.mockResolvedValue({ ephemeral_text: "picker" });

    const response = await handlers.dispatch(
      questionInteraction({ callback_data: "deploy_approve" }),
    );

    expect(authorizeMock).not.toHaveBeenCalled();
    expect(resolveOptionMock).not.toHaveBeenCalled();
    expect(picker).toHaveBeenCalledTimes(1);
    expect(response?.ephemeral_text).toBe("picker");
  });
});
