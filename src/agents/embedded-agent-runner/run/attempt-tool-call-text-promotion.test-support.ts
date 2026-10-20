import { createFakeStream, type FakeWrappedStream } from "./attempt-stream.test-helpers.js";
import { wrapStreamFnPromoteStandaloneTextToolCalls } from "./attempt-tool-call-text-promotion.js";

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
