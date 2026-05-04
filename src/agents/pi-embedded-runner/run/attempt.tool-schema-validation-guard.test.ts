import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import type { AnyAgentTool } from "../../pi-tools.types.js";
import {
  RepeatedToolSchemaValidationError,
  wrapStreamFnAbortRepeatedToolSchemaValidationFailures,
} from "./attempt.tool-schema-validation-guard.js";

type FakeWrappedStream = {
  result: () => Promise<unknown>;
  [Symbol.asyncIterator]: () => AsyncIterator<unknown>;
};

type FakeStreamFn = (
  model: never,
  context: never,
  options: never,
) => FakeWrappedStream | Promise<FakeWrappedStream>;

const model = {
  provider: "openai-codex",
  id: "gpt-5.5",
} as never;

function createRequiredArgsTool(): AnyAgentTool {
  return {
    name: "write",
    label: "Write",
    description: "Write a file",
    parameters: Type.Object({
      path: Type.String(),
      content: Type.String(),
    }),
    execute: vi.fn(),
  };
}

function createFakeStream(message: unknown): FakeWrappedStream {
  return {
    async result() {
      return message;
    },
    [Symbol.asyncIterator]() {
      return (async function* () {
        yield { type: "done", message };
      })();
    },
  };
}

function createAssistantToolCall(args: unknown, responseId = "resp_123"): unknown {
  return {
    role: "assistant",
    provider: "openai-codex",
    model: "gpt-5.5",
    responseId,
    content: [
      {
        type: "toolCall",
        id: "call_write",
        name: "write",
        arguments: args,
      },
    ],
  };
}

describe("wrapStreamFnAbortRepeatedToolSchemaValidationFailures", () => {
  it("aborts on the third consecutive identical schema validation failure", async () => {
    const tool = createRequiredArgsTool();
    const baseFn = vi.fn((message: unknown) => createFakeStream(message));
    const wrapped = wrapStreamFnAbortRepeatedToolSchemaValidationFailures(
      ((_: never, context: unknown) => baseFn(context)) as never,
      [tool],
    ) as FakeStreamFn;

    await expect(
      (
        await Promise.resolve(wrapped(model, createAssistantToolCall({}) as never, {} as never))
      ).result(),
    ).resolves.toMatchObject({ role: "assistant" });
    await expect(
      (
        await Promise.resolve(wrapped(model, createAssistantToolCall({}) as never, {} as never))
      ).result(),
    ).resolves.toMatchObject({ role: "assistant" });
    await expect(
      (
        await Promise.resolve(wrapped(model, createAssistantToolCall({}) as never, {} as never))
      ).result(),
    ).rejects.toThrow(RepeatedToolSchemaValidationError);

    await expect(
      (
        await Promise.resolve(wrapped(model, createAssistantToolCall({}) as never, {} as never))
      ).result(),
    ).rejects.toThrow(/tool "write"/);
  });

  it("includes tool, missing fields, arguments, provider/model, and response id in the abort diagnostic", async () => {
    const wrapped = wrapStreamFnAbortRepeatedToolSchemaValidationFailures(
      ((_: never, context: unknown) => createFakeStream(context)) as never,
      [createRequiredArgsTool()],
    ) as FakeStreamFn;

    for (let i = 0; i < 2; i += 1) {
      await (
        await Promise.resolve(wrapped(model, createAssistantToolCall({}) as never, {} as never))
      ).result();
    }

    await expect(
      (
        await Promise.resolve(wrapped(model, createAssistantToolCall({}) as never, {} as never))
      ).result(),
    ).rejects.toThrow(
      /tool "write".*Missing fields: content, path.*Received arguments: \{\}.*Provider\/model: openai-codex\/gpt-5\.5.*Response id: resp_123/s,
    );
  });

  it("does not trip for non-identical validation failures", async () => {
    const wrapped = wrapStreamFnAbortRepeatedToolSchemaValidationFailures(
      ((_: never, context: unknown) => createFakeStream(context)) as never,
      [createRequiredArgsTool()],
    ) as FakeStreamFn;

    await (
      await Promise.resolve(wrapped(model, createAssistantToolCall({}) as never, {} as never))
    ).result();
    await (
      await Promise.resolve(wrapped(model, createAssistantToolCall({}) as never, {} as never))
    ).result();
    await (
      await Promise.resolve(
        wrapped(model, createAssistantToolCall({ path: "/tmp/file" }) as never, {} as never),
      )
    ).result();
    await (
      await Promise.resolve(wrapped(model, createAssistantToolCall({}) as never, {} as never))
    ).result();

    await expect(
      (
        await Promise.resolve(wrapped(model, createAssistantToolCall({}) as never, {} as never))
      ).result(),
    ).resolves.toMatchObject({ role: "assistant" });
  });

  it("does not affect valid tool calls", async () => {
    const wrapped = wrapStreamFnAbortRepeatedToolSchemaValidationFailures(
      ((_: never, context: unknown) => createFakeStream(context)) as never,
      [createRequiredArgsTool()],
    ) as FakeStreamFn;

    await expect(
      (
        await Promise.resolve(
          wrapped(
            model,
            createAssistantToolCall({ path: "/tmp/a", content: "ok" }) as never,
            {} as never,
          ),
        )
      ).result(),
    ).resolves.toMatchObject({ role: "assistant" });
  });
});
