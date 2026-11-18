import { expect, it } from "vitest";
import {
  createSubscribedSessionHarness,
  emitAssistantTextDelta,
} from "./embedded-agent-subscribe.e2e-harness.js";
import { createOpenAiResponsesTextEvent } from "./embedded-agent-subscribe.openai-responses.test-helpers.js";
import type { SubscribeEmbeddedAgentSessionParams } from "./embedded-agent-subscribe.types.js";

type PartialReply = Parameters<
  NonNullable<SubscribeEmbeddedAgentSessionParams["onPartialReply"]>
>[0];

function previewHarness(builtinToolNames: string[] = []) {
  const previews: PartialReply[] = [];
  const raw: string[] = [];
  const h = createSubscribedSessionHarness({
    runId: "preview-barrier",
    builtinToolNames: new Set(builtinToolNames),
    onPartialReply: (payload) => {
      previews.push({ ...payload });
    },
    onAgentEvent: (event) => {
      if (event.stream === "assistant" && typeof event.data.text === "string") {
        raw.push(event.data.text);
      }
    },
  });
  h.emit({ type: "message_start", message: { role: "assistant" } });
  let source = "";
  async function update(type: "text_delta" | "text_end", text: string, delta?: string) {
    source = text;
    h.emit(
      createOpenAiResponsesTextEvent({
        type,
        text,
        delta,
        id: "answer",
        signaturePhase: "final_answer",
      }),
    );
    await h.subscription.waitForPendingEvents();
  }
  return {
    ...h,
    previews,
    raw,
    append: (delta: string) => update("text_delta", source + delta, delta),
    replace: (text: string) => update("text_end", text),
    [Symbol.dispose]: () => h.subscription.unsubscribe(),
  };
}

function schedules(source: string) {
  return [
    ...Array.from({ length: source.length - 1 }, (_, at) => [
      source.slice(0, at + 1),
      source.slice(at + 1),
    ]),
    ...[1, 4].map((size) =>
      Array.from({ length: Math.ceil(source.length / size) }, (_, at) =>
        source.slice(at * size, (at + 1) * size),
      ),
    ),
  ];
}

it.each([
  ["unregistered bracket", '[tool:missing]\n{"content":"SYNTHETIC_ARGUMENT"}\n', []],
  ["registered bracket", '[tool:read]\n{"path":"SYNTHETIC_ARGUMENT"}\n', ["read"]],
  ["named bracket", '[read]\n{"path":"SYNTHETIC_ARGUMENT"}\n[/read]\n', ["read"]],
  ["Harmony", 'commentary to=read code {"path":"SYNTHETIC_ARGUMENT"}\n', ["read"]],
  ["adjacent calls", '[tool:read]{}[tool:missing]{"path":"SYNTHETIC_ARGUMENT"}\n', ["read"]],
] as const)("never previews pending %s at any split", async (_name, call, names) => {
  const source = `Before\n${call}After.`;
  for (const chunks of schedules(source)) {
    using h = previewHarness([...names]);
    let consumed = 0;
    for (const delta of chunks) {
      const previousCount = h.previews.length;
      await h.append(delta);
      consumed += delta.length;
      for (const preview of h.previews.slice(previousCount)) {
        expect(
          "Before\nAfter.".startsWith(preview.text ?? ""),
          JSON.stringify({ chunks, preview }),
        ).toBe(true);
        expect(preview.delta ?? "").not.toContain("SYNTHETIC_ARGUMENT");
      }
      const expected =
        consumed <= 7
          ? source.slice(0, consumed)
          : `Before\n${source.slice(7 + call.length, consumed)}`;
      expect(h.previews.at(-1)?.text ?? "").toBe(expected.trimEnd());
    }
    expect(h.previews.at(-1)?.text).toBe("Before\nAfter.");
  }
});

it("holds unphased channel previews without withholding raw events", async () => {
  using h = previewHarness();
  for (const delta of ["Live prose\n[too", 'l:missing]\n{"path":"SYNTHETIC_ARGUMENT']) {
    emitAssistantTextDelta({ emit: h.emit, delta });
    await h.subscription.waitForPendingEvents();
    expect(h.previews.at(-1)?.text).toBe("Live prose");
  }
  expect(h.raw.at(-1)).toContain("SYNTHETIC_ARGUMENT");
});

it.each([
  "Ordinary prose continues without waiting for a newline.",
  '{"ordinary":true,"values":[1,2,3]}',
  'Example:\n```text\n[tool:read] {"path":"literal"}\n```\nVisible tail.',
])("streams every safe prefix of %j", async (source) => {
  for (const chunks of schedules(source)) {
    using h = previewHarness();
    for (const delta of chunks) {
      await h.append(delta);
      // The upstream stream can itself hold directive prefixes; previews add no delay here.
      expect(h.previews.at(-1)?.text ?? "").toBe(h.raw.at(-1) ?? "");
    }
    expect(h.previews.at(-1)?.text).toBe(source);
  }
});

it("streams prose and stable literals while holding only a candidate tail", async () => {
  using h = previewHarness();
  await h.append("Ordinary prose");
  expect(h.previews.at(-1)?.text).toBe("Ordinary prose");
  await h.append("\n[too");
  expect(h.previews.at(-1)?.text).toBe("Ordinary prose");
  expect(h.raw.at(-1)).toContain("[too");
  await h.append('l:missing]\n{"content":"SYNTHETIC_ARGUMENT');
  expect(h.previews.at(-1)?.text).toBe("Ordinary prose");
  await h.append('"}\nMore prose');
  expect(h.previews.at(-1)?.text).toBe("Ordinary prose\nMore prose");
  await h.replace(
    'Replacement prose\n[guide](https://example.test)\n{"ordinary":true}\n```text\n[tool:read] {"path":"literal"}\n```',
  );
  expect(h.previews.at(-1)?.text).toBe(
    'Replacement prose\n[guide](https://example.test)\n{"ordinary":true}\n```text\n[tool:read] {"path":"literal"}\n```',
  );
});

it("keeps mutable inline candidates private until Markdown settles", async () => {
  using h = previewHarness();
  await h.append("![example `x\n[tool:read] {}\nx` label");
  expect(h.previews.every((preview) => !preview.text?.includes("[tool:read]"))).toBe(true);
  await h.append("](/url)\n");
  expect(h.previews.at(-1)?.text).not.toContain("[tool:read]");
});
