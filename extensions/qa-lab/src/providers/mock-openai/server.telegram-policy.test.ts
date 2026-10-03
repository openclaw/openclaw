import { describe, expect, it } from "vitest";
import {
  buildChannelStreamingFixtureEvents,
  resolveTelegramChannelStreamingPause,
} from "./mock-openai-events.js";
import {
  createMockServerTestHarness,
  makeUserInput,
  postResponses,
} from "./server.test-harness.js";

const { startMockServer } = createMockServerTestHarness();

describe("Telegram policy hot-reload mock provider", () => {
  it("keeps the held turn active with the requested long marked response", async () => {
    let releaseCompletion: (() => void) | undefined;
    const completionGate = new Promise<void>((resolve) => {
      releaseCompletion = resolve;
    });
    const server = await startMockServer({
      telegramChannelStreamingPause: () => completionGate,
    });
    const marker = "TG-RELOAD-root-a1b2c3d4";
    const prompt = `Write 40 numbered plain-text lines. Every line must contain ${marker} and the words hot reload keeps this conversation connected. Finish with a separate final line containing ${marker}-END. Do not use tools, Markdown, or explicit reply tags.`;
    const expected = [
      ...Array.from(
        { length: 40 },
        (_, index) => `${index + 1}. ${marker} hot reload keeps this conversation connected`,
      ),
      `${marker}-END`,
    ].join("\n");
    const response = await postResponses(server, {
      model: "gpt-5.6-luna",
      stream: true,
      input: [makeUserInput(prompt)],
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const reader = response.body?.getReader();
    expect(reader).toBeDefined();
    const decoder = new TextDecoder();
    let streamed = "";
    while (!streamed.includes('"type":"response.output_text.delta"')) {
      const part = await reader?.read();
      expect(part?.done).toBe(false);
      streamed += decoder.decode(part?.value, { stream: true });
    }
    expect(streamed).not.toContain('"type":"response.output_text.done"');
    releaseCompletion?.();
    while (!streamed.includes('"type":"response.completed"')) {
      const part = await reader?.read();
      if (part?.done) {
        break;
      }
      streamed += decoder.decode(part?.value, { stream: true });
    }
    const streamedDeltas = streamed
      .split("\n")
      .filter((line) => line.startsWith("data: {") && line.endsWith("}"))
      .map((line) => JSON.parse(line.slice("data: ".length)) as { type?: string; delta?: string })
      .flatMap((event) => (event.type === "response.output_text.delta" ? [event.delta ?? ""] : []));
    expect(streamedDeltas.join("")).toBe(expected);

    const events = buildChannelStreamingFixtureEvents({
      currentPrompt: prompt,
      allInputText: prompt,
      hasCompletedToolOutput: false,
    });
    expect(events).toBeDefined();
    const deltas = events?.flatMap((event) =>
      event.type === "response.output_text.delta" ? [event.delta] : [],
    );
    const doneIndex =
      events?.findIndex((event) => event.type === "response.output_text.done") ?? -1;
    const lastDeltaIndex = events?.findLastIndex(
      (event) => event.type === "response.output_text.delta",
    );
    expect(deltas?.join("")).toBe(expected);
    expect(lastDeltaIndex).toBeGreaterThanOrEqual(0);
    expect(doneIndex).toBeGreaterThan(lastDeltaIndex ?? -1);
    expect(resolveTelegramChannelStreamingPause(prompt)).toEqual({ previewPauseMs: 3_000 });
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
