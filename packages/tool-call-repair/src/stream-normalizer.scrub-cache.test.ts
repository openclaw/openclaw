import { expect, it } from "vitest";
import { findMarkdownCodeRegions } from "../../markdown-core/src/reasoning-tags.js";
import {
  assistantMessage,
  doneEvent,
  errorEvent,
  expectTerminalContent,
  normalize as normalizeEvents,
  streamTextDelta,
  textContent,
  textDelta,
} from "./stream-normalizer.test-support.js";

const leading = '[tool:read]\n{"path":"a"}\n';
function normalizeChunks(terminal: "done" | "error", ...chunks: string[]) {
  let snapshot = "";
  const deltas = chunks.map((chunk) => textDelta(chunk, (snapshot += chunk)));
  const message = assistantMessage(textContent(snapshot));
  return normalize([
    ...deltas,
    terminal === "done" ? doneEvent("length", message) : errorEvent(message, message),
  ]);
}
function normalize(events: Record<string, unknown>[], protectCode = true) {
  return normalizeEvents(events, {
    resolveProtectedRanges: protectCode ? findMarkdownCodeRegions : undefined,
    protectedRangesFenceCompatible: true,
  });
}

it("rechecks an empty trailing text block as a structural call boundary", async () => {
  const first = "[tool:read]\n{}\nVisible.";
  const suffix = "analysis to=read code ";
  const snapshot = (text: string) =>
    assistantMessage([...textContent(first, text), { type: "thinking", thinking: "" }]);
  const message = snapshot(suffix);
  const events = await normalize(
    [
      streamTextDelta(first, 0, snapshot("")),
      { type: "thinking_delta", contentIndex: 2, delta: "thinking", partial: message },
      errorEvent(message, message),
    ],
    false,
  );
  expect(JSON.stringify(events)).not.toContain("analysis to=read");
  expect(events.at(-1)?.partial).toMatchObject({
    content: [...textContent("Visible.", ""), { type: "thinking", thinking: "" }],
  });
});

it.each(["error", "done"] as const)("scrubs new Harmony prefixes at %s", async (terminal) => {
  const events = await normalizeChunks(
    terminal,
    leading + "Visible.\n",
    "a",
    "nalysis to=read code ",
  );
  expect(JSON.stringify(events)).not.toContain("[tool:read]");
  expect(JSON.stringify(events)).not.toContain("analysis to=read");
  expectTerminalContent(events, terminal, textContent("Visible.\n"));
});

it.each(["error", "done"] as const)("rechecks image code ownership at %s", async (terminal) => {
  const image = 'Visible.\n\n![example `x\n[tool:read]\n{"path":"b"}\nx`][id]\n\nAfter\n\n[id]';
  const events = await normalizeChunks(terminal, leading + image, ": /url");
  const resolved = events.filter((event) => JSON.stringify(event).includes("[id]: /url"));
  expect(resolved.length).toBeGreaterThan(0);
  for (const event of resolved) {
    expect(JSON.stringify(event)).not.toContain("[tool:read]");
  }
  expectTerminalContent(
    events,
    terminal,
    textContent("Visible.\n\n![example `x\nx`][id]\n\nAfter\n\n[id]: /url"),
  );
});
