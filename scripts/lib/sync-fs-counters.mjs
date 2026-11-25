import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";

export function countSyncFsCalls(names, count) {
  const originals = new Map();
  for (const name of names) {
    const original = fs[name];
    originals.set(name, original);
    const wrapped = (...args) => {
      count(name);
      return original(...args);
    };
    if (original.native) {
      wrapped.native = (...args) => {
        count(`${name}.native`);
        return original.native(...args);
      };
    }
    fs[name] = wrapped;
  }
  syncBuiltinESMExports();
  return () => {
    for (const [name, original] of originals) {
      fs[name] = original;
    }
    syncBuiltinESMExports();
  };
}
