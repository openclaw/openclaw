import { describe, expect, it } from "vitest";
import { responseStreamChunkByteLength } from "./attempt.model-diagnostic-byte-length.js";

function expectedBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function addUnreadablePartial(chunk: Record<PropertyKey, unknown>): void {
  Object.defineProperty(chunk, "partial", {
    configurable: true,
    enumerable: true,
    get() {
      throw new Error("partial snapshot should not be read");
    },
  });
}

describe("responseStreamChunkByteLength", () => {
  it("counts scalar data without reading partial or JSON-unsupported fields", () => {
    const chunk: Record<string, unknown> = {
      type: "metadata",
      value: "kept",
      ignoredUndefined: undefined,
      ignoredFunction: () => "ignored",
    };
    addUnreadablePartial(chunk);

    expect(responseStreamChunkByteLength(chunk)).toBe(
      expectedBytes({ type: "metadata", value: "kept" }),
    );
  });

  it("passes object-property keys to nested toJSON methods", () => {
    const keys: string[] = [];
    const chunk: Record<string, unknown> = {
      type: "metadata",
      value: {
        toJSON(key: string) {
          keys.push(key);
          return { key };
        },
      },
    };
    addUnreadablePartial(chunk);

    expect(responseStreamChunkByteLength(chunk)).toBe(
      expectedBytes({ type: "metadata", value: { key: "value" } }),
    );
    expect(keys).toEqual(["value"]);
  });

  it("passes object-property keys to BigInt toJSON methods", () => {
    const originalToJson = Object.getOwnPropertyDescriptor(BigInt.prototype, "toJSON");
    const keys: string[] = [];
    try {
      // eslint-disable-next-line no-extend-native -- Scoped test patch restored below.
      Object.defineProperty(BigInt.prototype, "toJSON", {
        configurable: true,
        value(key: string) {
          keys.push(key);
          return `${key}-bigint`;
        },
      });
      const chunk: Record<string, unknown> = { type: "metadata", value: 1n };
      addUnreadablePartial(chunk);

      expect(responseStreamChunkByteLength(chunk)).toBe(
        expectedBytes({ type: "metadata", value: "value-bigint" }),
      );
      expect(keys).toEqual(["value"]);
    } finally {
      if (originalToJson) {
        // eslint-disable-next-line no-extend-native -- Restore the original descriptor.
        Object.defineProperty(BigInt.prototype, "toJSON", originalToJson);
      } else {
        Reflect.deleteProperty(BigInt.prototype, "toJSON");
      }
    }
  });

  it.each(["own", "inherited"] as const)(
    "ignores %s non-enumerable toJSON like object rest",
    (placement) => {
      let calls = 0;
      const toJSON = () => {
        calls += 1;
        return { changed: true };
      };
      const prototype = placement === "inherited" ? { toJSON } : Object.prototype;
      const chunk = Object.assign(Object.create(prototype), {
        type: "metadata",
        value: "kept",
      }) as Record<string, unknown>;
      if (placement === "own") {
        Object.defineProperty(chunk, "toJSON", { value: toJSON });
      } else {
        Object.defineProperty(prototype, "toJSON", { enumerable: false, value: toJSON });
      }
      addUnreadablePartial(chunk);

      expect(responseStreamChunkByteLength(chunk)).toBe(
        expectedBytes({ type: "metadata", value: "kept" }),
      );
      expect(calls).toBe(0);
    },
  );

  it("copies own enumerable toJSON onto the snapshotless object", () => {
    let receiverWasOriginal = false;
    let receiverHadPartial = true;
    const chunk: Record<string, unknown> = {
      type: "metadata",
      value: "kept",
      toJSON(this: Record<string, unknown>) {
        receiverWasOriginal = this === chunk;
        receiverHadPartial = Object.hasOwn(this, "partial");
        return { value: this.value, hasPartial: receiverHadPartial };
      },
    };
    addUnreadablePartial(chunk);

    expect(responseStreamChunkByteLength(chunk)).toBe(
      expectedBytes({ value: "kept", hasPartial: false }),
    );
    expect(receiverWasOriginal).toBe(false);
    expect(receiverHadPartial).toBe(false);
  });

  it("reads enumerable accessors with the source object as receiver", () => {
    const symbol = Symbol("metadata");
    let stringReceiverWasSource = false;
    let symbolReceiverWasSource = false;
    const chunk = { type: "metadata" } as Record<PropertyKey, unknown>;
    Object.defineProperty(chunk, "value", {
      enumerable: true,
      get(this: Record<PropertyKey, unknown>) {
        stringReceiverWasSource = this === chunk;
        return "kept";
      },
    });
    Object.defineProperty(chunk, symbol, {
      enumerable: true,
      get(this: Record<PropertyKey, unknown>) {
        symbolReceiverWasSource = this === chunk;
        return "ignored by JSON";
      },
    });
    addUnreadablePartial(chunk);

    expect(responseStreamChunkByteLength(chunk)).toBe(
      expectedBytes({ type: "metadata", value: "kept" }),
    );
    expect(stringReceiverWasSource).toBe(true);
    expect(symbolReceiverWasSource).toBe(true);
  });

  it("preserves own __proto__ data keys without mutating Object.prototype", () => {
    const chunk = Object.assign(Object.create(null), {
      type: "metadata",
      value: "kept",
      partial: "ignored",
    }) as Record<string, unknown>;
    Object.defineProperty(chunk, "__proto__", {
      enumerable: true,
      value: { marker: "data-key" },
    });
    const expected = Object.assign(Object.create(null), {
      type: "metadata",
      value: "kept",
    }) as Record<string, unknown>;
    Object.defineProperty(expected, "__proto__", {
      enumerable: true,
      value: { marker: "data-key" },
    });

    expect(responseStreamChunkByteLength(chunk)).toBe(expectedBytes(expected));
    expect((Object.prototype as Record<string, unknown>).marker).toBeUndefined();
  });

  it("returns undefined instead of breaking the stream for opaque chunks", () => {
    const chunk = new Proxy(
      {},
      {
        has() {
          throw new Error("opaque chunk");
        },
      },
    );

    expect(responseStreamChunkByteLength(chunk)).toBeUndefined();
  });
});
