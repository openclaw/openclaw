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
const functionOpen = "<function=read>";
const functionCall = `${functionOpen}</function>`;
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
  types?: string[],
) {
  expect(textDeltas(events)).toEqual(visible);
  if (marker !== undefined) {
    expectHidden(events, marker);
  }
  if (terminal !== undefined) {
    expectTerminal(events, terminal, textContent(visible.join("")));
  }
  if (types !== undefined) {
    expect(eventTypes(events)).toEqual(types);
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
function chunksOf(text: string, size: number) {
  return Array.from({ length: Math.ceil(text.length / size) }, (_, i) =>
    text.slice(i * size, (i + 1) * size),
  );
}

describe("normalizePlainTextToolCallStreamEvents", () => {
  it("adds only one async iterator boundary for ordinary streamed text", async () => {
    const events = Array.from({ length: 128 }, () => textEvent("ordinary prose "));
    async function* source() {
      for (const event of events) {
        yield event;
      }
    }
    async function countTicks(stream: AsyncIterable<unknown>) {
      let ticks = 0;
      let running = true;
      const tick = () => {
        if (running) {
          ticks++;
          queueMicrotask(tick);
        }
      };
      const output: unknown[] = [];
      queueMicrotask(tick);
      try {
        for await (const event of stream) {
          output.push(event);
        }
      } finally {
        running = false;
      }
      expect(output).toEqual(events);
      return ticks;
    }
    const direct = await countTicks(source());
    const normalized = await countTicks(normalizeStream(source(), streamOptions));
    // One async-generator hop adds two microtask turns per event, plus completion.
    expect(normalized - direct).toBeLessThanOrEqual(2 * (events.length + 1));
  });
  const falseMarker = cumulativeDeltas(aggregate + "[tool:re", " nope");
  const optionalWhitespace = streamDeltas(
    `[tool:read] {"path":"${oversized}`,
    '"}',
    "\n\n",
    "Visible",
  );
  const ordinaryProse = "analysis is ordinary prose";
  const proseEnd = [textEvent("analysis"), textEnd(ordinaryProse)];
  const endTypes = ["text_delta", "text_end"];
  const malformed = "<parameter=x!>Visible answer";
  const invalidParameter = streamDeltas(xmlParameter + "</parameter>", malformed);
  const recovered = [textEvent(xmlParameter), textEnd(`${parameterCall}\nVisible answer`)];
  const heldStart = [
    textStart(0, "", assistant(textContent(""))),
    ...cumulativeDeltas("Visible\n[tool:re", " nope"),
  ];
  const startTypes = ["text_start", "text_delta", "text_delta"];
  const xmlPrefix = overCapXml.slice(0, -"</function>".length);
  const invalidatedXml = withTerminal(
    cumulativeDeltas(xmlPrefix, "Visible answer"),
    "done",
    xmlPrefix + "Visible answer",
  );
  const jsonChunks = [
    `[read]\n{"path":"${oversized}`,
    '"}',
    ...chunksOf(" ".repeat(64 * 4096), 4096),
    "[/read]\nVisible",
  ];
  const paddedJson = [...streamDeltas(...jsonChunks), finish("length", jsonChunks.join(""))];
  const segmentHead = `${overCapXml}\nONE\n`;
  const segmentTail = "TWO\n<function=read></function>\nONE\n";
  const segmentSnapshot = segmentHead + segmentTail;
  const repeatedSegments = [
    { type: "text_delta", delta: segmentHead },
    textEvent(segmentTail),
    textEnd(segmentSnapshot, 0, assistant(textContent(segmentSnapshot))),
    finish("length", segmentSnapshot),
  ];
  const segments = ["ONE\n", "TWO\n", "ONE\n"];
  const segmentTypes = ["text_delta", "text_delta", "text_delta", "done"];
  const unnamedDone = withTerminal(streamDeltas("comment"), "done", "comment");
  it.each<[string, Events, string[], string?, Terminal?, string[]?]>([
    ["replays an aggregate's false marker", falseMarker, ["[tool:re nope"], functionOpen],
    ["retains split optional-closer whitespace", optionalWhitespace, ["\nVisible"]],
    ["reconciles false-prefix prose", proseEnd, [ordinaryProse], undefined, undefined, endTypes],
    ["bounds unnamed Harmony prefixes", streamDeltas(longHarmony), [longHarmony]],
    ["preserves malformed parameters", invalidParameter, [malformed]],
    ["recovers an authoritative suffix", recovered, ["Visible answer"], functionOpen],
    ["held start", heldStart, ["Visible\n", "[tool:re nope"], undefined, undefined, startTypes],
    ["invalidated over-cap XML", invalidatedXml, ["Visible answer"], functionOpen, "done"],
    ["post-JSON whitespace", paddedJson, ["Visible"], "[read]", "done"],
    ["text_end segment deduplication", repeatedSegments, segments, undefined, "done", segmentTypes],
    ["unnamed prefix at EOF", streamDeltas("<"), ["<"], undefined, "eof"],
    ["unnamed prefix at done", unnamedDone, ["comment"], undefined, "done"],
  ])("%s", async (_name, source, visible, hidden, terminal, types) => {
    expectVisible(await normalize(source), visible, hidden, terminal, types);
  });

  it.each<[string, string[], string[], string]>([
    ["false prefix", [" [read]\n", "<function=read>"], [" [read]\n"], "<function=read>"],
    [
      "stacked Harmony",
      [leading.trimEnd() + " <|channel|>", "commentary to=read code<|message|>  "],
      [],
      "<|channel|>",
    ],
  ])("keeps split call markers private after %s", async (_name, chunks, visible, hidden) => {
    expectVisible(await normalizeTextDeltas(...chunks), visible, hidden);
    expect(textDeltas(await normalizeTextDeltas(chunks.join("")))).toEqual(visible);
  });

  it.each([
    ["<function=read>", "</function>"],
    ["<|channel|>commentary", ' to=read code<|message|>{"path":"a"}'],
  ])("keeps every opening-marker split private for %s", async (marker, tail) => {
    for (let split = 1; split < marker.length; split += 1) {
      const events = await normalizeTextDeltas(
        leading.trimEnd() + marker.slice(0, split),
        marker.slice(split) + tail,
      );
      expect(textDeltas(events)).toEqual([]);
      expectHidden(events, marker);
    }
    expect(textDeltas(await normalizeTextDeltas(leading.trimEnd() + marker + tail))).toEqual([]);
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
    const events = await normalize([finish("length", `${overCapXml}\n${visible}`)]);
    expect(events.at(-1)?.message).toMatchObject({ content: textContent(visible) });
  });

  it("uses the compact error projection when no partial is present", async () => {
    const raw = `[tool:read]\n<parameter=path>\n${oversized}`;
    const error = assistant([...textContent(raw), thinking]);
    const events = await normalize([
      textDelta(raw, raw),
      { ...queuedReasoning, contentIndex: 1, partial: error },
      errorEvent(error),
    ]);
    expect(events).toMatchObject([
      { type: "thinking_delta", contentIndex: 0, partial: { content: [thinking] } },
      { type: "error", error: { content: [thinking] } },
    ]);
    expectHidden(events, "[tool:read]");
  });

  it("drains every auxiliary lifecycle event at the candidate queue cap", async () => {
    const events = await normalize([textEvent('[tool:read] {"path":"SECRET"'), ...lifecycles]);
    expect(events).toMatchObject([{ type: "start" }, ...lifecycles]);
    expectHidden(events, "SECRET");
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
    expectHidden(events, "SECRET");
  });

  it("snapshots only retained events while coalescing buffered deltas", async () => {
    let snapshots = 0;
    const first = { ...queuedReasoning, delta: "first", partial: { marker: 1 } };
    const last = { ...queuedReasoning, delta: "last", partial: { marker: 2 } };
    const source = [first, last].map(
      (event) =>
        new Proxy(event, {
          ownKeys(target) {
            snapshots++;
            return Reflect.ownKeys(target);
          },
        }),
    );
    const events = await collect([textEvent("[tool:re"), ...source], streamOptions);

    expect(events).toEqual([{ ...first, delta: "firstlast", partial: last.partial }]);
    expect(first.delta).toBe("first");
    expect(first.partial).toEqual({ marker: 1 });
    expect(last.delta).toBe("last");
    expect(snapshots).toBe(1);
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

  it("bounds blank-line buffering after a complete call", async () => {
    const whitespaceChunks = chunksOf("\n".repeat(65 * 4096), 4096);
    const events = await normalizeTextDeltas(`${functionCall}\n`, ...whitespaceChunks, "Visible");

    const deltas = textDeltas(events);
    expect(deltas.at(-1)).toBe("Visible");
    expect(deltas.slice(0, -1).join("").length).toBeLessThanOrEqual(2 * 4096);
    expectHidden(events);
  });

  it("scans complete under-cap call sequences linearly", () => {
    const callCount = 64;
    const hasExactName = vi.fn((name: string) => matcher.hasExactName(name));
    const text = Array.from({ length: callCount }, () => functionCall).join("\n");
    expect(
      scrubMessage({ matcher: { ...matcher, hasExactName }, message: assistant(text) }),
    ).toBeUndefined();
    expect(hasExactName.mock.calls.length).toBeLessThanOrEqual(callCount * 3);
  });

  it("retains a new block supplied only by its authoritative text end", async () => {
    const events = await normalize([textEvent("[read]"), textEnd("Visible answer", 1)]);
    expect(events).toEqual([textEvent("[read]"), textEnd("Visible answer", 1)]);
  });

  it("preserves streamed content indexes in terminal error snapshots", async () => {
    const suffix = { type: "text", text: "Visible suffix." };
    const clean = {
      type: "thinking_start",
      contentIndex: 1,
      partial: assistant([...textContent(""), thinking]),
    };
    const error = assistant([...textContent(parameterCall), thinking, suffix]);
    const events = await normalize([
      textEvent(parameterCall),
      clean,
      textEvent(suffix.text, 2),
      errorEvent(error, error),
    ]);
    expect(events[0]).toEqual(clean);
    expect(textDeltas(events)).toEqual([suffix.text]);
    expectTerminal(events, "error", [...textContent(""), thinking, suffix]);
  });

  const whitespace = " ".repeat(256_001);
  const secretJson = '{"path":"SECRET"}<|call|>';
  const punctuatedXml = cumulativeDeltas(
    `${xmlParameter}</parameter>`,
    "<parameter=foo.bar>SECRET</parameter></function>",
  );
  const hostileIndex = textEvent(
    parameterCall,
    Number.MAX_SAFE_INTEGER,
    assistant(textContent(parameterCall)),
  );
  it.each([
    ["XML-punctuated parameter", punctuatedXml],
    ["bracket whitespace", streamDeltas("[tool:read]" + whitespace, secretJson)],
    ["Harmony whitespace", streamDeltas("analysis to=read code" + whitespace, secretJson)],
    ["hostile content index", [hostileIndex]],
  ] as const)("suppresses %s", async (_name, source) => {
    expect(await normalize(source)).toEqual([]);
  });

  it.each(["error", "done"] as const)("fails closed at %s", async (terminal) => {
    const raw = "<function=read><parameter=path>SECRET";
    const events = await normalize(
      terminal === "error"
        ? [textEvent(raw), errorEvent({ message: "stream failed" })]
        : withTerminal([textEvent(raw)], terminal, raw),
    );
    expect(events.at(-1)?.type).toBe(terminal);
    expect(textDeltas(events)).toEqual([]);
    expectHidden(events, "SECRET");
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
        createPromotedToolCallEvents: (partial) =>
          ["toolcall_start", "toolcall_end"].map((type) => ({ type, contentIndex: 0, partial })),
        normalizeTerminalMessage: () => ({
          kind: "promoted",
          message: promotedMessage,
          sourceToProjectedContentIndex: new Map(),
        }),
      },
    );
    expect(eventTypes(events)).toEqual(["start", "toolcall_start", "toolcall_end", "done"]);
    expect(events.at(-1)).toMatchObject({ reason: "toolUse", message: promotedMessage });
    expectHidden(events, "[/read]");
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
      .map(
        ({ delta, content }) => [delta, content].find((value) => typeof value === "string") ?? "",
      )
      .join("");
  }
  function expectLiteral(events: Events, text: string, content: unknown) {
    expect(textDeltas(events).join("")).toBe(text);
    expect(events.at(-1)).toMatchObject({ type: "done", message: { content, stopReason: "stop" } });
    expect(events.some((event) => String(event.type).startsWith("toolcall_"))).toBe(false);
  }

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
    const events = await protectedDeltas(source, resolveRanges);
    expect(resolveRanges.mock.calls.length).toBeLessThanOrEqual(3);
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
    const events = await normalize([textEvent(text), finish("stop", text)], {
      resolveProtectedRanges: resolveMarkedRanges,
    });
    expectLiteral(events, text, textContent(text));
  });
  const chunked = (text: string, size: number) => cumulativeDeltas(...chunksOf(text, size));

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
      expect(event.partial).toEqual(assistant(textContent(visible)));
    }
  });

  it.each([
    ["spaces before the next line", '[tool:read]\n{"path":"a"}   \nNext.'],
    ["CRLF before the next line", '[tool:read]\n{"path":"a"}\r\nNext.'],
    ["closing tag with trailing spaces", "[read]\n{}\n[/read]   \nNext."],
  ])("preserves scrubbed suffixes (#174345): %s", async (_name, text) => {
    for (const chunkSize of [2, 3, 4, 5]) {
      const events = await protectedDeltas(chunked(text, chunkSize));
      const last = events.findLast((event) => event.type === "text_delta");
      expect(last?.partial).toEqual(assistant(textContent("Next.")));
    }
  });
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

  it.each(["eof", "done", "error"] as const)("hides unfinished calls at %s", async (terminal) => {
    const raw = `${leading}Done.\n[tool:read`;
    const events = await normalize(withTerminal([textEvent(raw)], terminal, raw));
    expectVisible(events, ["Done.\n"], "[tool:", terminal);
  });

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
  const indexedReplay = [textEvent("[read]"), textEvent("x\n<function=read>", 1)];
  const indexedOutput = [textEvent("[read]"), textEvent("x\n", 1)];
  const reasoningReplay = [textEvent("[read]"), queuedReasoning, textEvent("\n<function=read>")];
  const reasoningOutput = [
    { type: "text_delta", delta: "[read]" },
    queuedReasoning,
    { type: "text_delta", delta: "\n" },
  ];
  it.each<[string, Events, Events, boolean?]>([
    ["delta indexes", indexedReplay, indexedOutput],
    [
      "text_end indexes",
      [...indexedReplay, textEnd("x\n<function=read></function>", 1)],
      indexedOutput,
    ],
    ["reasoning arrival order", reasoningReplay, reasoningOutput, true],
  ])("preserves replay %s", async (_name, source, expected, includeAux) => {
    const events = await normalize(source);
    expect(
      includeAux ? events : events.filter((event) => event.type === "text_delta"),
    ).toMatchObject(expected);
    expectHidden(events);
  });
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
