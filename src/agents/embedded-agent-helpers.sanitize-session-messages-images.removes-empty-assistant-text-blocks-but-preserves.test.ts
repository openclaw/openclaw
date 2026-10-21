import type { AssistantMessage } from "openclaw/plugin-sdk/llm";
import { expect, it } from "vitest";
import { createNoisyPngBuffer } from "../../test/helpers/image-fixtures.js";
import { sanitizeGoogleAssistantFirstOrdering as sanitizeGoogleTurnOrdering } from "../shared/google-turn-ordering.js";
import { sanitizeSessionMessagesImages } from "./embedded-agent-helpers/images.js";
import {
  castAgentMessages,
  makeAgentAssistantMessage,
} from "./test-helpers/agent-message-fixtures.js";

const text = (value: string) => ({ type: "text" as const, text: value });
const call = (id: string) => ({ type: "toolCall" as const, id, name: "read", arguments: {} });
const assistant = (
  content: AssistantMessage["content"],
  overrides: Partial<AssistantMessage> = {},
) => makeAgentAssistantMessage({ content, model: "gpt-5.4", ...overrides });
const bareAssistant = (content: unknown[]) => ({ role: "assistant", content });
const thinking = (value: string, signature?: string) => ({
  type: "thinking",
  thinking: value,
  ...(signature ? { thought_signature: signature } : {}),
});
type Options = Parameters<typeof sanitizeSessionMessagesImages>[2];
async function check(input: unknown[], expected: unknown[], options?: Options) {
  const actual = await sanitizeSessionMessagesImages(castAgentMessages(input), "test", options);
  expect(actual).toEqual(expected);
}
const replay = {
  v: 1,
  type: "openai-responses-compaction",
  data: "opaque-checkpoint",
  replayIndex: 1,
  provider: "openai",
  api: "openai-responses",
  model: "gpt-5.4",
} as const;

it("sanitizes legacy tool-use IDs alongside tool-call IDs", async () => {
  const toolUse = (id: string) => ({ type: "toolUse", id, name: "test", input: {} });
  const result = { role: "toolResult", toolUseId: "call_abc|item:123", content: [text("ok")] };
  await check(
    [bareAssistant([toolUse("call_abc|item:123"), call("call_abc|item:456")]), result],
    [
      bareAssistant([toolUse("callabcitem123"), call("callabcitem456")]),
      { ...result, toolUseId: "callabcitem123", toolCallId: "callabcitem123" },
    ],
    { sanitizeToolCallIds: true, toolCallIdMode: "strict" },
  );
});

it.each([true, false])("repairs an empty-text checkpoint (tool=%s)", async (hasTool) => {
  const content = hasTool ? [call("call_1")] : [];
  const message = assistant([text(""), ...content], {
    providerReplay: { ...replay, replayIndex: hasTool ? 1 : 0 },
  });
  const providerReplay = hasTool ? { ...replay, replayIndex: 0 } : undefined;
  await check([message], [{ ...message, content: structuredClone(content), providerReplay }]);
});

it("drops empty assistant turns while preserving the user turn", async () => {
  const user = { role: "user" as const, content: "hello", timestamp: 0 };
  await check([user, assistant([text(" ")]), assistant([], { stopReason: "error" })], [user]);
});

it("keeps user and tool-result content nonempty", async () => {
  const input = castAgentMessages([
    { role: "user", content: [text(""), text("")] },
    { role: "toolResult", toolCallId: "tool-1", content: [text("   "), text("")] },
  ]);
  await check(input, [
    { ...input[0], content: [text("[empty content omitted]")] },
    { ...input[1], content: [text("[empty content omitted]")] },
  ]);
});

it.each([false, true])("applies signature policy (images-only=%s)", async (imagesOnly) => {
  const input = imagesOnly
    ? [thinking("internal", "msg_abc123"), text(" "), text("visible")]
    : [{ ...text("hello"), thought_signature: "msg_abc123" }, thinking("reasoning", "AQID")];
  const expected = imagesOnly
    ? [thinking("internal"), text("visible")]
    : [text("hello"), thinking("reasoning", "AQID")];
  await check(
    [bareAssistant(input)],
    [bareAssistant(expected)],
    imagesOnly
      ? {
          sanitizeMode: "images-only",
          sanitizeThoughtSignatures: { allowBase64Only: true, includeCamelCase: true },
        }
      : undefined,
  );
});
it("keeps corrupt history images omitted after error and a recovered reply", async () => {
  const png = createNoisyPngBuffer(64, 64);
  const truncated = png.subarray(0, Math.floor(png.length / 2)).toString("base64");
  const valid = png.toString("base64");
  const image = (data: string) => ({ type: "image" as const, data, mimeType: "image/png" });
  const omitted = {
    type: "text",
    text: expect.stringMatching(/^\[session:history\] omitted image payload: .*decode/i),
  };
  const stored = castAgentMessages([
    {
      role: "user",
      content: [text("inspect these"), image(truncated), image(valid)],
      timestamp: 1,
    },
    assistant([call("t1")], { stopReason: "toolUse" }),
    {
      role: "toolResult",
      toolCallId: "t1",
      toolName: "read",
      content: [text("permission denied"), image(truncated)],
      isError: true,
      timestamp: 3,
    },
    assistant([text("interrupted")], { stopReason: "error" }),
  ]);
  const original = structuredClone(stored);
  const expected = castAgentMessages([
    { ...stored[0], content: [text("inspect these"), omitted, image(valid)] },
    stored[1],
    { ...stored[2], content: [text("permission denied"), omitted] },
    stored[3],
  ]);
  expect(await sanitizeSessionMessagesImages(stored, "session:history")).toEqual(expected);
  expect(stored).toEqual(original);

  const recovered = assistant([text("recovered")]);
  expect(await sanitizeSessionMessagesImages([...stored, recovered], "session:history")).toEqual([
    ...expected,
    recovered,
  ]);
});
it("prepends a user turn before assistant-first history", () => {
  const message = assistant([call("call_1")]);
  expect(sanitizeGoogleTurnOrdering([message])).toEqual([
    expect.objectContaining({ role: "user" }),
    message,
  ]);
});
