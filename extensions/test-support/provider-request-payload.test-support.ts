import {
  streamSimple,
  type Context,
  type Model,
  type SimpleStreamOptions,
} from "openclaw/plugin-sdk/llm";

export async function captureProviderRequestPayload(
  model: Model,
  options: Pick<SimpleStreamOptions, "sessionId" | "cacheRetention"> = {},
  context: Context = { messages: [] },
) {
  let payload: unknown;
  const result = await streamSimple(model, context, {
    apiKey: "synthetic-unused-key",
    sessionId: "synthetic-session",
    cacheRetention: "long",
    ...options,
    onPayload(value) {
      payload = value;
      throw new Error("captured before request");
    },
  }).result();
  return { result, payload };
}
