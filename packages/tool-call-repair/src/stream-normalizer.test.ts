import { describe, expect, it, vi } from "vitest";
import {
  projectScrubbedPlainTextToolCallMessage,
  type PlainTextToolCallNameMatcher,
} from "./stream-normalizer.js";
import {
  assistantMessage,
  collectNormalizedEvents,
  doneAssistantEvent,
  doneEvent,
  errorEvent,
  eventTypes,
  expectTerminalContent,
  matcher,
  normalize,
  normalizeTextDeltas,
  parseSplitCall,
  resolveTestFenceRanges,
  streamTextDelta,
  textContent,
  textDelta,
  textDeltas,
  textEnd,
  textStart,
  withTerminal,
} from "./stream-normalizer.test-support.js";

const oversized = "x".repeat(256_001);
const overCapXml = `<function=read>${"\u00a0".repeat(128_001)}</function>`;
const lifecycles = Array.from({ length: 129 }, (_, index) => [
  { type: "thinking_start", contentIndex: index + 1 },
  { type: "thinking_end", contentIndex: index + 1, content: "" },
]).flat();

const aggregate = "<function=read></function>\n".repeat(9_500);
const xmlParameter = `<function=read><parameter=path>${oversized}`;
const incomplete = "Hello\n<function=read><parameter=path>SECRET";
const longHarmony = `analysis${" ".repeat(256_001)}`;
const streamDeltas = (...chunks: string[]) => chunks.map((delta) => streamTextDelta(delta));
function cumulativeDeltas(...chunks: string[]) {
  let snapshot = "";
  return chunks.map((delta) => textDelta(delta, (snapshot += delta)));
}

describe("normalizePlainTextToolCallStreamEvents", () => {
  const aggregateTail = cumulativeDeltas(
    aggregate + "<function=read><parameter=path>secret",
    "</parameter></function>\nVisible",
  );
  const falseMarker = cumulativeDeltas(aggregate + "[tool:re", " nope");
  const optionalWhitespace = streamDeltas(
    `[tool:read] {"path":"${oversized}`,
    '"}',
    "\n\n",
    "Visible",
  );
  const incompleteEnd = [streamTextDelta(incomplete), textEnd(incomplete)];
  const prose = "analysis is ordinary prose";
  const proseEnd = [streamTextDelta("analysis"), textEnd(prose)];
  const endTypes = ["text_delta", "text_end"];
  const malformed = "<parameter=x!>Visible answer";
  const invalidParameter = streamDeltas(xmlParameter + "</parameter>", malformed);
  const completed = xmlParameter + "</parameter></function>\nVisible answer";
  const recovered = [streamTextDelta(xmlParameter), textEnd(completed)];
  const heldStart = [
    textStart(0, "", assistantMessage(textContent(""))),
    ...cumulativeDeltas("Visible\n[tool:re", " nope"),
  ];
  const startTypes = ["text_start", "text_delta", "text_delta"];
  it.each<[string, Record<string, unknown>[], string[], string?, string[]?]>([
    ["suppresses an aggregate's active tail", aggregateTail, ["Visible"], "secret"],
    ["replays an aggregate's false marker", falseMarker, ["[tool:re nope"], "<function=read>"],
    ["retains split optional-closer whitespace", optionalWhitespace, ["\nVisible"]],
    ["keeps incomplete calls private", incompleteEnd, ["Hello\n"], "SECRET"],
    ["reconciles false-prefix prose", proseEnd, [prose], undefined, endTypes],
    ["bounds unnamed Harmony prefixes", streamDeltas(longHarmony), [longHarmony]],
    ["preserves malformed parameters", invalidParameter, [malformed]],
    ["recovers an authoritative suffix", recovered, ["Visible answer"], "<function=read>"],
    ["emits a held start", heldStart, ["Visible\n", "[tool:re nope"], undefined, startTypes],
  ])("%s", async (_name, source, visible, hidden, types) => {
    const events = await normalize(source);
    expect(textDeltas(events)).toEqual(visible);
    if (hidden !== undefined) {
      expect(JSON.stringify(events)).not.toContain(hidden);
    }
    if (types !== undefined) {
      expect(eventTypes(events)).toEqual(types);
    }
  });

  it.each([
    ["<", "eof"],
    ["comment", "done"],
  ] as const)("preserves unnamed prefix %s at %s", async (raw, terminal) => {
    const events = await normalize(withTerminal([streamTextDelta(raw)], terminal, raw));
    expect(textDeltas(events)).toEqual([raw]);
    expectTerminalContent(events, terminal, textContent(raw));
  });
  it("preserves prose that invalidates an over-cap XML prefix", async () => {
    const prefix = overCapXml.slice(0, -"</function>".length);
    const visible = "Visible answer";
    const events = await normalize(
      withTerminal(cumulativeDeltas(prefix, visible), "done", prefix + visible),
    );
    expect(textDeltas(events)).toEqual([visible]);
    expect(JSON.stringify(events)).not.toContain("<function=read>");
    expectTerminalContent(events, "done", textContent(visible));
  });

  it("preserves a 400k suffix in a done snapshot after an over-cap call", async () => {
    const visible = `${"a".repeat(150_000)}MIDDLE${"b".repeat(250_000)}`;
    const raw = `${overCapXml}\n${visible}`;
    const events = await normalize(withTerminal([textDelta(raw, raw)], "done", raw));
    expect(textDeltas(events)).toEqual([visible]);
    expect(JSON.stringify(events)).not.toContain("<function=read>");
    expectTerminalContent(events, "done", textContent(visible));
  });

  it("suppresses XML-punctuated parameter names after the byte cap", async () => {
    const prefix = `<function=read><parameter=path>${oversized}</parameter>`;
    const tail = "<parameter=foo.bar>SECRET</parameter></function>";
    const events = await normalize([
      textDelta(prefix, prefix),
      textDelta(tail, `${prefix}${tail}`),
    ]);
    expect(events).toEqual([]);
  });

  it.each([`<parameter=path>${oversized}`, `{"path":"${oversized}"}\n[END_TOOL_REQU`])(
    "scrubs incomplete split named calls",
    async (payload) => {
      const message = assistantMessage(textContent("[read]", payload), "length");
      const events = await normalize([doneEvent("length", message)]);
      expect(events.at(-1)?.message).toMatchObject({ content: [] });
      expect(JSON.stringify(events)).not.toContain("[read]");
    },
  );

  it("merges exact and repaired over-cap ranges", async () => {
    const exact = `<function=read>${"\u00a0".repeat(128_001)}</function>\n`;
    const split = `<parameter=path>${"y".repeat(256_001)}</parameter></function>`;
    const message = assistantMessage(textContent(exact, "[read]", split), "length");
    const events = await normalize([doneEvent("length", message)]);
    expect(events.at(-1)?.message).toMatchObject({ content: [] });
  });

  it.each([
    [
      "<function=read><parameter=path> ",
      "/tmp</parameter><parameter=content>literal </function> tail</parameter></function>",
      { path: " \n/tmp", content: "literal </function> tail" },
    ],
    ["[read]", '  {"path":"/tmp"}[/read]', { path: "/tmp" }],
  ])("repairs a boundary inside leading horizontal whitespace", (first, second, args) => {
    expect(parseSplitCall([first, second])?.[0]).toMatchObject({ name: "read", arguments: args });
  });

  it("does not duplicate an existing parameter line break", () => {
    expect(
      parseSplitCall(["<function=read><parameter=path>", "  \r\n/tmp</parameter></function>"])?.[0]
        ?.arguments,
    ).toEqual({ path: "  \r\n/tmp" });
  });

  it.each([
    ["tool bracket", (payload: string) => `[tool:read] ${payload}`, "<|call|>"],
    ["legacy named bracket", (payload: string) => `[read]\n${payload}`, "[END_TOOL_REQUEST]"],
  ])("keeps split over-cap closing markers private for %s", async (_name, build, marker) => {
    const call = build(`{"path":"${oversized}"}`);
    const visible = "Visible";
    for (let split = 0; split < marker.length; split += 1) {
      const events = await normalizeTextDeltas(
        call + marker.slice(0, split),
        marker.slice(split) + `\n${visible}`,
      );
      expect(textDeltas(events)).toEqual([visible]);
      expect(JSON.stringify(events)).not.toContain(marker);
    }
  });

  it("preserves a follow-on named JSON call invalidated by visible tail text", async () => {
    const visible = '[read]\n{"path":"/tmp"} visible';
    const raw = `${overCapXml}\n${visible}`;
    const events = await normalize([doneAssistantEvent("length", textContent(raw), "length")]);
    expect(events.at(-1)?.message).toMatchObject({ content: textContent(visible) });
  });

  it("uses the compact error projection when no partial is present", async () => {
    const raw = `[tool:read]\n<parameter=path>\n${oversized}`;
    const thinking = { type: "thinking", thinking: "checking" };
    const error = assistantMessage([{ type: "text", text: raw }, thinking]);
    const events = await normalize([
      textDelta(raw, raw),
      {
        type: "thinking_delta",
        contentIndex: 1,
        delta: "checking",
        partial: error,
      },
      errorEvent(error),
    ]);
    expect(eventTypes(events)).toEqual(["thinking_delta", "error"]);
    expect(events[0]).toMatchObject({ contentIndex: 0, partial: { content: [thinking] } });
    expect(events.at(-1)?.error).toMatchObject({ content: [thinking] });
    expect(JSON.stringify(events)).not.toContain("[tool:read]");
  });

  it("drains every auxiliary lifecycle event at the candidate queue cap", async () => {
    const events = await normalize([
      streamTextDelta('[tool:read] {"path":"SECRET"'),
      ...lifecycles,
    ]);
    expect(events[0]?.type).toBe("start");
    expect(events.filter((event) => event.type === "thinking_start")).toHaveLength(129);
    expect(events.filter((event) => event.type === "thinking_end")).toHaveLength(129);
    expect(events.slice(1)).toMatchObject(lifecycles);
    expect(JSON.stringify(events)).not.toContain("SECRET");
  });

  it("drains merged auxiliary deltas at the suppression queue byte cap", async () => {
    const chunk = "x".repeat(128_001);
    const events = await normalize([
      streamTextDelta('[tool:read] {"path":"SECRET' + oversized),
      ...Array.from({ length: 3 }, () => ({
        type: "thinking_delta",
        contentIndex: 1,
        delta: chunk,
      })),
    ]);
    expect(events[0]?.type).toBe("start");
    const deltas = events.filter((event) => event.type === "thinking_delta");
    expect(deltas).toHaveLength(2);
    expect(deltas.map((event) => event.delta)).toEqual([chunk + chunk, chunk]);
    expect(JSON.stringify(events)).not.toContain("SECRET");
  });

  it("preserves fence protection after replaying a false prefix at the auxiliary queue cap", async () => {
    const prefix = "[tool:read] " + " ".repeat(256);
    const invalidation = "nope\n\n```text\n";
    const fencedCall = '[read]\n{"path":"example.txt"}\n[/read]\n';
    const events = await normalize(
      [
        streamTextDelta(prefix),
        streamTextDelta(invalidation),
        ...lifecycles,
        streamTextDelta(fencedCall),
      ],
      { protectFences: true },
    );
    expect(events).toEqual([
      streamTextDelta(prefix + invalidation),
      ...lifecycles,
      streamTextDelta(fencedCall),
    ]);
  });

  it("scans complete under-cap call sequences linearly", () => {
    const callCount = 64;
    let exactNameChecks = 0;
    const countingMatcher: PlainTextToolCallNameMatcher = {
      hasExactName: (name) => {
        exactNameChecks += 1;
        return name === "read";
      },
      hasNamePrefix: (prefix) => "read".startsWith(prefix),
    };
    const text = Array.from({ length: callCount }, () => "<function=read></function>").join("\n");
    expect(
      projectScrubbedPlainTextToolCallMessage({
        matcher: countingMatcher,
        message: assistantMessage(text),
      }),
    ).toBeUndefined();
    expect(exactNameChecks).toBeLessThanOrEqual(callCount * 3);
  });

  it("keeps post-JSON structural whitespace private without accumulating it", async () => {
    const prefix = `[read]\n{"path":"${oversized}`;
    const whitespaceChunks = Array.from({ length: 64 }, () => " ".repeat(4096));
    const tail = "[/read]\nVisible";
    const raw = `${prefix}"}${whitespaceChunks.join("")}${tail}`;
    const events = await normalize([
      streamTextDelta(prefix),
      streamTextDelta('"}'),
      ...whitespaceChunks.map((delta) => streamTextDelta(delta)),
      streamTextDelta(tail),
      doneAssistantEvent("length", textContent(raw), "length"),
    ]);
    expect(textDeltas(events)).toEqual(["Visible"]);
    expectTerminalContent(events, "done", textContent("Visible"));
    expect(JSON.stringify(events)).not.toContain("[read]");
  });

  it("bounds blank-line buffering after a complete call", async () => {
    const call = "<function=read></function>\n";
    const whitespaceChunks = Array.from({ length: 65 }, () => "\n".repeat(4096));
    const events = await normalize([
      streamTextDelta(call),
      ...whitespaceChunks.map((delta) => streamTextDelta(delta)),
      streamTextDelta("Visible"),
    ]);

    const deltas = textDeltas(events);
    expect(deltas.at(-1)).toBe("Visible");
    expect(deltas.slice(0, -1).join("").length).toBeLessThanOrEqual(2 * 4096);
    expect(JSON.stringify(events)).not.toContain("<function=read>");
  });

  it("retains a new block supplied only by its authoritative text end", async () => {
    const events = await normalize([streamTextDelta("[read]"), textEnd("Visible answer", 1)]);
    expect(events).toEqual([
      { type: "text_delta", contentIndex: 0, delta: "[read]" },
      { type: "text_end", contentIndex: 1, content: "Visible answer" },
    ]);
  });

  it("preserves streamed content indexes in terminal error snapshots", async () => {
    const call = `<function=read><parameter=path>${oversized}</parameter></function>`;
    const thinking = { type: "thinking", thinking: "checking" };
    const suffix = { type: "text", text: "Visible suffix." };
    const clean = {
      type: "thinking_start",
      contentIndex: 1,
      partial: assistantMessage([{ type: "text", text: "" }, thinking]),
    };
    const error = assistantMessage([{ type: "text", text: call }, thinking, suffix]);
    const events = await normalize([
      streamTextDelta(call),
      clean,
      streamTextDelta(suffix.text, 2),
      errorEvent(error, error),
    ]);
    expect(events[0]).toEqual(clean);
    expect(textDeltas(events)).toEqual([suffix.text]);
    expectTerminalContent(events, "error", [{ type: "text", text: "" }, thinking, suffix]);
  });

  it("emits each visible segment once across multiple stripped calls and cumulative text_end", async () => {
    const call = `<function=read>${"\u00a0".repeat(128_001)}</function>\n`;
    const first = `${call}ONE\n`;
    const second = "TWO\n<function=read></function>\nONE\n";
    const raw = first + second;
    const events = await normalize([
      { type: "text_delta", delta: first },
      streamTextDelta(second),
      textEnd(raw, 0, assistantMessage(textContent(raw))),
      doneAssistantEvent("length", textContent(raw), "length"),
    ]);
    expect(eventTypes(events)).toEqual(["text_delta", "text_delta", "text_delta", "done"]);
    expect(textDeltas(events)).toEqual(["ONE\n", "TWO\n", "ONE\n"]);
    expectTerminalContent(events, "done", textContent("ONE\nTWO\nONE\n"));
  });

  it.each(["[tool:read]", "analysis to=read code"])(
    "suppresses over-cap whitespace before a split JSON payload for %s",
    async (header) => {
      const prefix = header + " ".repeat(256_001);
      const payload = '{"path":"SECRET"}<|call|>';
      expect(await normalizeTextDeltas(prefix, payload)).toEqual([]);
    },
  );

  it.each([
    ["<function=read><parameter=path>SECRET", "error"],
    ["<function=read><parameter=path>SECRET", "done"],
    ["<function=read><parameter=path>SECRET</parameter></function>", "done"],
  ] as const)("fails closed on a known %s candidate at %s", async (raw, terminal) => {
    const events = await normalize(
      terminal === "error"
        ? [streamTextDelta(raw), errorEvent({ message: "stream failed" })]
        : withTerminal([streamTextDelta(raw)], terminal, raw),
    );
    expect(events.at(-1)?.type).toBe(terminal);
    expect(textDeltas(events)).toEqual([]);
    expect(JSON.stringify(events)).not.toContain("SECRET");
  });

  it("scrubs a cumulative partial before emitting a visible Harmony prefix", async () => {
    const first = "Visible\nanalysis to=read code {}<";
    const events = await normalize([
      textDelta(first, first),
      textDelta("|call|>", first + "|call|>"),
    ]);
    expect(textDeltas(events)).toEqual(["Visible\n"]);
    expect(events[0]?.partial).toMatchObject({ content: textContent("Visible\n") });
    expect(JSON.stringify(events[0])).not.toContain("SECRET");
    expect(JSON.stringify(events)).not.toContain("<|call|>");
  });

  it("keeps block-local text_end checkpoints out of the candidate buffer", async () => {
    const header = "[read]";
    const payload = '{"path":"SECRET"}[/read]';
    const rawMessage = assistantMessage(textContent(header, payload), "stop");
    const promotedMessage = assistantMessage(
      [{ type: "toolCall", id: "call_repaired", name: "read", arguments: { path: "SECRET" } }],
      "toolUse",
    );
    const events = await collectNormalizedEvents(
      [
        textStart(0),
        streamTextDelta(header),
        textEnd(header, 0),
        textStart(1),
        streamTextDelta(payload, 1),
        textEnd(payload, 1),
        doneEvent("stop", rawMessage),
      ],
      {
        matcher,
        createPromotedToolCallEvents: (message) => [
          { type: "toolcall_start", contentIndex: 0, partial: message },
          { type: "toolcall_end", contentIndex: 0, partial: message },
        ],
        normalizeTerminalMessage: () => ({
          kind: "promoted",
          message: promotedMessage,
          sourceToProjectedContentIndex: new Map(),
        }),
      },
    );
    expect(eventTypes(events)).toEqual(["start", "toolcall_start", "toolcall_end", "done"]);
    expect(events.at(-1)).toMatchObject({ reason: "toolUse", message: promotedMessage });
    expect(JSON.stringify(events)).not.toContain("[/read]");
  });

  it("does not allocate a synthetic partial from a hostile content index", async () => {
    const raw = `<function=read><parameter=path>${oversized}</parameter></function>`;
    const events = await normalize([
      { ...textDelta(raw, raw), contentIndex: Number.MAX_SAFE_INTEGER },
    ]);
    expect(events).toEqual([]);
  });
});

const literalCall = '[read]\n{"path":"x"}\n[/read]\n';
const emptyCall = "[read]\n{}\n[/read]\n";
const backticks = "```\n";
const tildes = "~~~\n";
const fencedExample = backticks + literalCall + backticks;
function partialDelta(delta: string, index: number, ...blocks: string[]) {
  return streamTextDelta(delta, index, assistantMessage(textContent(...blocks)));
}
function protectedDeltas(
  events: readonly unknown[],
  resolveProtectedRanges = resolveTestFenceRanges,
) {
  return collectNormalizedEvents(events, {
    matcher,
    createPromotedToolCallEvents: () => [],
    normalizeTerminalMessage: () => undefined,
    protectedRangesFenceCompatible: true,
    resolveProtectedRanges,
  });
}
function streamedText(events: readonly Record<string, unknown>[]) {
  return events
    .map((event) =>
      typeof event.delta === "string"
        ? event.delta
        : typeof event.content === "string"
          ? event.content
          : "",
    )
    .join("");
}
function expectLiteral(events: Record<string, unknown>[], text: string, content: unknown) {
  expect(textDeltas(events).join("")).toBe(text);
  expect(events.at(-1)).toMatchObject({ type: "done", message: { content, stopReason: "stop" } });
  expect(events.some((event) => String(event.type).startsWith("toolcall_"))).toBe(false);
}

describe("normalizePlainTextToolCallStreamEvents protected ranges", () => {
  it("uses unstreamed preceding blocks from cumulative partials (#122513)", async () => {
    const first = "```json\n";
    // The final newline prevents the unfinished-line fallback from masking the bug.
    const candidate = literalCall + backticks;
    const content = textContent(first, candidate);
    const events = await normalize(
      [
        partialDelta(candidate, 1, first, candidate),
        textEnd(candidate, 1, assistantMessage(content)),
        doneAssistantEvent("stop", content, "stop"),
      ],
      { protectFences: true },
    );
    expectLiteral(events, candidate, content);
  });

  const reversedBlocks = [
    partialDelta(backticks, 1, "", backticks),
    partialDelta(literalCall, 0, literalCall, backticks),
  ];
  const differentFences = [
    partialDelta(backticks, 1, "", backticks),
    partialDelta(tildes, 0, tildes, backticks),
    partialDelta(fencedExample, 2, tildes, backticks, fencedExample),
  ];
  const missingPartial = [
    streamTextDelta(backticks, 1),
    streamTextDelta(emptyCall),
    partialDelta(fencedExample, 0, tildes + emptyCall + fencedExample, backticks),
  ];
  const growingPrefix = [
    streamTextDelta(tildes),
    partialDelta(emptyCall, 1, tildes, emptyCall),
    partialDelta(literalCall, 1, tildes + tildes, emptyCall + literalCall),
  ];
  it.each([
    ["earlier block arriving after a later fence", reversedBlocks, false],
    ["same-length prefixes with different fence identities", differentFences, true],
    ["a missing partial before a contradictory partial", missingPartial, true],
    ["an earlier block growing after a cached verdict", growingPrefix, false],
  ] as const)("checks preceding context for %s (#122513)", async (_name, source, visible) => {
    const text = streamedText(await protectedDeltas(source));
    expect(text.includes('{"path":"x"}')).toBe(visible);
  });
  it("preserves candidates after bounded protection history overflows", async () => {
    const opening = "```text\n" + "x".repeat(1_000_000);
    const candidate = literalCall.trimEnd();
    const events = await normalize([streamTextDelta(opening), streamTextDelta(candidate)], {
      protectFences: true,
    });
    expect(textDeltas(events).join("")).toBe(opening + candidate);
  });

  it("materializes Markdown when inline spans block the fast path", async () => {
    const lengths: number[] = [];
    const chunks = Array.from({ length: 1_000 }, () => "ordinary `code` prose\n");
    const candidate = literalCall.trimEnd();
    const events = await protectedDeltas(
      [...chunks.map((delta) => streamTextDelta(delta)), streamTextDelta(candidate)],
      (text) => {
        lengths.push(text.length);
        return [];
      },
    );
    expect(lengths[0]).toBe(chunks.join("").length + candidate.length);
    expect(lengths.length).toBeLessThanOrEqual(3);
    expect(textDeltas(events).join("")).toBe(chunks.join(""));
  });

  it.each([
    ["an open fence", "```toml\n[read.section]\n"],
    ["an unfinished text line", "hello"],
  ])("resets %s between completions", async (_name, first) => {
    const events = await normalize(
      [
        streamTextDelta(first),
        doneAssistantEvent("stop", textContent(first), "stop"),
        streamTextDelta(literalCall),
        doneAssistantEvent("stop", textContent(literalCall), "stop"),
      ],
      { protectFences: true },
    );
    expect(textDeltas(events)).toEqual([first]);
  });

  it("bounds prefix checks and parsing across later candidates (#122513)", async () => {
    const prefix = "x".repeat(199_998);
    const preceding = prefix + "x\n";
    const fenced = [
      "```toml",
      ...Array.from({ length: 300 }, (_, i) => `[read.section.${i}]\nname = "svc"`),
      "```",
      "",
    ].join("\n");
    let accumulated = "";
    const source = [
      partialDelta(prefix, 0, prefix, ""),
      partialDelta("x\n", 0, preceding, ""),
      ...fenced
        .split(/(?<=\[)/)
        .map((delta) => partialDelta(delta, 1, preceding, (accumulated += delta))),
    ];
    let calls = 0;
    let slices = 0;
    // oxlint-disable-next-line typescript/unbound-method -- invoked with the original string receiver.
    const originalSlice = String.prototype.slice;
    const spy = vi.spyOn(String.prototype, "slice").mockImplementation(function (
      this: string,
      start,
      end,
    ) {
      if (start === 0 && end === preceding.length && this.length >= end) {
        slices += 1;
      }
      return originalSlice.call(this, start, end);
    });
    let events: Record<string, unknown>[];
    try {
      events = await protectedDeltas(source, (text) => {
        calls += 1;
        return resolveTestFenceRanges(text);
      });
    } finally {
      spy.mockRestore();
    }
    expect(calls).toBeLessThanOrEqual(3);
    expect(slices).toBeLessThanOrEqual(4);
    expect(textDeltas(events).join("")).toBe(preceding + fenced);
  });

  it("honors custom unfenced ranges without a fast-path opt-in", async () => {
    const resolveMarkedRanges = (text: string) => {
      const start = text.indexOf("<<PROTECT>>");
      const close = text.indexOf("<<END>>", start + "<<PROTECT>>".length);
      return start === -1
        ? []
        : [{ start, end: close === -1 ? text.length : close + "<<END>>".length }];
    };
    const text = `<<PROTECT>>\n${literalCall}<<END>>\n`;
    const events = await collectNormalizedEvents(
      [streamTextDelta(text), doneAssistantEvent("stop", textContent(text), "stop")],
      {
        matcher,
        createPromotedToolCallEvents: () => [],
        resolveProtectedRanges: resolveMarkedRanges,
        normalizeTerminalMessage: ({ message }) => {
          const scrubbed = projectScrubbedPlainTextToolCallMessage({
            matcher,
            message,
            resolveProtectedRanges: resolveMarkedRanges,
          });
          return scrubbed ? { kind: "scrubbed", ...scrubbed } : undefined;
        },
      },
    );
    expectLiteral(events, text, textContent(text));
  });
});
