import { createHash } from "node:crypto";
import { CODE_MODE_CONTROLLER_SOURCE } from "openclaw/plugin-sdk/code-mode-executor-runtime";
import { Intrinsics, type QuickJS } from "quickjs-wasi";
import { CodeModeWorkerFailure } from "./worker-failure.js";
import type { QuickJsWorkerPayload, QuickJsDeterministicState } from "./worker-types.js";

// Bump this ABI when worker scheduling/source-wrapping semantics change replay.
const REPLAY_ABI = "quickjs-deterministic-v1";

export const DETERMINISTIC_SOURCE = String.raw`
(() => {
  const { seed, startedAt } = globalThis.__openclawDeterministicInput;
  const now = globalThis.__openclawDeterministicNow;
  delete globalThis.__openclawDeterministicInput;
  delete globalThis.__openclawDeterministicNow;
  // Mulberry32 keeps all random state in the snapshotted guest, including seed 0.
  let state = seed >>> 0;
  const imul = Math.imul;
  Object.defineProperty(Math, "random", { configurable: true, writable: true, value: () => {
    state = (state + 0x6d2b79f5) | 0;
    let value = imul(state ^ (state >>> 15), state | 1);
    value ^= value + imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  } });
  // Date uses the WASI clock; performance is elapsed virtual time, not host uptime.
  Object.defineProperty(globalThis, "performance", { configurable: true, value: Object.freeze({ now: () => now() - startedAt }) });
})();
`;

export function fingerprintQuickJsAssets(assets: readonly Uint8Array[]): string {
  const hash = createHash("sha256");
  for (const asset of assets) {
    hash.update(String(asset.byteLength)).update(":").update(asset);
  }
  return hash.digest("hex");
}

export function deterministicFingerprint(
  engineFingerprint: string,
  versions: Record<string, string>,
): string {
  const digest = createHash("sha256")
    .update(
      JSON.stringify([
        engineFingerprint,
        Object.entries(versions).sort(),
        CODE_MODE_CONTROLLER_SOURCE,
        DETERMINISTIC_SOURCE,
      ]),
    )
    .digest("hex");
  return `${REPLAY_ABI}:${digest}`;
}

/** Own the deterministic clock, VM intrinsics and fingerprint as one environment. */
export function createDeterministicEnvironment(input: QuickJsWorkerPayload) {
  const requested = input.kind === "exec" ? input.deterministic : undefined;
  if (
    requested &&
    (!Number.isSafeInteger(requested.startedAt) ||
      requested.startedAt < 0 ||
      requested.startedAt > 8_640_000_000_000_000 ||
      !Number.isInteger(requested.seed) ||
      requested.seed < 0 ||
      requested.seed > 0xffff_ffff)
  ) {
    throw new CodeModeWorkerFailure(
      "invalid_input",
      "invalid deterministic start time or seed",
      "input",
    );
  }
  const state: QuickJsDeterministicState | undefined =
    input.kind === "resume"
      ? input.continuation.deterministic
      : requested && {
          startedAt: requested.startedAt,
          timeMs: requested.startedAt,
          fingerprint: "",
        };
  return {
    state,
    options: state
      ? {
          intrinsics: Intrinsics.ALL & ~Intrinsics.WEAK_REF & ~Intrinsics.PERFORMANCE,
          wasi: (memory: WebAssembly.Memory) => ({
            clock_time_get: (clockId: number, _precision: bigint, resultPtr: number) => {
              if (clockId !== 0 && clockId !== 1) {
                return 52; // WASI ENOSYS, matching the engine's default shim.
              }
              new DataView(memory.buffer).setBigUint64(
                resultPtr,
                BigInt(state.timeMs) * 1_000_000n,
                true,
              );
              return 0;
            },
            // Only the pure encoding extension is loaded. Guest Math.random has its
            // own snapshotted seed; keep WASI/libc initialization deterministic too.
            random_get: (ptr: number, length: number) => {
              new Uint8Array(memory.buffer, ptr, length).fill(0);
              return 0;
            },
          }),
        }
      : {},
    initialize(vm: QuickJS) {
      if (!state) {
        return;
      }
      const fingerprint = deterministicFingerprint(input.engineFingerprint, vm.versions);
      const expected = input.kind === "resume" ? state.fingerprint : requested?.fingerprint;
      if (expected !== undefined && expected !== fingerprint) {
        throw new CodeModeWorkerFailure(
          "runtime_unavailable",
          "deterministic QuickJS fingerprint mismatch; cannot replay this execution",
          "input",
        );
      }
      state.fingerprint = fingerprint;
      const now = () => vm.newNumber(state.timeMs);
      if (input.kind === "resume") {
        vm.registerHostCallback("__openclawDeterministicNow", now);
      } else {
        vm.newFunction("__openclawDeterministicNow", now).consume((handle) =>
          vm.global.setProp("__openclawDeterministicNow", handle),
        );
        vm.hostToHandle(requested).consume((handle) =>
          vm.global.setProp("__openclawDeterministicInput", handle),
        );
        vm.evalCode(DETERMINISTIC_SOURCE, "openclaw-code-mode:deterministic.js").dispose();
      }
    },
    advanceTime(timeMs: number | undefined) {
      if (timeMs === undefined) {
        return;
      }
      if (
        !state ||
        !Number.isSafeInteger(timeMs) ||
        timeMs < state.timeMs ||
        timeMs > 8_640_000_000_000_000
      ) {
        throw new CodeModeWorkerFailure(
          "invalid_input",
          "invalid or backwards deterministic time",
          "input",
        );
      }
      state.timeMs = timeMs;
    },
  };
}
