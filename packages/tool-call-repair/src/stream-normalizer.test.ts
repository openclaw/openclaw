import { describe, expect, it, vi } from "vitest";
import {
  normalizePlainTextToolCallStreamEvents as normalizeStream,
  projectScrubbedPlainTextToolCallMessage as scrubMessage,
} from "./stream-normalizer.js";
import {
  assistantMessage as assistant,
  collectNormalizedEvents as collect,
  doneAssistantEvent as done,
  doneEvent,
  errorEvent,
  eventTypes,
  expectTerminalContent as expectTerminal,
  matcher,
  normalize,
  normalizeTextDeltas,
  parseSplitCall,
  resolveTestFenceRanges,
  streamTextDelta as textEvent,
  textContent,
  textDelta,
  textDeltas,
  textEnd,
  textStart,
  withTerminal,
  type Terminal,
} from "./stream-normalizer.test-support.js";

type Events = Record<string, unknown>[];
const finish = (reason: string, ...texts: string[]) => done(reason, textContent(...texts), reason);
const leading = '[tool:read]\n{"path":"a"}\n';
const streamOptions = {
  matcher,
  createPromotedToolCallEvents: () => [],
  normalizeTerminalMessage: () => undefined,
};
const normalizeProtected = (source: readonly unknown[]) =>
  normalize(source, { protectFences: true });
const oversized = "x".repeat(256_001);
const overCapXml = `<function=read>${"\u00a0".repeat(128_001)}</function>`;
const lifecycles = Array.from({ length: 129 }, (_, index) => [
  { type: "thinking_start", contentIndex: index + 1 },
  { type: "thinking_end", contentIndex: index + 1, content: "" },
]).flat();

const aggregate = "<function=read></function>\n".repeat(9_500);
const xmlParameter = `<function=read><parameter=path>${oversized}`;
const parameterCall = `${xmlParameter}</parameter></function>`;
const longHarmony = `analysis${" ".repeat(256_001)}`;
const streamDeltas = (...chunks: string[]) => chunks.map((delta) => textEvent(delta));
const thinking = { type: "thinking", thinking: "checking" };
const queuedReasoning = { type: "thinking_delta", contentIndex: 0, delta: "checking" };
function expectHidden(events: Readonly<Events>, marker = "<function=read>") {
  expect(JSON.stringify(events)).not.toContain(marker);
}
function expectVisible(
  events: Readonly<Events>,
  visible: string[],
  marker?: string,
  terminal?: Terminal,
) {
  expect(textDeltas(events)).toEqual(visible);
  if (marker !== undefined) {
    expectHidden(events, marker);
  }
  if (terminal !== undefined) {
    expectTerminal(events, terminal, textContent(visible.join("")));
  }
}
function fencedSections(count: number) {
  const sections = Array.from({ length: count }, (_, i) => `[read.section.${i}]\nname = "svc"`);
  return `\`\`\`toml\n${sections.join("\n")}\n\`\`\`\n`;
}
function cumulativeDeltas(...chunks: string[]) {
  let snapshot = "";
  return chunks.map((delta) => textDelta(delta, (snapshot += delta)));
}

describe("normalizePlainTextToolCallStreamEvents", () => {
  const falseMarker = cumulativeDeltas(aggregate + "[tool:re", " nope");
  const optionalWhitespace = streamDeltas(
    `[tool:read] {"path":"${oversized}`,
    '"}',
    "\n\n",
    "Visible",
  );
  const prose = "analysis is ordinary prose";
  const proseEnd = [textEvent("analysis"), textEnd(prose)];
  const endTypes = ["text_delta", "text_end"];
  const malformed = "<parameter=x!>Visible answer";
  const invalidParameter = streamDeltas(xmlParameter + "</parameter>", malformed);
  const completed = xmlParameter + "</parameter></function>\nVisible answer";
  const recovered = [textEvent(xmlParameter), textEnd(completed)];
  const heldStart = [
    textStart(0, "", assistant(textContent(""))),
    ...cumulativeDeltas("Visible\n[tool:re", " nope"),
  ];
  const startTypes = ["text_start", "text_delta", "text_delta"];
  it.each<[string, Record<string, unknown>[], string[], string?, string[]?]>([
    ["replays an aggregate's false marker", falseMarker, ["[tool:re nope"], "<function=read>"],
    ["retains split optional-closer whitespace", optionalWhitespace, ["\nVisible"]],
    ["reconciles false-prefix prose", proseEnd, [prose], undefined, endTypes],
    ["bounds unnamed Harmony prefixes", streamDeltas(longHarmony), [longHarmony]],
    ["preserves malformed parameters", invalidParameter, [malformed]],
    ["recovers an authoritative suffix", recovered, ["Visible answer"], "<function=read>"],
    ["emits a held start", heldStart, ["Visible\n", "[tool:re nope"], undefined, startTypes],
  ])("%s", async (_name, source, visible, hidden, types) => {
    const events = await normalize(source);
    expectVisible(events, visible, hidden);
    if (types !== undefined) {
      expect(eventTypes(events)).toEqual(types);
    }
  });

  it.each([
    ["<", "eof"],
    ["comment", "done"],
  ] as const)("preserves unnamed prefix %s at %s", async (raw, terminal) => {
    const events = await normalize(withTerminal([textEvent(raw)], terminal, raw));
    expectVisible(events, [raw], undefined, terminal);
  });

  it.each<[string, string[], string[], string]>([
    ["false prefix", [" [read]\n", "<function=read>"], [" [read]\n"], "<function=read>"],
    [
      "stacked function",
      ['[tool:read]\n{"path":"a"}<funct', "ion=read></function>"],
      [],
      "<function=read>",
    ],
    [
      "stacked Harmony",
      ['[tool:read]\n{"path":"a"} <|channel|>', "commentary to=read code<|message|>  "],
      [],
      "<|channel|>",
    ],
  ])("keeps split call markers private after %s", async (_name, chunks, visible, hidden) => {
    const events = await normalizeTextDeltas(...chunks);
    expectVisible(events, visible, hidden);
    const unsplit = await normalizeTextDeltas(chunks.join(""));
    expect(textDeltas(unsplit)).toEqual(visible);
  });

  it.each([
    ["<function=read>", "</function>"],
    ["<|channel|>commentary", ' to=read code<|message|>{"path":"a"}'],
  ])("keeps every opening-marker split private for %s", async (marker, tail) => {
    const firstCall = '[tool:read]\n{"path":"a"}';
    for (let split = 1; split < marker.length; split += 1) {
      const events = await normalizeTextDeltas(
        firstCall + marker.slice(0, split),
        marker.slice(split) + tail,
      );
      expect(textDeltas(events)).toEqual([]);
    }
  });

  it.each([
    ["false prefix", "X\n  ", "X\n  "],
    ["split function marker", "<function=read>", ""],
    ["split function call", "<function=read></function>", ""],
  ])("reconciles %s completed by cumulative text_end", async (_name, suffix, remaining) => {
    const delta = "hello\n[read]\n{}";
    const full = `${delta}\n${suffix}`;
    const visible = `${delta}\n${remaining}`;
    const split = await normalize([textEvent(delta), textEnd(full)]);
    const unsplit = await normalize([textEvent(full), textEnd(full)]);
    expect(textDeltas(split).join("")).toBe(visible);
    expect(textDeltas(unsplit).join("")).toBe(visible);
    expect(eventTypes(split).includes("text_end")).toBe(eventTypes(unsplit).includes("text_end"));
    expectHidden(split);
  });
  it("preserves prose that invalidates an over-cap XML prefix", async () => {
    const prefix = overCapXml.slice(0, -"</function>".length);
    const visible = "Visible answer";
    const events = await normalize(
      withTerminal(cumulativeDeltas(prefix, visible), "done", prefix + visible),
    );
    expectVisible(events, [visible], "<function=read>", "done");
  });

  it.each<[string, string[]]>([
    ["incomplete split named calls", ["[read]", `{"path":"${oversized}"}\n[END_TOOL_REQU`]],
    [
      "exact and repaired over-cap ranges",
      [
        `${overCapXml}\n`,
        "[read]",
        `<parameter=path>${"y".repeat(256_001)}</parameter></function>`,
      ],
    ],
  ])("scrubs %s", async (_name, blocks) => {
    const events = await normalize([finish("length", ...blocks)]);
    expect(events.at(-1)?.message).toMatchObject({ content: [] });
    expectHidden(events, "[read]");
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
      expectVisible(events, [visible], marker);
    }
  });

  it("preserves a follow-on named JSON call invalidated by visible tail text", async () => {
    const visible = '[read]\n{"path":"/tmp"} visible';
    const raw = `${overCapXml}\n${visible}`;
    const events = await normalize([finish("length", raw)]);
    expect(events.at(-1)?.message).toMatchObject({ content: textContent(visible) });
  });

  it("uses the compact error projection when no partial is present", async () => {
    const raw = `[tool:read]\n<parameter=path>\n${oversized}`;
    const error = assistant([{ type: "text", text: raw }, thinking]);
    const events = await normalize([
      textDelta(raw, raw),
      { ...queuedReasoning, contentIndex: 1, partial: error },
      errorEvent(error),
    ]);
    expect(events).toMatchObject([
      { type: "thinking_delta", contentIndex: 0, partial: { content: [thinking] } },
      { type: "error", error: { content: [thinking] } },
    ]);
    expect(JSON.stringify(events)).not.toContain("[tool:read]");
  });

  it("drains every auxiliary lifecycle event at the candidate queue cap", async () => {
    const events = await normalize([textEvent('[tool:read] {"path":"SECRET"'), ...lifecycles]);
    expect(events).toMatchObject([{ type: "start" }, ...lifecycles]);
    expect(JSON.stringify(events)).not.toContain("SECRET");
  });

  it("drains merged auxiliary deltas at the suppression queue byte cap", async () => {
    const chunk = "x".repeat(128_001);
    const events = await normalize([
      textEvent('[tool:read] {"path":"SECRET' + oversized),
      ...Array.from({ length: 3 }, () => ({ ...queuedReasoning, contentIndex: 1, delta: chunk })),
    ]);
    expect(events[0]?.type).toBe("start");
    const deltas = events.filter((event) => event.type === "thinking_delta");
    expect(deltas.map((event) => event.delta)).toEqual([chunk + chunk, chunk]);
    expect(JSON.stringify(events)).not.toContain("SECRET");
  });

  it("preserves fence protection after replaying a false prefix at the auxiliary queue cap", async () => {
    const prefix = "[tool:read] " + " ".repeat(256);
    const invalidation = "nope\n\n```text\n";
    const fencedCall = '[read]\n{"path":"example.txt"}\n[/read]\n';
    const events = await normalizeProtected([
      ...streamDeltas(prefix, invalidation),
      ...lifecycles,
      textEvent(fencedCall),
    ]);
    expect(events).toEqual([
      textEvent(prefix + invalidation),
      ...lifecycles,
      textEvent(fencedCall),
    ]);
  });

  it("scans complete under-cap call sequences linearly", () => {
    const callCount = 64;
    const hasExactName = vi.fn((name: string) => matcher.hasExactName(name));
    const text = Array.from({ length: callCount }, () => "<function=read></function>").join("\n");
    expect(
      scrubMessage({
        matcher: { ...matcher, hasExactName },
        message: assistant(text),
      }),
    ).toBeUndefined();
    expect(hasExactName.mock.calls.length).toBeLessThanOrEqual(callCount * 3);
  });

  it("keeps post-JSON structural whitespace private without accumulating it", async () => {
    const prefix = `[read]\n{"path":"${oversized}`;
    const whitespaceChunks = Array.from({ length: 64 }, () => " ".repeat(4096));
    const tail = "[/read]\nVisible";
    const raw = `${prefix}"}${whitespaceChunks.join("")}${tail}`;
    const events = await normalize([
      textEvent(prefix),
      textEvent('"}'),
      ...whitespaceChunks.map((delta) => textEvent(delta)),
      textEvent(tail),
      finish("length", raw),
    ]);
    expectVisible(events, ["Visible"], "[read]", "done");
  });

  it("bounds blank-line buffering after a complete call", async () => {
    const call = "<function=read></function>\n";
    const whitespaceChunks = Array.from({ length: 65 }, () => "\n".repeat(4096));
    const events = await normalize([
      textEvent(call),
      ...whitespaceChunks.map((delta) => textEvent(delta)),
      textEvent("Visible"),
    ]);

    const deltas = textDeltas(events);
    expect(deltas.at(-1)).toBe("Visible");
    expect(deltas.slice(0, -1).join("").length).toBeLessThanOrEqual(2 * 4096);
    expect(JSON.stringify(events)).not.toContain("<function=read>");
  });

  it("retains a new block supplied only by its authoritative text end", async () => {
    const events = await normalize([textEvent("[read]"), textEnd("Visible answer", 1)]);
    expect(events).toEqual([
      { type: "text_delta", contentIndex: 0, delta: "[read]" },
      { type: "text_end", contentIndex: 1, content: "Visible answer" },
    ]);
  });

  it("preserves streamed content indexes in terminal error snapshots", async () => {
    const call = parameterCall;
    const suffix = { type: "text", text: "Visible suffix." };
    const clean = {
      type: "thinking_start",
      contentIndex: 1,
      partial: assistant([{ type: "text", text: "" }, thinking]),
    };
    const error = assistant([{ type: "text", text: call }, thinking, suffix]);
    const events = await normalize([
      textEvent(call),
      clean,
      textEvent(suffix.text, 2),
      errorEvent(error, error),
    ]);
    expect(events[0]).toEqual(clean);
    expect(textDeltas(events)).toEqual([suffix.text]);
    expectTerminal(events, "error", [{ type: "text", text: "" }, thinking, suffix]);
  });

  it("emits each visible segment once across multiple stripped calls and cumulative text_end", async () => {
    const call = `${overCapXml}\n`;
    const first = `${call}ONE\n`;
    const second = "TWO\n<function=read></function>\nONE\n";
    const raw = first + second;
    const events = await normalize([
      { type: "text_delta", delta: first },
      textEvent(second),
      textEnd(raw, 0, assistant(textContent(raw))),
      finish("length", raw),
    ]);
    expect(eventTypes(events)).toEqual(["text_delta", "text_delta", "text_delta", "done"]);
    expectVisible(events, ["ONE\n", "TWO\n", "ONE\n"], undefined, "done");
  });

  it.each([
    [
      "XML-punctuated parameter",
      cumulativeDeltas(
        `${xmlParameter}</parameter>`,
        "<parameter=foo.bar>SECRET</parameter></function>",
      ),
    ],
    [
      "bracket whitespace",
      streamDeltas("[tool:read]" + " ".repeat(256_001), '{"path":"SECRET"}<|call|>'),
    ],
    [
      "Harmony whitespace",
      streamDeltas("analysis to=read code" + " ".repeat(256_001), '{"path":"SECRET"}<|call|>'),
    ],
    [
      "hostile content index",
      [
        {
          ...textDelta(parameterCall, parameterCall),
          contentIndex: Number.MAX_SAFE_INTEGER,
        },
      ],
    ],
  ] as const)("suppresses %s", async (_name, source) => {
    expect(await normalize(source)).toEqual([]);
  });

  it.each([
    ["<function=read><parameter=path>SECRET", "error"],
    ["<function=read><parameter=path>SECRET", "done"],
  ] as const)("fails closed on a known %s candidate at %s", async (raw, terminal) => {
    const events = await normalize(
      terminal === "error"
        ? [textEvent(raw), errorEvent({ message: "stream failed" })]
        : withTerminal([textEvent(raw)], terminal, raw),
    );
    expect(events.at(-1)?.type).toBe(terminal);
    expect(textDeltas(events)).toEqual([]);
    expect(JSON.stringify(events)).not.toContain("SECRET");
  });

  it("keeps block-local text_end checkpoints out of the candidate buffer", async () => {
    const header = "[read]";
    const payload = '{"path":"SECRET"}[/read]';
    const rawMessage = assistant(textContent(header, payload), "stop");
    const promotedMessage = assistant(
      [{ type: "toolCall", id: "call_repaired", name: "read", arguments: { path: "SECRET" } }],
      "toolUse",
    );
    const events = await collect(
      [
        textStart(0),
        textEvent(header),
        textEnd(header, 0),
        textStart(1),
        textEvent(payload, 1),
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
});

const literalCall = '[read]\n{"path":"x"}\n[/read]\n';
const emptyCall = "[read]\n{}\n[/read]\n";
const backticks = "```\n";
const tildes = "~~~\n";
const fencedExample = backticks + literalCall + backticks;
function partialDelta(delta: string, index: number, ...blocks: string[]) {
  return textEvent(delta, index, assistant(textContent(...blocks)));
}
function protectedDeltas(
  events: readonly unknown[],
  resolveProtectedRanges = resolveTestFenceRanges,
) {
  return collect(events, {
    ...streamOptions,
    protectedRangesFenceCompatible: true,
    resolveProtectedRanges,
  });
}
function streamedText(events: Readonly<Events>) {
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
function expectLiteral(events: Events, text: string, content: unknown) {
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
    const events = await normalizeProtected([
      partialDelta(candidate, 1, first, candidate),
      textEnd(candidate, 1, assistant(content)),
      done("stop", content, "stop"),
    ]);
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
    textEvent(backticks, 1),
    textEvent(emptyCall),
    partialDelta(fencedExample, 0, tildes + emptyCall + fencedExample, backticks),
  ];
  const growingPrefix = [
    textEvent(tildes),
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
    const events = await normalizeProtected(streamDeltas(opening, candidate));
    expect(textDeltas(events).join("")).toBe(opening + candidate);
  });

  it("resets open fences between completions", async () => {
    const first = "```toml\n[read.section]\n";
    const events = await normalizeProtected([
      textEvent(first),
      finish("stop", first),
      textEvent(literalCall),
      finish("stop", literalCall),
    ]);
    expect(textDeltas(events)).toEqual([first]);
  });

  it("bounds prefix checks and parsing across later candidates (#122513)", async () => {
    const prefix = "x".repeat(199_998);
    const preceding = prefix + "x\n";
    const fenced = fencedSections(300);
    let accumulated = "";
    const source = [
      partialDelta(prefix, 0, prefix, ""),
      partialDelta("x\n", 0, preceding, ""),
      ...fenced
        .split(/(?<=\[)/)
        .map((delta) => partialDelta(delta, 1, preceding, (accumulated += delta))),
    ];
    const resolveRanges = vi.fn(resolveTestFenceRanges);
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
    let events: Events;
    try {
      events = await protectedDeltas(source, resolveRanges);
    } finally {
      spy.mockRestore();
    }
    expect(resolveRanges.mock.calls.length).toBeLessThanOrEqual(3);
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
    const events = await collect([textEvent(text), finish("stop", text)], {
      ...streamOptions,
      resolveProtectedRanges: resolveMarkedRanges,
      normalizeTerminalMessage: ({ message }) => {
        const scrubbed = scrubMessage({
          matcher,
          message,
          resolveProtectedRanges: resolveMarkedRanges,
        });
        return scrubbed ? { kind: "scrubbed", ...scrubbed } : undefined;
      },
    });
    expectLiteral(events, text, textContent(text));
  });
});

describe("normalizePlainTextToolCallStreamEvents scrub reuse", () => {
  const scrub = (raw: string) =>
    scrubMessage({
      forceKnownCandidates: true,
      matcher,
      message: assistant(textContent(raw)),
      preserveEmptyTextBlocks: true,
      resolveProtectedRanges: resolveTestFenceRanges,
    })?.message;
  const chunked = (text: string, size: number) => {
    const chunks = Array.from({ length: Math.ceil(text.length / size) }, (_, i) =>
      text.slice(i * size, (i + 1) * size),
    );
    return cumulativeDeltas(...chunks);
  };

  it("reuses settled scans across a streamed reply with a leaked call (#174345)", async () => {
    const fenced = fencedSections(40);
    const source = chunked(leading + fenced, 4);
    const resolveRanges = vi.fn(resolveTestFenceRanges);
    const events = await protectedDeltas(source, resolveRanges);
    expect(textDeltas(events).join("")).toBe(fenced);
    expect(resolveRanges.mock.calls.length).toBeLessThanOrEqual(Math.ceil(source.length / 4));
    let visible = "";
    for (const event of events) {
      const delta = event.delta;
      if (typeof delta !== "string" || delta.length === 0) {
        continue;
      }
      visible += delta;
      expect(event.partial).toEqual(scrub(leading + visible));
    }
  });

  it.each([
    ["spaces before the next line", '[tool:read]\n{"path":"a"}   \nNext.'],
    ["CRLF before the next line", '[tool:read]\n{"path":"a"}\r\nNext.'],
    ["closing tag with trailing spaces", "[read]\n{}\n[/read]   \nNext."],
  ])(
    "keeps the last streamed scrub equal to the unstreamed scrub (#174345): %s",
    async (_name, text) => {
      for (const chunkSize of [2, 3, 4, 5]) {
        const events = await protectedDeltas(chunked(text, chunkSize));
        const last = events.findLast((event) => event.type === "text_delta");
        expect(last?.partial).toEqual(scrub(text));
      }
    },
  );
});

describe("normalizePlainTextToolCallStreamEvents calls after visible text", () => {
  const trailing = '[tool:read]\n{"path":"b"}\n';

  it.each<[string, string[], string]>([
    ["one chunk", [`${leading}Done.\n${trailing}`], "Done.\n"],
    ["later chunk", [`${leading}Done.\n`, trailing], "Done.\n"],
    ["split name", [`${leading}Done.\n[tool:re`, 'ad]\n{"path":"b"}\n'], "Done.\n"],
    ["split marker", [`${leading}Done.\n[to`, 'ol:read]\n{"path":"b"}\n'], "Done.\n"],
    ["split payload", [`${leading}Done.\n[tool:read]\n{"path":"b`, '"}\n'], "Done.\n"],
    ["split function", [`${leading}Done.\n<funct`, "ion=read></function>"], "Done.\n"],
    ["stray closing tag", [`${leading}[/tool]\n${trailing}`], "[/tool]\n"],
    ["literal fenced call", [leading + fencedExample], fencedExample],
  ])("keeps streamed and terminal prose consistent: %s", async (_name, chunks, visible) => {
    const text = chunks.join("");
    const events = await normalizeProtected([...streamDeltas(...chunks), finish("stop", text)]);
    expect(textDeltas(events).join("")).toBe(visible);
    expectTerminal(events, "done", textContent(visible));
  });

  it.each(["eof", "done", "error"] as const)(
    "flushes prose but hides unfinished calls at %s",
    async (terminal) => {
      const raw = `${leading}Done.\n[tool:read`;
      const events = await normalize(withTerminal([textEvent(raw)], terminal, raw));
      expectVisible(events, ["Done.\n"], "[tool:", terminal);
    },
  );

  it("releases prose before a later call grows past the payload cap", async () => {
    const prose = "Done.\n".repeat(45_000);
    let visible = "";
    async function* source() {
      yield textEvent(`${leading}${prose}[tool:read]\n{"path":"`);
      expect(visible).toBe(prose);
      yield textEvent(oversized);
      yield textEvent('"}\nAfter.');
    }
    for await (const event of normalizeStream(source(), streamOptions)) {
      if (
        event &&
        typeof event === "object" &&
        "delta" in event &&
        typeof event.delta === "string"
      ) {
        visible += event.delta;
      }
    }
    expect(visible).toBe(`${prose}After.`);
  });
});

describe("normalizePlainTextToolCallStreamEvents trim replay ordering", () => {
  it.each<[string, Events]>([
    ["delta", []],
    ["cumulative text_end", [textEnd("x\n<function=read></function>", 1)]],
  ])("keeps replayed %s segments at their original content index", async (_name, ending) => {
    const events = await normalize([
      textEvent("[read]", 0),
      textEvent("x\n<function=read>", 1),
      ...ending,
    ]);
    const deltas = events.filter((event) => event.type === "text_delta");
    expect(deltas.map((event) => [event.contentIndex, event.delta])).toEqual([
      [0, "[read]"],
      [1, "x\n"],
    ]);
    expectHidden(events);
  });

  it("replays a decided prefix and buffered reasoning in arrival order", async () => {
    const events = await normalize([
      textEvent("[read]"),
      queuedReasoning,
      textEvent("\n<function=read>"),
    ]);
    expect(events.map((event) => [event.type, event.delta])).toEqual([
      ["text_delta", "[read]"],
      ["thinking_delta", "checking"],
      ["text_delta", "\n"],
    ]);
    expect(JSON.stringify(events)).not.toContain("<function=read>");
  });
});

describe("normalizePlainTextToolCallStreamEvents terminal trim drains", () => {
  const trimmedPrefix = `[read]${" ".repeat(300)}`;
  const trimmedVisible = `${trimmedPrefix}nope\n`;
  const trimmedDeltas = [textEvent(trimmedPrefix), textEvent("nope\n<function=read>")];
  const message = assistant(textContent("visible only"));
  it.each([
    ["eof", [queuedReasoning], "thinking_delta"],
    ["done", [queuedReasoning, doneEvent("stop", message)], "thinking_delta"],
    ["error", [queuedReasoning, errorEvent(message)], "thinking_delta"],
    ["candidate queue cap", lifecycles, "thinking_start"],
  ] as const)("drains buffered reasoning at %s", async (_name, ending, expectedType) => {
    const events = await normalize([...trimmedDeltas, ...ending]);
    expectVisible(events, [trimmedVisible], "<function=read>");
    expect(eventTypes(events)).toContain(expectedType);
  });
});
