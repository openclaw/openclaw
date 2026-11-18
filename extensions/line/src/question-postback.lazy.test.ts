import { expect, it, vi } from "vitest";

const gateway = vi.hoisted(() => ({
  loaded: vi.fn(),
  resolveOption: vi.fn<
    (params: { authorize: () => boolean | Promise<boolean> }) => Promise<{
      status: "answered" | "denied";
    }>
  >(async () => ({ status: "answered" })),
}));

vi.mock("openclaw/plugin-sdk/question-gateway-runtime", () => {
  gateway.loaded();
  return { questionGatewayRuntime: { resolveOption: gateway.resolveOption } };
});

it("loads the question Gateway only when resolving a tap", async () => {
  const {
    buildLineQuestionPostbackData,
    parseLineQuestionPostbackData,
    resolveLineQuestionPostback,
  } = await import("./question-postback.js");
  const callback = { questionId: "ask_0123456789abcdef0123456789abcdef", optionIndex: 1 };
  const data = buildLineQuestionPostbackData(callback);
  expect(parseLineQuestionPostbackData(data ?? "")).toEqual(callback);
  expect(gateway.loaded).not.toHaveBeenCalled();

  const cfg = {};
  const authorize = vi.fn(() => true);
  await expect(
    resolveLineQuestionPostback({
      cfg,
      callback,
      senderId: "user-one",
      accountId: "default",
      authorize,
    }),
  ).resolves.toEqual({ status: "answered" });
  expect(gateway.loaded).toHaveBeenCalledTimes(1);
  expect(gateway.resolveOption).toHaveBeenCalledWith({
    cfg,
    questionId: callback.questionId,
    optionIndex: callback.optionIndex,
    senderId: "user-one",
    clientDisplayName: "LINE question (default)",
    authorize,
  });
});

it("preserves a denied answer without turning it into a transport failure", async () => {
  const { resolveLineQuestionPostback } = await import("./question-postback.js");
  const authorize = vi.fn(() => false);
  gateway.resolveOption.mockImplementationOnce(async (params) => ({
    status: (await params.authorize()) ? "answered" : "denied",
  }));
  await expect(
    resolveLineQuestionPostback({
      cfg: {},
      callback: { questionId: "ask_0123456789abcdef0123456789abcdef", optionIndex: 0 },
      senderId: "user-one",
      accountId: "default",
      authorize,
    }),
  ).resolves.toEqual({ status: "denied" });
  expect(authorize).toHaveBeenCalledOnce();
});
