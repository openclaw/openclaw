import { readFileSync } from "node:fs";
export const wasmBytes = readFileSync(
  new URL("../../../.openclaw/tmp/wasm-base64-experiment/scan.wasm", import.meta.url),
);
export function createScanner(module = new WebAssembly.Module(wasmBytes)) {
  if (WebAssembly.Module.imports(module).length) {
    throw new Error("Unexpected host imports");
  }
  const exports = new WebAssembly.Instance(module).exports;
  // oxlint-disable-next-line eslint/no-underscore-dangle -- Exact WASM linker export, not a JS naming choice.
  const pointer = Number(exports.__heap_base.value);
  const encoder = new TextEncoder();
  return {
    memory: exports.memory,
    exports,
    inspectBase64: (input, dialect) => {
      if (dialect === "attachment" && (!input.length || input.length % 4)) {
        return undefined;
      }
      if (!input.length) {
        return undefined;
      }
      // UTF-8 needs at most three bytes per UTF-16 unit. The common ASCII path
      // reserves only one; an incomplete encode rejects non-ASCII invalid data.
      const required = pointer + input.length;
      if (required > 64 * 1024 * 1024) {
        throw new RangeError("Experimental scanner size cap");
      }
      const grow = Math.ceil((required - exports.memory.buffer.byteLength) / 65536);
      if (grow > 0) {
        exports.memory.grow(grow);
      }
      const view = new Uint8Array(exports.memory.buffer, pointer, input.length);
      const encoded = encoder.encodeInto(input, view);
      if (encoded.read !== input.length) {
        return undefined;
      }
      const result = exports.scan(pointer, encoded.written, Number(dialect === "attachment"));
      if (result < 0) {
        return undefined;
      }
      const flags = result % 4;
      // oxlint-disable-next-line eslint/no-control-regex -- Canonical dialect explicitly ignores ASCII controls and space.
      const cleaned = flags & 1 ? input.replace(/[\x00-\x20]/gu, "") : input;
      const remainder = cleaned.length % 4;
      return {
        base64: remainder ? cleaned + "=".repeat(4 - remainder) : cleaned,
        decodedBytes: Math.floor(result / 4) - 1,
        canonicalPadBits: Boolean(flags & 2),
      };
    },
  };
}
