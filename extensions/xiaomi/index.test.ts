import type { StreamFn } from "@mariozechner/pi-agent-core";
import { describe, expect, it } from "vitest";
import { registerSingleProviderPlugin } from "../../test/helpers/plugins/plugin-registration.js";
import plugin from "./index.js";

type FakeStream = {
  result: () => Promise<unknown>;
  [Symbol.asyncIterator]: () => AsyncIterator<unknown>;
};

function createFakeStream(params: { events: unknown[]; resultMessage: unknown }): FakeStream {
  return {
    async result() {
      return params.resultMessage;
    },
    [Symbol.asyncIterator]() {
      return (async function* () {
        for (const event of params.events) {
          yield event;
        }
      })();
    },
  };
}

function runWrappedXiaomiStream(params: {
  modelId: string;
  events: unknown[];
  resultMessage: unknown;
}) {
  const provider = registerSingleProviderPlugin(plugin);
  const baseStreamFn: StreamFn = () =>
    createFakeStream({
      events: params.events,
      resultMessage: params.resultMessage,
    }) as ReturnType<StreamFn>;

  const wrapped =
    provider.wrapStreamFn?.({
      provider: "xiaomi",
      modelId: params.modelId,
      model: {
        api: "openai-completions",
        provider: "xiaomi",
        id: params.modelId,
      },
      streamFn: baseStreamFn,
    } as never) ?? baseStreamFn;

  return wrapped(
    {
      api: "openai-completions",
      provider: "xiaomi",
      id: params.modelId,
    } as never,
    { messages: [] } as never,
    {},
  ) as FakeStream;
}

describe("xiaomi provider plugin", () => {
  it.each(["mimo-v2-pro", "mimo-v2-omni"])(
    "normalizes reasoning-only final assistant messages into text for %s",
    async (modelId) => {
      const stream = runWrappedXiaomiStream({
        modelId,
        events: [
          {
            type: "done",
            reason: "stop",
            message: {
              role: "assistant",
              content: [{ type: "thinking", thinking: "MiMo final answer" }],
              stopReason: "stop",
            },
          },
        ],
        resultMessage: {
          role: "assistant",
          content: [{ type: "thinking", thinking: "MiMo final answer" }],
          stopReason: "stop",
        },
      });

      const events: unknown[] = [];
      for await (const event of stream) {
        events.push(event);
      }

      await expect(stream.result()).resolves.toEqual({
        role: "assistant",
        content: [{ type: "text", text: "MiMo final answer" }],
        stopReason: "stop",
      });
      expect(events).toEqual([
        {
          type: "done",
          reason: "stop",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "MiMo final answer" }],
            stopReason: "stop",
          },
        },
      ]);
    },
  );

  it("leaves non-target Xiaomi models unchanged", async () => {
    const stream = runWrappedXiaomiStream({
      modelId: "mimo-v2-flash",
      events: [
        {
          type: "done",
          reason: "stop",
          message: {
            role: "assistant",
            content: [{ type: "thinking", thinking: "keep as thinking" }],
            stopReason: "stop",
          },
        },
      ],
      resultMessage: {
        role: "assistant",
        content: [{ type: "thinking", thinking: "keep as thinking" }],
        stopReason: "stop",
      },
    });

    const events: unknown[] = [];
    for await (const event of stream) {
      events.push(event);
    }

    await expect(stream.result()).resolves.toEqual({
      role: "assistant",
      content: [{ type: "thinking", thinking: "keep as thinking" }],
      stopReason: "stop",
    });
    expect(events).toEqual([
      {
        type: "done",
        reason: "stop",
        message: {
          role: "assistant",
          content: [{ type: "thinking", thinking: "keep as thinking" }],
          stopReason: "stop",
        },
      },
    ]);
  });
});
