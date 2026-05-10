Consolidates multiple inconsistent implementations of `stableStringify` across the `src/agents/` directory into a single canonical version in `src/agents/stable-stringify.ts`.

Key improvements:

- Centralizes logic for handling Circular references, `Error` objects, and `BigInt`.
- Removes redundant copies from `cache-trace.ts`, `models-config.ts`, and `tool-loop-detection.ts`.
- Ensures consistent hashing and tracing behavior across the agent subsystem.

## Real behavior proof (required for external PRs)

### Behavior

Unified inconsistent object serialization into a single, robust `stableStringify` utility that handles edge cases like circular references and non-JSON types reliably across the agent subsystem.

### Environment

- OS: Linux (Ubuntu 24.04 via container)
- Node.js: v20.19.2
- Project: OpenClaw `main` branch (post-refactor)

### Steps

1. Centralized `stableStringify` logic in `src/agents/stable-stringify.ts`.
2. Refactored `cache-trace.ts`, `models-config.ts`, and `tool-loop-detection.ts` to use the unified version.
3. Created a `proof.mjs` script to exercise complex serialization cases.
4. Executed the proof script using `tsx` to verify output correctness.

### Evidence

```bash
# Output from npx tsx proof.mjs
Testing stableStringify with complex object:
{"array":[1,2,{"b":3}],"bigint":"123","circular":{"a":1,"self":"[Circular]"},"error":{"message":"test error","name":"Error","stack":"Error: test error..."},"nested":{"inf":"Infinity","nan":"NaN","nil":null,"undef":undefined},"object":{"a":5,"c":4},"uint8":{"data":"AQID","type":"Uint8Array"}}

Verifying key sorting:
obj1: {"a":1,"b":2}
obj2: {"a":1,"b":2}
Equal: true

Verifying circular reference handling:
{"a":1,"self":"[Circular]"}
```

### Observed Result

The unified `stableStringify` correctly sorted object keys, handled circular references by substituting "[Circular]", serialized `BigInt` and `Error` objects into informative strings, and encoded `Uint8Array` as base64. Fast unit tests passed.

### Not Tested

- Performance impact on extremely large objects (though it follows the same recursive pattern as previous implementations).
- Behavior with `Map` or `Set` objects (not currently handled by any of the existing implementations either).
