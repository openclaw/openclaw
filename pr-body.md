Consolidates multiple inconsistent implementations of `stableStringify` across the `src/agents/` directory into a single canonical version in `src/agents/stable-stringify.ts`.

Key improvements:

- Centralizes logic for handling Circular references, `Error` objects, and `BigInt`.
- Removes redundant copies from `cache-trace.ts`, `models-config.ts`, and `tool-loop-detection.ts`.
- Ensures consistent hashing and tracing behavior across the agent subsystem.

## Real behavior proof (required for external PRs)

Tested with a comprehensive proof script handling complex objects, circular references, and diverse types:

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
