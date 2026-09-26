import { describe, expect, it } from "vitest";
import { createAssistantMessageEventStream } from "../../../llm/utils/event-stream.js";
import type { StreamFn } from "../../runtime/index.js";
import { makeAgentAssistantMessage } from "../../test-helpers/agent-message-fixtures.js";
import { makeProviderModelFixture } from "../../test-helpers/provider-model-fixture.js";
import { wrapStreamFnTrimToolCallNames } from "./attempt-tool-call-stream-normalization.js";

const model = makeProviderModelFixture({
  id: "test-model",
  provider: "openai",
  api: "openai-responses",
  baseUrl: "https://example.com",
});

const toolCallStream: StreamFn = () => {
  const message = makeAgentAssistantMessage({
    stopReason: "toolUse",
    content: [
      { type: "toolCall", id: "call-exec", name: " exec ", arguments: { command: "echo retry" } },
    ],
  });
  const stream = createAssistantMessageEventStream();
  stream.push({ type: "done", reason: "toolUse", message });
  stream.end();
  return stream;
};

describe.each(["result", "stream"])("unavailable-tool loop guard via %s", (mode) => {
  async function readResponse(streamFn: StreamFn) {
    const stream = await streamFn(model, { messages: [] });
    if (mode === "stream") {
      for await (const event of stream) {
        void event;
      }
    }
    return await stream.result();
  }

  it.each([
    { label: "nonempty tool set", allowedToolNames: new Set(["read"]) },
    { label: "empty tool set", allowedToolNames: new Set<string>() },
  ])("stops repeated unavailable calls with $label", async ({ allowedToolNames }) => {
    const wrapped = wrapStreamFnTrimToolCallNames(toolCallStream, allowedToolNames, {
      unknownToolThreshold: 10,
    });

    for (let i = 0; i < 10; i += 1) {
      const message = await readResponse(wrapped);
      expect(message.content).toEqual([
        expect.objectContaining({ type: "toolCall", name: "exec" }),
      ]);
    }

    const blocked = await readResponse(wrapped);
    expect(blocked.role).toBe("assistant");
    expect(blocked.content).toEqual([{ type: "text", text: expect.stringContaining('"exec"') }]);
  });

  it.each([
    { label: "guard disabled", allowedToolNames: new Set(["read"]), guardOptions: undefined },
    {
      label: "guard disabled with no tools",
      allowedToolNames: new Set<string>(),
      guardOptions: undefined,
    },
    {
      label: "tool availability unspecified",
      allowedToolNames: undefined,
      guardOptions: { unknownToolThreshold: 10 },
    },
  ])("preserves repeated calls with $label", async ({ allowedToolNames, guardOptions }) => {
    const wrapped = wrapStreamFnTrimToolCallNames(toolCallStream, allowedToolNames, guardOptions);

    for (let i = 0; i < 11; i += 1) {
      const message = await readResponse(wrapped);
      expect(message.content).toEqual([
        expect.objectContaining({ type: "toolCall", name: "exec" }),
      ]);
    }
  });
});
