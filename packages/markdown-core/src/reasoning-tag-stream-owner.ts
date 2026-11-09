// Markdown Core owns block-aware incremental reasoning-tag partitioning.
import {
  findNextLineEnding,
  isInsideCode,
  parseMarkdownOwnership,
  parseReasoningTagAt,
  parseReasoningTagName,
  reduceReasoningText,
  reduceStableReasoningText,
  scanStableReasoningTags,
  scanReasoningTags,
  type ReasoningTagTextDelta,
  type ReductionState,
} from "./reasoning-tag-parser.js";
import type { ReasoningTagTextPartitioner } from "./reasoning-tags.js";

const MARKDOWN_CONTAINER_LINE_RE = /^(?: {0,3}(?:>|[-+*][\t ]|\d{1,9}[.)][\t ]))/mu;

function endsBlankBlock(text: string): boolean {
  let cursor = text.length - 1;
  if (text[cursor] === "\n") {
    cursor -= text[cursor - 1] === "\r" ? 2 : 1;
  } else if (text[cursor] === "\r") {
    cursor -= 1;
  } else {
    return false;
  }
  // Walk only the final blank line; a forward suffix regex rescans growing paragraphs.
  while (text[cursor] === " " || text[cursor] === "\t") {
    cursor -= 1;
  }
  return text[cursor] === "\n" || text[cursor] === "\r";
}

type PendingTagProbe = {
  nameResolved: boolean;
  quote?: '"' | "'";
  resolved: boolean;
  scannedThrough: number;
  start: number;
};

function advancePendingTagProbe(probe: PendingTagProbe, text: string): void {
  for (const char of text) {
    if (probe.quote) {
      if (char === probe.quote) {
        probe.quote = undefined;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      probe.quote = char;
    } else if (char === ">" || char === "<") {
      probe.resolved = true;
      return;
    }
  }
}

/** Creates a block-incremental parser that emits only Markdown-stable text. */
function createReasoningTagStreamOwner(live: boolean) {
  const reduction: ReductionState = { depth: 0, visibleEver: false };
  const reduce = live ? reduceStableReasoningText : reduceReasoningText;
  let completedThinking = "";
  let literalStart = -1;
  let literalEnd = 0;
  let liveCodeProbe = false;
  let source = "";
  let endedBlankBlock = false;
  let blockStart = 0;
  let emitted = 0;
  let holdStart: number | undefined;
  let heldBacktickStart: number | undefined;
  let strictMode = false;
  let pendingTagProbe: PendingTagProbe | undefined;
  let fastPathCheckedThrough = 0;
  let fastPathCodeSafe = false;
  let nonFinalFullParses = 0;
  let nonFinalCodeSpans: Array<[number, number]> | undefined;
  let nonFinalCodeSpansEnd = 0;
  let nonFinalOpenEndedCode = false;
  let nonFinalRetainStart = 0;
  let nonFinalCloseReparseUsed = false;

  const startPendingTagProbe = (start: number, end: number) => {
    pendingTagProbe = { nameResolved: false, resolved: false, scannedThrough: end, start };
    advancePendingTagProbe(pendingTagProbe, source.slice(start + 1, end));
  };

  const compactCommittedSource = (retainStart: number) => {
    source = source.slice(retainStart);
    endedBlankBlock = endsBlankBlock(source);
    blockStart = source.length;
    emitted = source.length;
    holdStart = undefined;
    heldBacktickStart = undefined;
    pendingTagProbe = undefined;
    fastPathCheckedThrough = 0;
    fastPathCodeSafe = false;
    nonFinalFullParses = 0;
    nonFinalCodeSpans = undefined;
    nonFinalCodeSpansEnd = 0;
    nonFinalOpenEndedCode = false;
    nonFinalRetainStart = 0;
    nonFinalCloseReparseUsed = false;
    literalStart = -1;
    literalEnd = 0;
    liveCodeProbe = false;
  };

  const advanceLiteralTail = () => {
    if (literalStart !== emitted) {
      literalStart = emitted;
      literalEnd = emitted;
    }
    while (literalEnd < source.length) {
      const char = source.charAt(literalEnd);
      if (char === "<" || char === "`") {
        break;
      }
      literalEnd += 1;
    }
    return literalEnd;
  };

  const merge = (target: ReasoningTagTextDelta[], additions: ReasoningTagTextDelta[]) => {
    for (const addition of additions) {
      const previous = target.at(-1);
      if (previous?.kind === addition.kind) {
        previous.text += addition.text;
      } else {
        target.push({ ...addition });
      }
    }
  };

  const reduceSafePrefix = (
    start: number,
    end: number,
    probeEnd: number,
    output: ReasoningTagTextDelta[],
  ) => {
    const scan = scanReasoningTags(source.slice(start, end), false);
    const reduceEnd = scan.pendingStart === undefined ? end : start + scan.pendingStart;
    merge(
      output,
      reduce(source.slice(start, reduceEnd), [], reduction, {
        final: false,
        mode: "visible",
        scope: "all",
      }),
    );
    emitted = reduceEnd;
    fastPathCheckedThrough = reduceEnd;
    if (scan.pendingStart !== undefined) {
      startPendingTagProbe(reduceEnd, probeEnd);
    }
    holdStart = reduction.depth > 0 || scan.pendingStart !== undefined ? emitted : undefined;
  };

  const emitSafePrefix = (limit: number, output: ReasoningTagTextDelta[], appended?: string) => {
    if (strictMode) {
      holdStart ??= emitted;
      return;
    }
    if (reduction.depth > 0) {
      holdStart ??= emitted;
      const segment = source.slice(emitted, limit);
      if (!fastPathCodeSafe || /[\r\n`]/u.test(segment)) {
        return;
      }
      reduceSafePrefix(emitted, limit, limit, output);
      return;
    }
    if (holdStart !== undefined || emitted >= limit) {
      return;
    }
    // Reuse the incoming chunk so emitted slices do not retain each growing
    // flattened source prefix through the caller's accumulated output.
    const appendedStart = source.length - (appended?.length ?? 0);
    const useAppended = appended !== undefined && emitted >= appendedStart;
    const scanSource = useAppended ? appended : source;
    const scanOffset = useAppended ? appendedStart : 0;
    while (emitted < limit && holdStart === undefined) {
      let special = -1;
      for (let index = emitted; index < limit; index += 1) {
        const char = scanSource.charAt(index - scanOffset);
        if (char === "<" || char === "`") {
          special = index;
          break;
        }
      }
      const end = special === -1 ? limit : special;
      if (special !== -1 && source.charAt(special) === "`") {
        heldBacktickStart = special;
        holdStart = emitted;
        return;
      }
      const text = scanSource.slice(emitted - scanOffset, end - scanOffset);
      if (text) {
        merge(output, [{ kind: "text", text }]);
        if (text.trim()) {
          reduction.visibleEver = true;
        }
        emitted = end;
      }
      if (special === -1) {
        return;
      }
      const tail = source.slice(special, limit);
      const parsed = parseReasoningTagAt(tail, 0, false);
      if (parsed.kind === "invalid") {
        merge(output, [{ kind: "text", text: "<" }]);
        reduction.visibleEver = true;
        emitted = special + 1;
        continue;
      }
      holdStart = special;
      if (parsed.kind === "pending") {
        startPendingTagProbe(special, limit);
        return;
      }

      if (/[\r\n]/u.test(source.slice(blockStart, special))) {
        return;
      }

      const fastPathInvalidated = /[\r\n`]/u.test(source.slice(fastPathCheckedThrough, special));
      if (!fastPathCodeSafe || fastPathInvalidated) {
        if (nonFinalFullParses >= 1) {
          return;
        }
        nonFinalFullParses += 1;
        const ownership = parseMarkdownOwnership(source.slice(0, limit));
        nonFinalCodeSpans = ownership.codeSpans;
        nonFinalCodeSpansEnd = limit;
        nonFinalOpenEndedCode = nonFinalCodeSpans.some(([, spanEnd]) => spanEnd === limit);
        nonFinalRetainStart = ownership.retainStart;
        fastPathCodeSafe =
          !source.slice(blockStart, special).includes("`") &&
          !isInsideCode(special, nonFinalCodeSpans);
      }
      if (!fastPathCodeSafe) {
        return;
      }

      const nextBacktick = source.indexOf("`", special);
      const nextCarriageReturn = source.indexOf("\r", special);
      const nextLineFeed = source.indexOf("\n", special);
      const boundaries = [nextBacktick, nextCarriageReturn, nextLineFeed].filter(
        (index) => index !== -1 && index < limit,
      );
      const safeLimit = boundaries.length > 0 ? Math.min(...boundaries) : limit;
      reduceSafePrefix(special, safeLimit, limit, output);
    }
  };

  const processBlock = (
    end: number,
    final: boolean,
    output: ReasoningTagTextDelta[],
    parsedCodeSpans?: Array<[number, number]>,
    parsedRetainStart?: number,
    recoverUnclosed = true,
  ): void => {
    const previousBlockStart = blockStart;
    let blockCodeSpans = parsedCodeSpans;
    let blockRetainStart = parsedRetainStart;
    const finalizePending = () => {
      if (!final || reduction.depth === 0) {
        return;
      }
      merge(
        output,
        reduce("", [], reduction, {
          final: true,
          recoverUnclosed,
          mode: strictMode ? "hide" : "visible",
          scope: "all",
        }),
      );
    };
    if (end <= blockStart) {
      finalizePending();
      return;
    }
    if (end <= emitted) {
      finalizePending();
      blockStart = end;
      fastPathCheckedThrough = Math.max(fastPathCheckedThrough, end);
      return;
    }
    emitSafePrefix(end, output);
    if (holdStart !== undefined && holdStart < end) {
      const held = source.slice(holdStart, end);
      if (!final) {
        if (pendingTagProbe && !pendingTagProbe.resolved) {
          return;
        }
        pendingTagProbe = undefined;
        // Only the internal live consumer changes this decision. Public push/flush
        // keep their prior release schedule, including the conservative raw probe.
        if (live && !blockCodeSpans) {
          const ownership = parseMarkdownOwnership(source.slice(0, end));
          blockCodeSpans = ownership.codeSpans;
          blockRetainStart = ownership.retainStart;
        }
        const pendingStart = live
          ? scanStableReasoningTags(source.slice(0, end), blockCodeSpans ?? [], holdStart, false)
              .pendingStart
          : scanReasoningTags(held, false).pendingStart;
        if (pendingStart !== undefined) {
          startPendingTagProbe(live ? pendingStart : holdStart + pendingStart, end);
          return;
        }
      }
      const block = source.slice(0, end);
      const start = holdStart;
      if (!blockCodeSpans) {
        const ownership = parseMarkdownOwnership(block);
        blockCodeSpans = ownership.codeSpans;
        blockRetainStart = ownership.retainStart;
      }
      merge(
        output,
        reduce(block, blockCodeSpans, reduction, {
          final,
          recoverUnclosed,
          mode: strictMode ? "hide" : "visible",
          scope: "all",
          start,
        }),
      );
      emitted = end;
    } else if (emitted < end) {
      const text = source.slice(emitted, end);
      merge(output, [{ kind: "text", text }]);
      if (text.trim()) {
        reduction.visibleEver = true;
      }
      emitted = end;
    }
    finalizePending();
    const processedText = source.slice(previousBlockStart, end);
    const lastLineStart =
      Math.max(
        source.lastIndexOf("\n", Math.max(0, end - 1)),
        source.lastIndexOf("\r", Math.max(0, end - 1)),
      ) + 1;
    const crossedLineBoundary = /[\r\n]/u.test(processedText);
    blockStart = crossedLineBoundary && lastLineStart < end ? lastLineStart : end;
    holdStart = strictMode || reduction.depth > 0 ? end : undefined;
    heldBacktickStart = undefined;
    if (reduction.depth === 0) {
      nonFinalCloseReparseUsed = false;
    }
    pendingTagProbe = undefined;
    fastPathCheckedThrough = end;
    fastPathCodeSafe =
      !final &&
      !crossedLineBoundary &&
      emitted === source.length &&
      !blockCodeSpans?.some(([, spanEnd]) => spanEnd === source.length);
    if (
      !final &&
      reduction.depth === 0 &&
      emitted === source.length &&
      endedBlankBlock &&
      !MARKDOWN_CONTAINER_LINE_RE.test(source.slice(blockRetainStart ?? 0)) &&
      !blockCodeSpans?.some(([, spanEnd]) => spanEnd === source.length)
    ) {
      // A blank-terminated top-level block cannot gain code ownership from later input.
      // Drop it so block-incremental parsing stays bounded; containers retain their prefix.
      compactCommittedSource(blockRetainStart ?? 0);
    }
  };

  const consume = (appended: string, strict: boolean, final: boolean, recoverUnclosed = true) => {
    strictMode ||= strict;
    const previousEndedBlankBlock = endedBlankBlock;
    source += appended;
    if (live && (appended.includes("`") || appended.includes("~"))) {
      liveCodeProbe = true;
    }
    if (appended) {
      endedBlankBlock =
        (appended.endsWith("\n") || appended.endsWith("\r")) && endsBlankBlock(source);
    }
    const appendedBlock = appended.replace(/^(?:\r\n|\r|\n)+/u, "");
    const appendedStartsTopLevelBlock =
      previousEndedBlankBlock &&
      /^[^\t \r\n]/u.test(appendedBlock) &&
      !MARKDOWN_CONTAINER_LINE_RE.test(appendedBlock);
    if (pendingTagProbe && !pendingTagProbe.resolved) {
      advancePendingTagProbe(pendingTagProbe, source.slice(pendingTagProbe.scannedThrough));
      pendingTagProbe.scannedThrough = source.length;
      if (!pendingTagProbe.nameResolved) {
        const name = parseReasoningTagName(source, pendingTagProbe.start);
        pendingTagProbe.nameResolved = name.kind === "name";
        pendingTagProbe.resolved ||= name.kind === "invalid";
      }
    }
    if (pendingTagProbe?.resolved && holdStart !== undefined) {
      pendingTagProbe = undefined;
      holdStart = undefined;
      heldBacktickStart = undefined;
    }
    const output: ReasoningTagTextDelta[] = [];
    if (final) {
      processBlock(source.length, true, output, undefined, undefined, recoverUnclosed);
    } else {
      emitSafePrefix(source.length, output, appended);
      // Inside reasoning, literal-only appends cannot request an ownership parse.
      // Skip line/table lookahead too: the retained line can grow across many chunks.
      const needsHeldLookahead =
        !live ||
        !appended ||
        reduction.depth === 0 ||
        pendingTagProbe !== undefined ||
        liveCodeProbe ||
        /[<>\r\n]/u.test(appended);
      if (
        needsHeldLookahead &&
        !strictMode &&
        holdStart !== undefined &&
        holdStart < source.length
      ) {
        if (live && source.charAt(advanceLiteralTail()) === "`") {
          heldBacktickStart = literalEnd;
        }
        const ownershipStart = heldBacktickStart ?? holdStart;
        const heldLineStart =
          Math.max(
            source.lastIndexOf("\n", Math.max(0, ownershipStart - 1)),
            source.lastIndexOf("\r", Math.max(0, ownershipStart - 1)),
          ) + 1;
        const heldLineEnd = findNextLineEnding(source, ownershipStart);
        const heldLine = source.slice(
          heldLineStart,
          heldLineEnd === -1 ? source.length : heldLineEnd,
        );
        const tableLookaheadPending =
          heldLine.includes("|") &&
          (heldLineEnd === -1 ||
            findNextLineEnding(
              source,
              heldLineEnd +
                (source.charAt(heldLineEnd) === "\r" && source.charAt(heldLineEnd + 1) === "\n"
                  ? 2
                  : 1),
            ) === -1);
        const completedBlankBlock = endedBlankBlock;
        const heldBacktick = heldBacktickStart !== undefined;
        let openingRunEnd = ownershipStart;
        while (source.charAt(openingRunEnd) === "`") {
          openingRunEnd += 1;
        }
        const hasLaterBacktick =
          !heldBacktick ||
          ((!live || (liveCodeProbe && !tableLookaheadPending)) &&
            source.includes("`", openingRunEnd));
        const terminatedBacktickTail = !heldBacktick || source.at(-1) !== "`";
        // This only schedules the canonical parser; it does not decide code ownership.
        const liveCodeReady =
          live &&
          liveCodeProbe &&
          !pendingTagProbe &&
          !tableLookaheadPending &&
          source.at(-1) !== "`" &&
          source.at(-1) !== "~";
        const liveParseRequested =
          liveCodeReady || (live && !pendingTagProbe && /[<>]/u.test(appended));
        const shouldTryParser =
          liveParseRequested ||
          (pendingTagProbe
            ? pendingTagProbe.resolved
            : reduction.depth > 0
              ? appended.includes("<")
              : !heldBacktick ||
                (hasLaterBacktick && terminatedBacktickTail) ||
                completedBlankBlock);
        const mayResolveHeldReasoning =
          reduction.depth > 0 &&
          !nonFinalCloseReparseUsed &&
          (appended.includes("<") || appended.includes(">")) &&
          scanReasoningTags(source.slice(holdStart), false).tags.some((tag) => tag.isClose);
        const reusableCodeSpans =
          nonFinalCodeSpansEnd === source.length ? nonFinalCodeSpans : undefined;
        const mayCloseTopLevelBlock =
          completedBlankBlock &&
          !nonFinalOpenEndedCode &&
          (appendedStartsTopLevelBlock ||
            !MARKDOWN_CONTAINER_LINE_RE.test(source.slice(nonFinalRetainStart)));
        if (
          (shouldTryParser || mayResolveHeldReasoning) &&
          !tableLookaheadPending &&
          (reusableCodeSpans !== undefined ||
            nonFinalFullParses < 1 ||
            mayCloseTopLevelBlock ||
            mayResolveHeldReasoning ||
            liveParseRequested)
        ) {
          if (liveCodeReady) {
            liveCodeProbe = false;
          }
          if (!reusableCodeSpans) {
            nonFinalFullParses += 1;
          }
          const ownership = reusableCodeSpans ? undefined : parseMarkdownOwnership(source);
          nonFinalCloseReparseUsed ||= mayResolveHeldReasoning;
          const codeSpans = reusableCodeSpans ?? ownership?.codeSpans ?? [];
          const retainStart = reusableCodeSpans
            ? nonFinalRetainStart
            : (ownership?.retainStart ?? 0);
          nonFinalRetainStart = retainStart;
          nonFinalOpenEndedCode = codeSpans.some(([, spanEnd]) => spanEnd === source.length);
          const heldCodeSpan = codeSpans.find(
            ([start, end]) => ownershipStart >= start && ownershipStart < end,
          );
          const heldInOpenEndedCode = heldCodeSpan?.[1] === source.length;
          const stableCode = heldCodeSpan !== undefined && !heldInOpenEndedCode;
          const stableNonDelimiter =
            heldBacktick && heldCodeSpan === undefined && completedBlankBlock;
          if ((!heldBacktick && !heldInOpenEndedCode) || stableCode || stableNonDelimiter) {
            let processEnd = source.length;
            if (stableNonDelimiter || mayCloseTopLevelBlock) {
              processEnd = source.length;
            } else if (stableCode && heldCodeSpan) {
              processEnd = heldCodeSpan[1];
              while (processEnd < source.length) {
                const char = source.charAt(processEnd);
                if (char === "\r" || char === "\n" || char === "<" || char === "`") {
                  break;
                }
                processEnd += 1;
              }
            } else {
              const nextBacktick = source.indexOf("`", holdStart);
              if (nextBacktick !== -1) {
                processEnd = nextBacktick;
              }
            }
            if (processEnd > holdStart) {
              const stableTagSuffix =
                processEnd < source.length &&
                source.charAt(processEnd) === "<" &&
                !isInsideCode(processEnd, codeSpans);
              processBlock(processEnd, false, output, codeSpans, retainStart);
              if (stableTagSuffix) {
                fastPathCodeSafe = true;
                fastPathCheckedThrough = processEnd;
                emitSafePrefix(source.length, output);
              }
            }
          }
        }
      }
      if (
        holdStart === undefined &&
        reduction.depth === 0 &&
        emitted === source.length &&
        endedBlankBlock &&
        (!MARKDOWN_CONTAINER_LINE_RE.test(source.slice(nonFinalRetainStart)) ||
          appendedStartsTopLevelBlock) &&
        nonFinalFullParses < 1
      ) {
        nonFinalFullParses += 1;
        const ownership = parseMarkdownOwnership(source);
        const codeSpans = ownership.codeSpans;
        nonFinalRetainStart = ownership.retainStart;
        nonFinalOpenEndedCode = codeSpans.some(([, spanEnd]) => spanEnd === source.length);
        if (!nonFinalOpenEndedCode) {
          compactCommittedSource(ownership.retainStart);
        }
      }
    }
    if (final) {
      compactCommittedSource(source.length);
    }
    return output;
  };

  const partitioner: ReasoningTagTextPartitioner = {
    markStrict() {
      strictMode = true;
      holdStart ??= emitted;
    },
    push(chunk) {
      return consume(chunk, true, false);
    },
    pushVisible(chunk) {
      return consume(chunk, false, false);
    },
    flush(options) {
      return consume("", strictMode, true, options?.recoverUnclosed);
    },
    hasPending() {
      return (
        (holdStart !== undefined && holdStart < source.length) ||
        reduction.depth > 0 ||
        emitted < source.length
      );
    },
    hasPendingSyntax() {
      return (
        pendingTagProbe !== undefined || heldBacktickStart !== undefined || reduction.depth > 0
      );
    },
    isInsideReasoning() {
      return reduction.depth > 0;
    },
  };
  return {
    partitioner,
    appendThinking(this: void, chunk: string): string {
      for (const part of consume(chunk, false, false)) {
        if (part.kind === "thinking") {
          completedThinking += part.text;
        }
      }
      const closed = completedThinking.trim();
      const pending = reduction.pending;
      if (closed || !pending || pending.containsPrivate) {
        return closed;
      }
      // No ownership transition is committed by this view. Newlines and plain
      // continuation text are safe while a tag/backtick-free tail stays literal.
      const end = advanceLiteralTail();
      return (pending.content + source.slice(emitted, end)).trim();
    },
  };
}

export function createLegacyReasoningTagTextPartitioner(): ReasoningTagTextPartitioner {
  return createReasoningTagStreamOwner(false).partitioner;
}

/** Source-internal entry point: deliberately absent from package and AI barrels. */
export function createLiveReasoningTagStream() {
  const owner = createReasoningTagStreamOwner(true);
  return { append: owner.appendThinking };
}
