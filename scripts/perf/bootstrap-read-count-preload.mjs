// Count-only observer. No pathname probes, file writes, or production hooks.
import fs, { statSync as namedStatSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { getEnvironmentData, isMainThread } from "node:worker_threads";
const shared = getEnvironmentData("lane2424.bootstrap-read-metrics");
if (shared instanceof SharedArrayBuffer) {
  const counters = new BigInt64Array(shared);
  const offset = isMainThread ? 1 : 5;
  const pending = isMainThread ? 9 : 10;
  let calibrating = false;
  let calibrationHits = 0;
  const syncCall = () => {
    if (calibrating) {
      calibrationHits++;
      add(isMainThread ? 15 : 16);
    } else if (enabled()) {
      add(isMainThread ? 11 : 12);
    }
  };
  const enabled = () => Atomics.load(counters, 0) === 1n;
  const bounded = () => /[/\\]bounded-read\.js:/.test(new Error().stack ?? "");
  const add = (index, amount = 1) => Atomics.add(counters, index, BigInt(amount));
  const readDescriptor = Object.getOwnPropertyDescriptor(fs, "read");
  Object.defineProperty(fs, "read", {
    ...readDescriptor,
    value: new Proxy(readDescriptor.value, {
      apply(target, receiver, args) {
        if (!enabled() || !bounded()) {
          return Reflect.apply(target, receiver, args);
        }
        const callback = args.at(-1);
        if (typeof callback !== "function") {
          throw new Error("Unexpected bounded fs.read contract");
        }
        add(pending);
        const observed = [...args];
        observed[observed.length - 1] = function (error, bytesRead, ...rest) {
          add(offset);
          if (error) {
            add(offset + 3);
          } else {
            if (!Number.isSafeInteger(bytesRead) || bytesRead < 0) {
              throw new Error("Invalid bytesRead");
            }
            add(offset + 1, bytesRead);
            if (bytesRead === 0) {
              add(offset + 2);
            }
          }
          add(pending, -1);
          return Reflect.apply(callback, this, [error, bytesRead, ...rest]);
        };
        try {
          return Reflect.apply(target, receiver, observed);
        } catch (error) {
          add(pending, -1);
          throw error;
        }
      },
    }),
  });
  for (const name of Object.getOwnPropertyNames(fs)) {
    const descriptor = Object.getOwnPropertyDescriptor(fs, name);
    if (!name.endsWith("Sync") || typeof descriptor?.value !== "function") {
      continue;
    }
    Object.defineProperty(fs, name, {
      ...descriptor,
      value: new Proxy(descriptor.value, {
        apply(target, receiver, args) {
          const active = enabled();
          syncCall();
          const observedRead = active && name === "readSync" && bounded();
          try {
            const result = Reflect.apply(target, receiver, args);
            if (observedRead) {
              add(offset);
              add(offset + 1, result);
              if (!result) {
                add(offset + 2);
              }
            }
            return result;
          } catch (error) {
            if (observedRead) {
              add(offset);
              add(offset + 3);
            }
            throw error;
          }
        },
      }),
    });
  }
  const native = Object.getOwnPropertyDescriptor(fs.realpathSync, "native");
  if (typeof native?.value === "function") {
    Object.defineProperty(fs.realpathSync, "native", {
      ...native,
      value: new Proxy(native.value, {
        apply(target, receiver, args) {
          syncCall();
          return Reflect.apply(target, receiver, args);
        },
      }),
    });
  }
  syncBuiltinESMExports();
  const calibrationPath = getEnvironmentData("lane2424.bootstrap-read-calibration");
  if (typeof calibrationPath !== "string") {
    throw new Error("Synthetic calibration path missing");
  }
  const before = calibrationHits;
  calibrating = true;
  try {
    if (!namedStatSync(calibrationPath).isFile()) {
      throw new Error("Calibration file missing");
    }
    if (typeof fs.realpathSync.native(calibrationPath) !== "string") {
      throw new Error("Native calibration failed");
    }
  } finally {
    calibrating = false;
  }
  if (calibrationHits - before !== 2) {
    throw new Error("Named Sync export/native observer calibration mismatch");
  }
  add(isMainThread ? 13 : 14);
}
