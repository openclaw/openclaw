# `@openclaw/ai`

Reusable model API contracts, provider adapters, and streaming primitives from
OpenClaw. The package supports isolated runtime instances; importing it does not
register providers globally.

```ts
import { createLlmRuntime } from "@openclaw/ai";
import { registerBuiltInApiProviders } from "@openclaw/ai/providers";

const runtime = createLlmRuntime();
registerBuiltInApiProviders(runtime.registry);
```

Provider-neutral contracts, validation, diagnostics, and event streams are
available from the package root and focused subpaths such as
`@openclaw/ai/event-stream` and `@openclaw/ai/validation`. No second OpenClaw
runtime package is required.

Provider ids, credentials, model catalogs, retries, and failover remain
application concerns. OpenClaw supplies those policies around this package.
