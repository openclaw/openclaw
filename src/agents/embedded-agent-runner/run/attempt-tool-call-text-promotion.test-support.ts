import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import {
  collectStreamEvents,
  createFakeStream,
  type FakeWrappedStream,
} from "./attempt-stream.test-helpers.js";
import { wrapStreamFnPromoteStandaloneTextToolCalls } from "./attempt-tool-call-text-promotion.js";

export const record = createRequireRecord("object", "expected-label");
export const messageContent = (message: unknown) => record(message, "message").content as unknown[];
export const collectPromotionEvents = async (stream: FakeWrappedStream) =>
  (await collectStreamEvents(stream)).map((event) => record(event, "event"));

export const assistantMessage = (content: unknown[] = []) => ({
  role: "assistant",
  content,
  stopReason: "stop",
});

export const commandText = (command = "pwd", marker = "[tool:exec]") =>
  `${marker}\n<parameter=command>\n${command}\n</parameter>\n</function>`;

export async function wrapPromotionStream(baseFn: () => FakeWrappedStream, toolName = "exec") {
  const wrapped = wrapStreamFnPromoteStandaloneTextToolCalls(baseFn as never, new Set([toolName]));
  return (await wrapped({} as never, {} as never, {} as never)) as FakeWrappedStream;
}

export const createPromotionStream = (
  params: Parameters<typeof createFakeStream>[0],
  toolName = "exec",
) => wrapPromotionStream(() => createFakeStream(params), toolName);
