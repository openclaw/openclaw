import { withinTest } from "openclaw/plugin-sdk/test-fixtures";
import { describe, expect, it } from "vitest";
import {
  buildChannelStreamingFixtureEvents,
  resolveTelegramChannelStreamingPause,
} from "./mock-openai-events.js";
import {
  createMockServerTestHarness,
  expectOpenAiNonStreamingResponsesJson,
  makeUserInput,
  outputText,
  postResponses,
  requireRecord,
} from "./server.test-harness.js";

const { startMockServer } = createMockServerTestHarness();
const senderEnvelope =
  'Conversation info: ⟦openclaw:ctx⟧\n```json\n{"sender":{"id":"qa-user","name":"QA Operator","username":"qa_operator"}}\n```\n\n';

describe("Telegram policy hot-reload mock provider", () => {
  it.for([
    { label: "bare input", prefix: "" },
    { label: "timestamped input", prefix: "[Sat 2026-10-03 11:56 UTC] " },
    {
      label: "timestamped sender context",
      prefix: `[Sat 2026-10-03 11:56 UTC] ${senderEnvelope}`,
    },
  ])(
    "holds an incomplete preview before the final answer with $label",
    async ({ prefix }, { signal }) => {
      let releaseCompletion: (() => void) | undefined;
      const completionGate = new Promise<void>((resolve) => {
        releaseCompletion = resolve;
      });
      const server = await startMockServer({
        telegramChannelStreamingPause: () => completionGate,
      });
      const marker = "TG-RELOAD-root-a1b2c3d4";
      const prompt = `${prefix}Write 40 numbered plain-text lines. Every line must contain ${marker} and the words hot reload keeps this conversation connected. Finish with a separate final line containing ${marker}-END. Do not use tools, Markdown, or explicit reply tags.`;
      const expected = [
        ...Array.from(
          { length: 40 },
          (_, index) => `${index + 1}. ${marker} hot reload keeps this conversation connected`,
        ),
        `${marker}-END`,
      ].join("\n");
      const expectedPreview = `1. ${marker} hot reload keeps this conversation connected`;
      const response = await postResponses(server, {
        model: "gpt-5.6-luna",
        stream: true,
        input: [makeUserInput(prompt)],
      });
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/event-stream");
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      const events: Array<Record<string, unknown>> = [];
      let pending = "";
      let preview = "";
      const readEvents = async () => {
        const part = await withinTest(reader.read(), signal);
        pending += decoder.decode(part.value, { stream: !part.done });
        const frames = pending.split("\n\n");
        pending = frames.pop() ?? "";
        for (const frame of frames) {
          if (!frame.startsWith("data: {") || !frame.endsWith("}")) {
            continue;
          }
          const event = requireRecord(JSON.parse(frame.slice("data: ".length)), "SSE event");
          events.push(event);
          if (event.type === "response.output_text.delta" && typeof event.delta === "string") {
            preview += event.delta;
          }
        }
        return part.done;
      };
      try {
        while (preview.length < expectedPreview.length) {
          expect(await readEvents()).toBe(false);
        }
        expect(preview).toBe(expectedPreview);
        expect(events.map((event) => event.type)).not.toContain("response.output_text.done");
        expect(events.map((event) => event.type)).not.toContain("response.completed");
        releaseCompletion?.();
        while (!(await readEvents())) {}
        expect(events.find((event) => event.type === "response.output_text.done")?.text).toBe(
          expected,
        );
        expect(
          outputText(events.find((event) => event.type === "response.completed")?.response),
        ).toBe(expected);
      } finally {
        releaseCompletion?.();
        await reader.cancel();
      }
      expect(resolveTelegramChannelStreamingPause(prompt)).toEqual({ previewPauseMs: 3_000 });
    },
  );

  it("answers the next turn through sender context without holding completion", async () => {
    const server = await startMockServer();
    const marker = "TG-RELOAD-account-a1b2c3d4-NEXT";
    const prompt = `[Sat 2026-10-03 11:56 UTC] ${senderEnvelope}Write 12 numbered plain-text lines. Every line must contain ${marker} and the words new policy keeps this conversation connected. Finish with a separate final line containing ${marker}-END. Do not use tools, Markdown, or explicit reply tags.`;
    const response = await expectOpenAiNonStreamingResponsesJson(server, {
      input: [makeUserInput(prompt)],
    });
    expect(outputText(response)).toBe(
      [
        ...Array.from(
          { length: 12 },
          (_, index) => `${index + 1}. ${marker} new policy keeps this conversation connected`,
        ),
        `${marker}-END`,
      ].join("\n"),
    );
    expect(resolveTelegramChannelStreamingPause(prompt)).toBeUndefined();
  });

  it.each([
    {
      label: "quoted history",
      wrap: (prompt: string) =>
        `<conversation_context>\n${senderEnvelope}${prompt}\n</conversation_context>\n\nCurrent user request:\nReply with a different answer.`,
    },
    {
      label: "sender metadata",
      wrap: (prompt: string) =>
        `Conversation info: ⟦openclaw:ctx⟧\n\`\`\`json\n${JSON.stringify({ sender: { name: prompt } })}\n\`\`\`\n\nReply with a different answer.`,
    },
    {
      label: "an unmarked authored heading",
      wrap: (prompt: string) => `Conversation info:\n\`\`\`json\n{}\n\`\`\`\n\n${prompt}`,
    },
  ])("does not select a policy instruction from $label", async ({ wrap }) => {
    const server = await startMockServer();
    const marker = "TG-RELOAD-root-a1b2c3d4";
    const prompt = `Write 40 numbered plain-text lines. Every line must contain ${marker} and the words hot reload keeps this conversation connected. Finish with a separate final line containing ${marker}-END. Do not use tools, Markdown, or explicit reply tags.`;
    const response = await expectOpenAiNonStreamingResponsesJson(server, {
      input: [makeUserInput(wrap(prompt))],
    });
    expect(JSON.stringify(response)).not.toContain(marker);
  });

  it("does not capture unrelated numbered-line prompts", () => {
    const prompts = [
      "Write 40 numbered plain-text lines. Every line must contain OTHER-MARKER and the words hot reload keeps this conversation connected. Finish with a separate final line containing OTHER-MARKER-END. Do not use tools, Markdown, or explicit reply tags.",
      "Write 40 numbered plain-text lines. Every line must contain TG-RELOAD-account-a1b2c3d4 and the words new policy keeps this conversation connected. Finish with a separate final line containing TG-RELOAD-account-a1b2c3d4-END. Do not use tools, Markdown, or explicit reply tags.",
      "Write 12 numbered plain-text lines. Every line must contain TG-RELOAD-root-a1b2c3d4-NEXT and the words hot reload keeps this conversation connected. Finish with a separate final line containing TG-RELOAD-root-a1b2c3d4-NEXT-END. Do not use tools, Markdown, or explicit reply tags.",
    ];
    for (const prompt of prompts) {
      expect(
        buildChannelStreamingFixtureEvents({
          currentPrompt: prompt,
          allInputText: prompt,
          hasCompletedToolOutput: false,
        }),
      ).toBeUndefined();
      expect(resolveTelegramChannelStreamingPause(prompt)).toBeUndefined();
    }
  });
});
