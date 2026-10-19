import { createServer } from "node:http";
import { expect, it } from "vitest";
import type { AssistantMessageEvent } from "../types.js";
import { processCompletionsStream } from "./openai-completions-stream.js";
import { createOpenAICompletionsTransportStreamFn } from "./openai-completions-transport.js";
import {
  type CapturedStreamEvent,
  createAssistantOutput,
  createDeepSeekCompletionsModel,
  makeCompletionsChunk,
  streamChunks,
} from "./openai-completions.test-support.js";

const nativeTool = {
  index: 0,
  id: "call_native_1",
  type: "function",
  function: { name: "read", arguments: '{"path":"/tmp/native.md"}' },
};
const nativeCall = {
  type: "toolCall",
  id: "call_native_1",
  name: "read",
  arguments: { path: "/tmp/native.md" },
};

async function runDsml(
  chunks: Parameters<typeof streamChunks>[0],
  options?: Parameters<typeof processCompletionsStream>[4],
  events: CapturedStreamEvent[] = [],
) {
  const model = createDeepSeekCompletionsModel();
  const output = createAssistantOutput(model);
  await processCompletionsStream(
    streamChunks(chunks),
    output,
    model,
    { push: (event) => events.push(event as CapturedStreamEvent) },
    options,
  );
  return { output, events };
}
const text = (value: string) => ({ type: "text", text: value });
const characterChunks = (content: string) => [
  ...Array.from(content, (char) => makeCompletionsChunk({ content: char })),
  makeCompletionsChunk({}, "stop"),
];
function expectRecovered(
  output: ReturnType<typeof createAssistantOutput>,
  name: string,
  args: Record<string, unknown>,
) {
  expect(output.stopReason).toBe("toolUse");
  expect(output.content).toEqual([
    {
      type: "toolCall",
      id: expect.stringMatching(/^call_[0-9a-f]{24}$/),
      name,
      arguments: args,
    },
  ]);
}

it("filters DeepSeek DSML content without disturbing native tool calls", async () => {
  const { output, events } = await runDsml([
    makeCompletionsChunk({
      content: "before <｜DSML｜tool_use_error>body</｜DSML｜tool_use_error> after",
    }),
    makeCompletionsChunk(
      {
        content: "<|DSML|tool_calls>shadow</|DSML|tool_calls>",
        tool_calls: [nativeTool],
      },
      "tool_calls",
    ),
  ]);

  expect(output.content).toEqual([text("before  after"), nativeCall]);
  expect(JSON.stringify(events)).not.toContain("DSML");
});

it("keeps DeepSeek DSML state across native tool-call chunks", async () => {
  const { output, events } = await runDsml([
    makeCompletionsChunk(
      {
        content: "before <|DSML|tool",
        tool_calls: [nativeTool],
      },
      "tool_calls",
    ),
    makeCompletionsChunk({
      content: "_calls>shadow</|DSML|tool_calls> after",
    }),
  ]);

  expect(output.content).toEqual([text("before "), nativeCall, text(" after")]);
  expect(JSON.stringify(events)).not.toContain("DSML");
});

it.each(["tool_calls", "calls", " calls"])(
  "recovers streamed DSML %s parameter tool calls",
  async (kind) => {
    const marker = kind.startsWith(" ") ? "｜｜DSML｜｜ " : "｜｜DSML｜｜";
    const wrapper = kind.trim();
    const content = `<${marker}${wrapper}><${marker}invoke name="session_status"><${marker}parameter name="sessionKey" string="true">current</${marker}parameter></${marker}invoke></${marker}${wrapper}>`;
    const { output, events } = await runDsml(characterChunks(content));

    expectRecovered(output, "session_status", { sessionKey: "current" });
    expect(JSON.stringify(events)).not.toContain("DSML");
  },
);

it("hides reported calls markup with slashless closing tags without executing it", async () => {
  const content =
    'before <｜｜DSML｜｜ calls><｜｜DSML｜｜ invoke name="write">' +
    '<｜｜DSML｜｜ parameter name="path" string="true">/tmp/unexecuted' +
    "<｜｜DSML｜｜ parameter><｜｜DSML｜｜ invoke><｜｜DSML｜｜ calls>";

  const { output, events } = await runDsml(characterChunks(content));

  expect(output.content).toEqual([{ type: "text", text: "before " }]);
  expect(output.stopReason).toBe("stop");
  expect(JSON.stringify(events)).not.toContain("DSML");
});

it.each(["calls", "tool_calls"])(
  "hides DSML %s in direct mode without recovering tools",
  async (kind) => {
    const content =
      `before <｜｜DSML｜｜ ${kind}><｜｜DSML｜｜ invoke name="write">` +
      '<｜｜DSML｜｜ parameter name="path" string="true">/tmp/unexecuted</｜｜DSML｜｜ parameter>' +
      `</｜｜DSML｜｜ invoke></｜｜DSML｜｜ ${kind}> after`;

    const { output, events } = await runDsml(characterChunks(content), {
      mode: "direct",
      beforeContentBlock() {},
    });

    expect(output.content).toEqual([{ type: "text", text: "before  after" }]);
    expect(output.stopReason).toBe("stop");
    expect(JSON.stringify(events)).not.toContain("DSML");
  },
);

it.each([
  { name: "__proto__", value: "scalar value" },
  { name: "text", value: "" },
])(
  "preserves duplicate DSML parameter $name as an own scalar argument ($value)",
  async ({ name, value }) => {
    const content =
      '<|DSML|tool_calls><|DSML|invoke name="echo">' +
      `<|DSML|parameter name="${name}" string="true">first value</|DSML|parameter>` +
      `<|DSML|parameter name="${name}" string="true">${value}</|DSML|parameter>` +
      "</|DSML|invoke></|DSML|tool_calls>";

    const { output } = await runDsml([makeCompletionsChunk({ content }, "stop")]);

    expect(output.stopReason).toBe("toolUse");
    expect(output.content).toHaveLength(1);
    const call = output.content.find((block) => block.type === "toolCall");
    expect(call).toMatchObject({ type: "toolCall", name: "echo" });
    expect(call?.arguments).toStrictEqual({ [name]: value });
    expect(Object.getOwnPropertyDescriptor(call?.arguments, name)).toMatchObject({
      value,
      enumerable: true,
    });
    expect(Object.getPrototypeOf(call?.arguments)).toBe(Object.prototype);
  },
);

it("rejects an oversized DeepSeek DSML block when the crossing chunk contains its close", async () => {
  const events: CapturedStreamEvent[] = [];

  const prefix = '<|DSML|tool_calls><|DSML|invoke name="read">{"path":"';
  const suffix = '"}</|DSML|invoke></|DSML|tool_calls>';
  const padding = "x".repeat(256_001 - Buffer.byteLength(prefix + suffix, "utf8"));
  const content = prefix + padding + suffix + " after";
  expect(Buffer.byteLength(prefix + padding + suffix, "utf8")).toBe(256_001);
  const chunks = Array.from({ length: Math.ceil(content.length / 4096) }, (_, index) =>
    content.slice(index * 4096, (index + 1) * 4096),
  );

  await expect(
    runDsml(
      chunks.map((contentChunk, index) =>
        makeCompletionsChunk(
          { content: contentChunk },
          index === chunks.length - 1 ? "stop" : null,
        ),
      ),
      undefined,
      events,
    ),
  ).rejects.toThrow("Exceeded DeepSeek DSML recovery buffer limit");
  expect(events.filter((event) => event.type?.startsWith("toolcall_"))).toEqual([]);
});

it("counts split surrogate pairs exactly at the DeepSeek DSML recovery cap", async () => {
  const prefix = '<|DSML|tool_calls><|DSML|invoke name="read">{"path":"';
  const suffix = '"}</|DSML|invoke>';
  const outerClose = "</|DSML|tool_calls>";
  const emoji = "\u{1f600}";
  const padding = "x".repeat(
    256_000 - Buffer.byteLength(prefix + emoji + suffix + outerClose, "utf8"),
  );
  const beforeSplit = prefix + padding + "\uD83D";
  const afterSplit = "\uDE00" + suffix;
  expect(Buffer.byteLength(beforeSplit + afterSplit + outerClose, "utf8")).toBe(256_000);

  const { output } = await runDsml([
    makeCompletionsChunk({ content: beforeSplit }),
    makeCompletionsChunk({ content: afterSplit }),
    makeCompletionsChunk({ content: outerClose }, "stop"),
  ]);

  expectRecovered(output, "read", { path: padding + emoji });
});

it("surfaces an oversized DeepSeek DSML recovery buffer as a transport error", async () => {
  await using server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
      });
      for (const chunk of [
        makeCompletionsChunk({
          content: "<|DSML|tool_calls>" + "x".repeat(300_000),
        }),
        makeCompletionsChunk({}, "stop"),
      ]) {
        res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      }
      res.end("data: [DONE]\n\n");
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Missing loopback server address");
  }
  const model = {
    ...createDeepSeekCompletionsModel(),
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
  };
  const stream = await createOpenAICompletionsTransportStreamFn()(
    model,
    {
      messages: [{ role: "user", content: "Read the file", timestamp: Date.now() }],
    },
    { apiKey: "test-key" },
  );
  const events: AssistantMessageEvent[] = [];
  for await (const event of stream) {
    events.push(event);
  }
  expect(events).toContainEqual(
    expect.objectContaining({
      type: "error",
      reason: "error",
      error: expect.objectContaining({
        errorMessage: "Exceeded DeepSeek DSML recovery buffer limit",
        content: [],
      }),
    }),
  );
  expect(events.filter((event) => event.type === "toolcall_start")).toEqual([]);
  expect(events.filter((event) => event.type === "toolcall_delta")).toEqual([]);
});
