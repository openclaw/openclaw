import { beforeEach, expect, it, vi } from "vitest";

const resolveOptionMock = vi.hoisted(() => vi.fn());
const authorizeMock = vi.hoisted(() => vi.fn());
type InteractionOptions = Parameters<
  typeof import("./interactions.js").createMattermostInteractionHandler
>[0];
const createInteractionHandlerMock = vi.hoisted(() =>
  vi.fn((_options: InteractionOptions) => async () => {}),
);

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
  registerPluginHttpRoute: vi.fn(() => () => {}),
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
  expect(response).toEqual({ ephemeral_text: text });
}

function questionInteraction(context: Record<string, unknown> = questionContext) {
  return {
    payload: { channel_id: "chan-1", post_id: "post-1", user_id: "user-1" },
    userName: "ada",
    actionId: "question-1",
    actionName: "production",
    originalMessage: "Which environment?",
    context,
    post: { id: "post-1", message: "Which environment?" },
  } as never;
}

const submit = () => handlers.dispatch(questionInteraction());

const questionContext = {
  oc_question: true,
  question_id: QUESTION_ID,
  option_index: 1,
};

beforeEach(() => {
  vi.clearAllMocks();
  resolveOptionMock.mockReset().mockResolvedValue({ status: "answered" });
  authorizeMock.mockReset().mockResolvedValue({ ok: true, roomLabel: "#town-square" });
  picker.mockReset().mockResolvedValue(null);
  handlers = captureHandlers();
});

it("submits the clicked option to the question Gateway and retires the prompt", async () => {
  const response = await submit();
  expect(resolveOptionMock).toHaveBeenCalledTimes(1);
  expect([resolveOptionMock.mock.calls[0]?.[0], authorizeMock.mock.calls[0]?.[0]]).toMatchObject([
    { questionId: QUESTION_ID, optionIndex: 1, senderId: "user-1" },
    { senderId: "user-1", channelId: "chan-1", hasControlCommand: false },
  ]);
  expect(response).toEqual({
    ephemeral_text: "Answer submitted.",
    update: {
      message: "Which environment?",
      props: { attachments: [{ text: "✓ **production** selected by @ada" }] },
    },
  });
  expect(picker).not.toHaveBeenCalled();
  expect(authorizeMock).toHaveBeenCalledTimes(1);
  expect(resolveChannelInfoMock).toHaveBeenCalledWith("chan-1");
});

it("refuses a click current policy denies, before any Gateway I/O", async () => {
  authorizeMock.mockResolvedValue(denied);
  const response = await submit();
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

  expect(result).toEqual({
    ok: false,
    response: { ephemeral_text: "OpenClaw ignored this action for #town-square." },
  });
});

it("refuses a click whose access is lost while the Gateway read is in flight", async () => {
  resolveOptionMock.mockImplementation(async (params: { authorize?: () => unknown }) => {
    authorizeMock.mockResolvedValue(denied);
    return (await params.authorize?.()) === false ? { status: "denied" } : { status: "answered" };
  });

  expectPrompt(await submit(), "OpenClaw ignored this action for #town-square.");
});

it.each(["terminal", "gateway failure"] as const)("keeps the prompt after %s", async (state) => {
  if (state === "terminal") {
    resolveOptionMock.mockResolvedValue({ status: "already-terminal", reason: "already-terminal" });
  } else {
    resolveOptionMock.mockRejectedValue(new Error("gateway down"));
  }
  expectPrompt(
    await submit(),
    state === "terminal" ? "This question was already answered." : "Could not submit this answer.",
  );
  if (state === "gateway failure") {
    expect(error).toHaveBeenCalledWith(expect.stringContaining("gateway down"));
  }
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
