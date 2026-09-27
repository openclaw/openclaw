import { describe, expect, it, vi } from "vitest";
import { projectScrubbedPlainTextToolCallMessage } from "./stream-normalizer.js";
import {
  assistantMessage,
  collectNormalizedEvents,
  doneAssistantEvent,
  matcher,
  normalize,
  resolveTestFenceRanges,
  streamTextDelta,
  textContent,
  textDeltas,
  textEnd,
} from "./stream-normalizer.test-support.js";

describe("normalizePlainTextToolCallStreamEvents protected ranges", () => {
  it("preserves a fenced call in terminal projections", () => {
    const text = ["```json", "[read]", '{"path":"example.txt"}', "[/read]", "```"].join("\n");
    const message = assistantMessage(text);

    expect(
      projectScrubbedPlainTextToolCallMessage({
        matcher,
        message,
        resolveProtectedRanges: resolveTestFenceRanges,
      }),
    ).toBeUndefined();
  });

  it("preserves fenced calls when the opener and call are split across live deltas", async () => {
    const parts = ["`", "``json\n", "[re", 'ad]\n{"path":"example.txt"}\n[/read]\n', "```"];
    const text = parts.join("");
    const events = await normalize(
      [
        ...parts.map((delta) => streamTextDelta(delta)),
        doneAssistantEvent("stop", textContent(text), "stop"),
      ],
      { protectFences: true },
    );

    expect(textDeltas(events).join("")).toBe(text);
    expect(events.at(-1)).toMatchObject({
      type: "done",
      message: { content: textContent(text), stopReason: "stop" },
    });
    expect(events.some((event) => String(event.type).startsWith("toolcall_"))).toBe(false);
  });

  it("preserves fence ownership across adjacent text content blocks", async () => {
    const first = "```json\n";
    const second = ["[read]", '{"path":"example.txt"}', "[/read]", "```"].join("\n");
    const content = textContent(first, second);
    const events = await normalize(
      [
        streamTextDelta(first),
        textEnd(first, 0),
        streamTextDelta(second, 1),
        textEnd(second, 1),
        doneAssistantEvent("stop", content, "stop"),
      ],
      { protectFences: true },
    );

    expect(textDeltas(events).join("")).toBe(first + second);
    expect(events.at(-1)).toMatchObject({
      type: "done",
      message: { content, stopReason: "stop" },
    });
    expect(events.some((event) => String(event.type).startsWith("toolcall_"))).toBe(false);
  });

  it("uses cumulative partials when earlier fenced blocks were not streamed", async () => {
    const candidate = ["[read]", '{"path":"example.txt"}', "[/read]", "```"].join("\n");
    const content = textContent("```json\n", candidate);
    const events = await normalize([streamTextDelta(candidate, 1, assistantMessage(content))], {
      protectFences: true,
    });

    expect(textDeltas(events)).toEqual([candidate]);
    expect(events.some((event) => String(event.type).startsWith("toolcall_"))).toBe(false);
  });

  it("uses cumulative partials when earlier fenced blocks were not streamed, even with a complete final line (#122513)", async () => {
    // codex review: the test above happens to end its candidate on an INCOMPLETE last line
    // ("```" with no trailing newline), which independently makes the fast path decline (it
    // always declines on an unfinished line outside a fence) -- masking the real bug. With a
    // complete last line, the fast path's carried state (empty, since block 0's "```json" was
    // never streamed as its own delta) wrongly reports the candidate as NOT protected instead
    // of falling through to the cumulative-partial/full-parse fallback that knows better.
    const first = "```json\n";
    const candidate = ["[read]", '{"path":"example.txt"}', "[/read]", "```", ""].join("\n");
    const content = textContent(first, candidate);
    const events = await normalize(
      [
        streamTextDelta(candidate, 1, assistantMessage(content)),
        textEnd(candidate, 1, assistantMessage(content)),
        doneAssistantEvent("stop", content, "stop"),
      ],
      { protectFences: true },
    );

    expect(textDeltas(events).join("")).toBe(candidate);
    expect(events.some((event) => String(event.type).startsWith("toolcall_"))).toBe(false);
  });

  it("recognizes a real call in an earlier block when a later block streams its fence first (#122513)", async () => {
    // codex review: the carried fence-state scan advances in EVENT order, but a partial's
    // per-block offsets are in CONTENT-INDEX order. A provider can stream block 1 (opening a
    // fence) before block 0 (a genuine, unfenced call) -- by the time block 0's own delta
    // arrives, the scan has tracked 8 chars (block 1's "```json\n") while block 0's own
    // content-order offset is 0. A ">" check misses this direction entirely and lets the fast
    // path answer from the scan's (wrong, event-order) state, which would treat the call as
    // fenced and never promote it -- only a "!==" check catches a mismatch in either direction.
    const candidate = ["[read]", '{"path":"example.txt"}', "[/read]", ""].join("\n");
    const second = "```json\n";
    // No text_end/done here: the terminal path always re-parses the whole assembled
    // message from scratch and would correctly scrub the call regardless of what the
    // streaming fast path decided, masking exactly the bug this test targets. The
    // observable difference is in the intermediate streamed text_delta events.
    const events = await collectNormalizedEvents(
      [
        streamTextDelta(second, 1, assistantMessage(textContent("", second))),
        streamTextDelta(candidate, 0, assistantMessage(textContent(candidate, second))),
      ],
      {
        matcher,
        createPromotedToolCallEvents: () => [],
        normalizeTerminalMessage: () => undefined,
        protectedRangesFenceCompatible: true,
        resolveProtectedRanges: resolveTestFenceRanges,
      },
    );

    // Wrongly "protected" would stream the raw candidate bytes straight out as literal
    // visible text; correctly recognized as a real, unfenced call, they are buffered as
    // a pending candidate instead and never appear verbatim in a streamed delta.
    const streamedText = events
      .map((event) =>
        typeof event.delta === "string"
          ? event.delta
          : typeof event.content === "string"
            ? event.content
            : "",
      )
      .join("");
    expect(streamedText).not.toContain('{"path":"example.txt"}');
  });

  it("does not trust a same-length prefix that came from a different block order (#122513)", async () => {
    // codex review: a length match alone does not prove the event-order scan represents
    // the same prefix as content-index order. Block 1 streams "```\n" first (opens a
    // backtick fence); block 0 then streams "~~~\n" (opens a tilde fence, since a tilde
    // delimiter never closes a backtick fence). Event order ends with fenceChar "`";
    // content-index order (0 then 1) ends with fenceChar "~" -- same tracked length (8),
    // opposite fence identity. Block 2's own "```" delimiter would close the (wrong)
    // event-order backtick fence but not the (correct) content-order tilde fence, so a
    // length-only check wrongly lets a call still inside the real fence through.
    const block1 = "```\n";
    const block0 = "~~~\n";
    const candidate = ["```", "[read]", '{"path":"example.txt"}', "[/read]", "```", ""].join("\n");
    const events = await collectNormalizedEvents(
      [
        streamTextDelta(block1, 1, assistantMessage(textContent("", block1))),
        streamTextDelta(block0, 0, assistantMessage(textContent(block0, block1))),
        streamTextDelta(candidate, 2, assistantMessage(textContent(block0, block1, candidate))),
      ],
      {
        matcher,
        createPromotedToolCallEvents: () => [],
        normalizeTerminalMessage: () => undefined,
        protectedRangesFenceCompatible: true,
        resolveProtectedRanges: resolveTestFenceRanges,
      },
    );

    // Correctly distrusted (this fix), block 2's candidate is recognized as still inside
    // the real (content-order) fence and streams straight out as literal visible text.
    // Wrongly trusted event-order state instead closes the fence on block 2's own
    // opening "```" and buffers the call as a pending candidate -- and since nothing
    // resolves it here, it silently never appears in the output at all.
    const streamedText = events
      .map((event) =>
        typeof event.delta === "string"
          ? event.delta
          : typeof event.content === "string"
            ? event.content
            : "",
      )
      .join("");
    expect(streamedText).toContain('{"path":"example.txt"}');
  });

  it("does not cache trust from a candidate with no partial at all (#122513)", async () => {
    // codex review: a candidate delta can arrive with no partial at all (partial is
    // optional on every event type). hasUntrackedPrecedingContext has nothing to compare
    // in that case and returns "no data", which must not be cached as "trusted" for the
    // rest of the block -- a LATER candidate in the same block, one that does carry a
    // partial revealing a genuine event-order/content-order mismatch, must still get its
    // own fresh check rather than inheriting a default that was never actually confirmed.
    const block1 = "```\n";
    // A complete, well-formed call with no partial: resolves immediately, so a second,
    // separate candidate can start afterward in the same block.
    const firstCall = "[read]\n{}\n[/read]\n";
    const secondCandidate = ["```", "[read]", '{"path":"x"}', "[/read]", "```", ""].join("\n");
    const events = await collectNormalizedEvents(
      [
        streamTextDelta(block1, 1),
        streamTextDelta(firstCall, 0),
        streamTextDelta(
          secondCandidate,
          0,
          assistantMessage(textContent(`~~~\n${firstCall}${secondCandidate}`, block1)),
        ),
      ],
      {
        matcher,
        createPromotedToolCallEvents: () => [],
        normalizeTerminalMessage: () => undefined,
        protectedRangesFenceCompatible: true,
        resolveProtectedRanges: resolveTestFenceRanges,
      },
    );

    // Wrongly caching "trusted" from the no-partial first call would leave the second
    // candidate evaluated against the (wrong) event-order fence state, buffering it as a
    // pending candidate that nothing here ever resolves -- it silently vanishes from the
    // output. Correctly re-checked, it is recognized as still protected and streams out
    // as literal visible text.
    const streamedText = events
      .map((event) =>
        typeof event.delta === "string"
          ? event.delta
          : typeof event.content === "string"
            ? event.content
            : "",
      )
      .join("");
    expect(streamedText).toContain('{"path":"x"}');
  });

  it("invalidates a cached preceding-context verdict when the earlier block grows (#122513)", async () => {
    // codex review: an earlier block can itself still be actively streaming and grow
    // between two candidate probes in a later block, without the content index ever
    // switching away and back (which would otherwise reset the per-block cache via
    // beginProtectionBlock). A cache keyed only on "have we checked this block yet"
    // would reuse a verdict that predates that growth. Block 0 streams "~~~\n" for real
    // (opening a tilde fence in event order); a first, complete call in block 1 confirms
    // trust against that. A second candidate in block 1 then arrives with a partial
    // reporting a LARGER block 0 ("~~~\n~~~\n", closing that same fence in content
    // order) -- the cache must notice the preceding length changed and re-check, not
    // reuse the first verdict.
    const block0First = "~~~\n";
    const firstCall = "[read]\n{}\n[/read]\n";
    const secondCandidate = ["[read]", '{"path":"x"}', "[/read]", ""].join("\n");
    const block0Grown = `${block0First}~~~\n`;
    const events = await collectNormalizedEvents(
      [
        streamTextDelta(block0First, 0),
        streamTextDelta(firstCall, 1, assistantMessage(textContent(block0First, firstCall))),
        streamTextDelta(
          secondCandidate,
          1,
          assistantMessage(textContent(block0Grown, `${firstCall}${secondCandidate}`)),
        ),
      ],
      {
        matcher,
        createPromotedToolCallEvents: () => [],
        normalizeTerminalMessage: () => undefined,
        protectedRangesFenceCompatible: true,
        resolveProtectedRanges: resolveTestFenceRanges,
      },
    );

    // A stale cached "trusted" verdict evaluates the second candidate against the
    // event-order scan, which never saw block 0's second "~~~\n" and so still thinks the
    // tilde fence from the first "~~~\n" is open -- the real, unfenced call is wrongly
    // buffered as protected content and (nothing here resolves it) silently vanishes.
    // Correctly invalidated, the cache re-checks against the grown block 0, sees the
    // fence actually closed in content order, and the real call is recognized.
    const streamedText = events
      .map((event) =>
        typeof event.delta === "string"
          ? event.delta
          : typeof event.content === "string"
            ? event.content
            : "",
      )
      .join("");
    expect(streamedText).not.toContain('{"path":"x"}');
  });

  it("preserves candidate bytes after bounded protection history overflows", async () => {
    const opening = `\`\`\`text\n${"x".repeat(1_000_000)}`;
    const candidate = ["[read]", '{"path":"example.txt"}', "[/read]"].join("\n");
    const events = await normalize([streamTextDelta(opening), streamTextDelta(candidate)], {
      protectFences: true,
    });

    expect(textDeltas(events).join("")).toBe(opening + candidate);
  });

  it("does not resolve Markdown protection for ordinary streamed text", async () => {
    let resolverCalls = 0;
    const visibleChunks = Array.from({ length: 1_000 }, () => "ordinary prose\n");
    const events = await collectNormalizedEvents(
      visibleChunks.map((delta) => streamTextDelta(delta)),
      {
        matcher,
        createPromotedToolCallEvents: () => [],
        normalizeTerminalMessage: () => undefined,
        resolveProtectedRanges: () => {
          resolverCalls += 1;
          return [];
        },
      },
    );

    expect(resolverCalls).toBe(0);
    expect(textDeltas(events).join("")).toBe(visibleChunks.join(""));
  });

  it("materializes accumulated Markdown only after a candidate-shaped delta", async () => {
    const resolvedLengths: number[] = [];
    const visibleChunks = Array.from({ length: 1_000 }, () => "ordinary prose\n");
    const candidate = ["[read]", '{"path":"example.txt"}', "[/read]"].join("\n");
    const events = await collectNormalizedEvents(
      [...visibleChunks.map((delta) => streamTextDelta(delta)), streamTextDelta(candidate)],
      {
        matcher,
        createPromotedToolCallEvents: () => [],
        normalizeTerminalMessage: () => undefined,
        resolveProtectedRanges: (text) => {
          resolvedLengths.push(text.length);
          return [];
        },
      },
    );

    expect(resolvedLengths).toContain(visibleChunks.join("").length + candidate.length);
    expect(resolvedLengths.length).toBeLessThanOrEqual(3);
    expect(textDeltas(events).join("")).toBe(visibleChunks.join(""));
  });

  it("materializes accumulated Markdown when an inline span blocks the fast path", async () => {
    const resolvedLengths: number[] = [];
    // Inline code spans are a shape the carried fence scan deliberately does not model,
    // so the authoritative full parse must still run — and still stay bounded.
    const visibleChunks = Array.from({ length: 1_000 }, () => "ordinary `code` prose\n");
    const candidate = ["[read]", '{"path":"example.txt"}', "[/read]"].join("\n");
    const events = await collectNormalizedEvents(
      [...visibleChunks.map((delta) => streamTextDelta(delta)), streamTextDelta(candidate)],
      {
        matcher,
        createPromotedToolCallEvents: () => [],
        normalizeTerminalMessage: () => undefined,
        protectedRangesFenceCompatible: true,
        resolveProtectedRanges: (text) => {
          resolvedLengths.push(text.length);
          return [];
        },
      },
    );

    expect(resolvedLengths).toContain(visibleChunks.join("").length + candidate.length);
    expect(resolvedLengths.length).toBeLessThanOrEqual(3);
    expect(textDeltas(events).join("")).toBe(visibleChunks.join(""));
  });

  it("does not carry an open fence from a finished completion into the next one", async () => {
    // The done branch clears the protection context; carried block state must clear with
    // it, or the next completion starts "inside" the previous fence and its first line is
    // wrongly treated as protected literal text.
    const firstText = "```toml\n[read.section]\n";
    const call = ["[read]", '{"path":"secret.txt"}', "[/read]"].join("\n");
    const events = await normalize(
      [
        streamTextDelta(firstText),
        doneAssistantEvent("stop", textContent(firstText), "stop"),
        streamTextDelta(`${call}\n`),
        doneAssistantEvent("stop", textContent(`${call}\n`), "stop"),
      ],
      { protectFences: true },
    );

    expect(textDeltas(events).join("")).not.toContain('{"path":"secret.txt"}');
  });

  it("keeps protection resolution bounded across a bracket-dense fenced answer", async () => {
    let resolverCalls = 0;
    // `[read...` is candidate-shaped for this matcher, so every line trips the candidate
    // check while staying protected by the surrounding fence.
    const fenced = [
      "```toml",
      ...Array.from({ length: 300 }, (_, index) => `[read.section.${index}]\nname = "svc"`),
      "```",
      "",
    ].join("\n");
    // Split so every '[' lands at the end of its own delta, which is what makes a real
    // provider stream trip the candidate check on nearly every line.
    const deltas = fenced.split(/(?<=\[)/);
    const events = await collectNormalizedEvents(
      deltas.map((delta) => streamTextDelta(delta)),
      {
        matcher,
        createPromotedToolCallEvents: () => [],
        normalizeTerminalMessage: () => undefined,
        protectedRangesFenceCompatible: true,
        resolveProtectedRanges: (text) => {
          resolverCalls += 1;
          return resolveTestFenceRanges(text);
        },
      },
    );

    // Before the carried fence state existed this resolved the whole accumulated
    // response once per bracket delta (hundreds of full parses over a growing buffer).
    expect(resolverCalls).toBeLessThanOrEqual(3);
    expect(textDeltas(events).join("")).toBe(fenced);
  });

  it("keeps protection resolution bounded when every delta carries a cumulative partial", async () => {
    let resolverCalls = 0;
    // OpenAI-completions and Mistral attach a growing cumulative snapshot to every
    // text_delta via `partial`. resolvePartialProtectionCheck validates against exactly
    // that shape and, when it validates, still does a full Markdown parse of the
    // snapshot — so if it ran ahead of the carried-fence-state fast path, the fast path
    // would never get a chance to answer and the quadratic parse would persist even
    // with protectedRangesFenceCompatible set.
    const fenced = [
      "```toml",
      ...Array.from({ length: 300 }, (_, index) => `[read.section.${index}]\nname = "svc"`),
      "```",
      "",
    ].join("\n");
    const deltas = fenced.split(/(?<=\[)/);
    let accumulated = "";
    const events = await collectNormalizedEvents(
      deltas.map((delta) => {
        accumulated += delta;
        return streamTextDelta(delta, 0, assistantMessage(textContent(accumulated)));
      }),
      {
        matcher,
        createPromotedToolCallEvents: () => [],
        normalizeTerminalMessage: () => undefined,
        protectedRangesFenceCompatible: true,
        resolveProtectedRanges: (text) => {
          resolverCalls += 1;
          return resolveTestFenceRanges(text);
        },
      },
    );

    expect(resolverCalls).toBeLessThanOrEqual(3);
    expect(textDeltas(events).join("")).toBe(fenced);
  });

  it("keeps a large preceding block's prefix check bounded across many later candidates (#122513)", async () => {
    // End the preceding line so the next block opens a CommonMark fence.
    const precedingBlock = `${"x".repeat(199_999)}\n`;
    const fenced = [
      "```toml",
      ...Array.from({ length: 300 }, (_, index) => `[read.section.${index}]\nname = "svc"`),
      "```",
      "",
    ].join("\n");
    const deltas = fenced.split(/(?<=\[)/);
    let accumulated = "";
    const events = [
      streamTextDelta(precedingBlock, 0, assistantMessage(textContent(precedingBlock, ""))),
      ...deltas.map((delta) => {
        accumulated += delta;
        return streamTextDelta(
          delta,
          1,
          assistantMessage(textContent(precedingBlock, accumulated)),
        );
      }),
    ];

    let resolverCalls = 0;
    let precedingPrefixSlices = 0;
    // oxlint-disable-next-line typescript/unbound-method -- called below with the intercepted string receiver.
    const originalSlice = String.prototype.slice;
    const sliceSpy = vi.spyOn(String.prototype, "slice").mockImplementation(function (
      this: string,
      start,
      end,
    ) {
      if (start === 0 && end === precedingBlock.length && this.length >= end) {
        precedingPrefixSlices += 1;
      }
      return originalSlice.call(this, start, end);
    });
    let normalized: Record<string, unknown>[];
    try {
      normalized = await collectNormalizedEvents(events, {
        matcher,
        createPromotedToolCallEvents: () => [],
        normalizeTerminalMessage: () => undefined,
        protectedRangesFenceCompatible: true,
        resolveProtectedRanges: (text) => {
          resolverCalls += 1;
          return resolveTestFenceRanges(text);
        },
      });
    } finally {
      sliceSpy.mockRestore();
    }

    expect(resolverCalls).toBeLessThanOrEqual(3);
    // Rechecking the entire preceding block for every candidate makes work quadratic.
    // Count full-prefix operations so this bound does not depend on runner speed.
    expect(precedingPrefixSlices).toBeLessThanOrEqual(4);
    expect(textDeltas(normalized).join("")).toBe(precedingBlock + fenced);
  });

  it("still protects an unfenced caller-defined range when the fast path is not opted in", async () => {
    // The carried fence scan only ever proves fence state. A resolver whose protected
    // ranges are not fences at all (unlike resolveTestFenceRanges/findCodeRegions) would be
    // silently bypassed if the stream trusted the fast path's "not protected" verdict for
    // it, so this must go through the full resolver instead — this caller never opts in.
    const OPEN_MARK = "<<PROTECT>>";
    const CLOSE_MARK = "<<END>>";
    const resolveMarkedRanges = (text: string) => {
      const ranges: Array<{ end: number; start: number }> = [];
      let cursor = 0;
      for (;;) {
        const start = text.indexOf(OPEN_MARK, cursor);
        if (start === -1) {
          break;
        }
        const close = text.indexOf(CLOSE_MARK, start + OPEN_MARK.length);
        const end = close === -1 ? text.length : close + CLOSE_MARK.length;
        ranges.push({ start, end });
        cursor = end;
      }
      return ranges;
    };
    const call = ["[read]", '{"path":"secret.txt"}', "[/read]"].join("\n");
    // A trailing newline keeps every line complete; an unfinished final line is a shape the
    // fast path already declines on its own, which would mask the bug this test targets.
    const text = `${OPEN_MARK}\n${call}\n${CLOSE_MARK}\n`;
    const events = await collectNormalizedEvents(
      [streamTextDelta(text), doneAssistantEvent("stop", textContent(text), "stop")],
      {
        matcher,
        createPromotedToolCallEvents: () => [],
        normalizeTerminalMessage: ({ message }) => {
          const scrubbed = projectScrubbedPlainTextToolCallMessage({
            matcher,
            message,
            resolveProtectedRanges: resolveMarkedRanges,
          });
          return scrubbed ? { kind: "scrubbed", ...scrubbed } : undefined;
        },
        resolveProtectedRanges: resolveMarkedRanges,
      },
    );

    expect(textDeltas(events).join("")).toBe(text);
    expect(events.at(-1)).toMatchObject({
      type: "done",
      message: { content: textContent(text), stopReason: "stop" },
    });
  });

  it("still scrubs an unfenced call from live deltas and the terminal message", async () => {
    const text = ["[read]", '{"path":"secret.txt"}', "[/read]"].join("\n");
    const events = await normalize(
      [streamTextDelta(text), doneAssistantEvent("length", textContent(text), "length")],
      { protectFences: true },
    );

    expect(textDeltas(events)).toEqual([]);
    expect(events.at(-1)).toMatchObject({
      type: "done",
      message: { content: [{ type: "text", text: "" }], stopReason: "length" },
    });
  });
});
