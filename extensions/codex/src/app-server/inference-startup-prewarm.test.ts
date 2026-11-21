// Register loopback transport fixtures before loading proxy consumers.
// oxfmt-ignore
import { complete, open, post, transport } from "./inference-proxy.capacity-test-support.js";
import { once } from "node:events";
import { afterAll, expect, it, vi } from "vitest";
import { createCodexInferenceModelBinding } from "./inference-dispatch.js";
import { createClientHarness } from "./test-support.js";

// Native startup prewarm uses INITIAL_SUBMIT_ID (the empty string) before a
// conversational turn exists. Both metadata carriers contain that sentinel.
const native = {
  session_id: "fixture-thread",
  thread_id: "fixture-thread",
  turn_id: "",
  request_kind: "prewarm",
};
const body = {
  type: "response.create",
  model: "fixture-model",
  generate: false,
  client_metadata: {
    session_id: native.session_id,
    thread_id: native.thread_id,
    turn_id: "",
    "x-codex-turn-metadata": JSON.stringify(native),
  },
};
const nativeClient = createClientHarness();
const captureModelSource = vi.fn(async () => undefined);
transport.proxyOptions.bindModelExecution = createCodexInferenceModelBinding({
  client: nativeClient.client,
  provider: "fixture",
  assertCurrent: () => {},
  memoryConfigured: () => false,
  resolveModelThreadId: () => undefined,
  captureModelSource,
});
afterAll(() => {
  delete transport.proxyOptions.bindModelExecution;
  nativeClient.client.close();
});

it("relays native startup prewarm without admitting a model turn", async () => {
  const { client, upstream } = await open();
  const received = once(upstream, "message");
  const response = once(client, "message");
  client.send(JSON.stringify(body));
  const first = await Promise.race([
    received.then(([bytes]) => ({ forwarded: bytes.toString() })),
    response.then(([bytes]) => ({ rejected: bytes.toString() })),
  ]);
  expect(first).toEqual({ forwarded: JSON.stringify(body) });
  expect(captureModelSource).not.toHaveBeenCalled();
  await complete(client, upstream);
});

it.each([
  { ...body, generate: true },
  { ...body, generate: undefined },
  {
    ...body,
    client_metadata: {
      ...body.client_metadata,
      "x-codex-turn-metadata": JSON.stringify({ ...native, request_kind: "turn" }),
    },
  },
  {
    ...body,
    client_metadata: { ...body.client_metadata, turn_id: "conflicting-real-turn" },
  },
  {
    ...body,
    client_metadata: {
      ...body.client_metadata,
      "x-codex-turn-metadata": JSON.stringify({
        ...native,
        openclaw_inference_generation: "admitted-generation",
      }),
    },
  },
])("rejects an empty turn outside unbound, non-generating startup prewarm: %j", async (changed) => {
  const result = await post(undefined, false, { body: changed });
  expect(result.status).toBe(403);
  expect(JSON.parse(result.body)).toMatchObject({ error: { code: "model_permission_denied" } });
  expect(transport.fetch).not.toHaveBeenCalled();
  expect(captureModelSource).not.toHaveBeenCalled();
});
