import { stableStringify } from "./src/agents/stable-stringify.js";

const circular = { a: 1 };
circular.self = circular;

const complex = {
  bigint: BigInt(123),
  error: new Error("test error"),
  uint8: new Uint8Array([1, 2, 3]),
  array: [1, 2, { b: 3 }],
  object: { c: 4, a: 5 }, // keys should be sorted
  circular,
  nested: {
    nan: NaN,
    inf: Infinity,
    nil: null,
    undef: undefined,
  },
};

console.log("Testing stableStringify with complex object:");
const result = stableStringify(complex);
console.log(result);

// Verify sorting
const obj1 = { a: 1, b: 2 };
const obj2 = { b: 2, a: 1 };
console.log("\nVerifying key sorting:");
console.log("obj1:", stableStringify(obj1));
console.log("obj2:", stableStringify(obj2));
console.log("Equal:", stableStringify(obj1) === stableStringify(obj2));

// Verify Circular
console.log("\nVerifying circular reference handling:");
console.log(stableStringify(circular));
