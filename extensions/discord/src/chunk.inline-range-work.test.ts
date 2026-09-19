import { expectDefined, isRecord } from "@openclaw/normalization-core";
import * as textChunking from "openclaw/plugin-sdk/text-chunking";
import { expect, it, vi } from "vitest";
import { chunkDiscordTextWithMode } from "./chunk.js";

it("bounds inline range queries while preserving every Discord message", () => {
  const lines = Array.from({ length: 1_000 }, (_, index) => `\`code-${index}\``);
  const source = lines.join("\n");
  let spanVisits = 0;
  let prefixReads = 0;
  let instrumentedSpans = 0;
  const prefixes = new Map<object, PropertyDescriptor>();
  const isInlineSpanArray = (values: unknown[]) => {
    const first = values[0];
    return (
      isRecord(first) &&
      typeof first.atomicTicks === "boolean" &&
      typeof first.base === "number" &&
      typeof first.marker === "string" &&
      isRecord(first.code)
    );
  };
  // Delegate native operations with their original receivers; only count the chunker's spans.
  const nativeSome = Array.prototype.some;
  const nativeIterator = Array.prototype[Symbol.iterator];
  const iteratorDescriptor = expectDefined(
    Object.getOwnPropertyDescriptor(Array.prototype, Symbol.iterator),
    "native array iterator descriptor",
  );
  const findCodeRegions = textChunking.findCodeRegions;
  let chunks: string[] = [];
  const someSpy = vi.spyOn(Array.prototype, "some").mockImplementation(function (
    this: unknown[],
    predicate: (value: unknown, index: number, array: unknown[]) => unknown,
    receiver?: unknown,
  ) {
    if (!isInlineSpanArray(this)) {
      return nativeSome.call(this, predicate, receiver);
    }
    return nativeSome.call(this, (value, index, array) => {
      spanVisits += 1;
      return predicate.call(receiver, value, index, array);
    });
  });
  let restoreRegions: (() => void) | undefined;
  try {
    const regionSpy = vi.spyOn(textChunking, "findCodeRegions");
    restoreRegions = () => regionSpy.mockRestore();
    // Measure native iteration without adding a production instrumentation hook; restore in finally.
    // oxlint-disable-next-line no-extend-native
    Object.defineProperty(Array.prototype, Symbol.iterator, {
      ...iteratorDescriptor,
      *value(this: unknown[]) {
        const measured = isInlineSpanArray(this);
        for (const value of nativeIterator.call(this)) {
          if (measured) {
            spanVisits += 1;
          }
          yield value;
        }
      },
    });
    regionSpy.mockImplementation((...args) => {
      const regions = findCodeRegions(...args);
      for (const region of regions) {
        if (region.block || !region.source) {
          continue;
        }
        instrumentedSpans += 1;
        const prefix = region.source.prefix;
        if (prefixes.has(prefix)) {
          continue;
        }
        const descriptor = expectDefined(
          Object.getOwnPropertyDescriptor(prefix, "end"),
          "parser prefix end descriptor",
        );
        const end = prefix.end;
        prefixes.set(prefix, descriptor);
        Object.defineProperty(prefix, "end", {
          configurable: descriptor.configurable,
          enumerable: descriptor.enumerable,
          get() {
            prefixReads += 1;
            return end;
          },
        });
      }
      return regions;
    });
    chunks = chunkDiscordTextWithMode(source, {
      maxChars: 2_000,
      maxLines: 1,
      chunkMode: "length",
    });
  } finally {
    restoreRegions?.();
    someSpy.mockRestore();
    // oxlint-disable-next-line no-extend-native -- Restore the exact descriptor captured above.
    Object.defineProperty(Array.prototype, Symbol.iterator, iteratorDescriptor);
    for (const [prefix, descriptor] of prefixes) {
      Object.defineProperty(prefix, "end", descriptor);
    }
  }
  expect(chunks).toEqual(lines);
  expect(instrumentedSpans).toBe(lines.length);
  expect.soft(spanVisits, "inline span visits").toBeLessThanOrEqual(32 * lines.length);
  expect(prefixReads, "container prefix reads").toBeLessThanOrEqual(
    4 * lines.length * (Math.ceil(Math.log2(lines.length + 1)) + 1),
  );
});
