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
`@openclaw/ai/event-stream`, `@openclaw/ai/transports`, and
`@openclaw/ai/validation`. No second OpenClaw runtime package is required.

Provider ids, credentials, model catalogs, retries, and failover remain
application concerns. OpenClaw supplies those policies around this package.
Host policy (request fetch guarding, secret redaction, strict-tool defaults,
provider plugin hooks, and diagnostics logging) can be injected with
`configureAiTransportHost`; the defaults are inert. Node callers that need
runtime-local policy can use `createNodeLlmRuntime`; it preserves that host across
provider work without replacing the process default. `createLlmRuntime` continues
to use the process-default host.

Hosts that attach request state to async contexts should supply
`runInDetachedAsyncContext` from a context-free root initialized before requests
start. Retained HTTP continuation timers use it at creation so completed caller
state can be collected while the response remains reusable for 90 minutes.
The default host runs the callback directly, including in browsers.

The explicit `@openclaw/ai/internal/anthropic`, `google-model-family`, `openai`,
`openai-completions-compat`, `openai-responses-payload-policy`, `retry-after`, `runtime`, `shared`, and
`tool-schema` subpaths exist for the OpenClaw application itself.
They carry no semver guarantee and can change or disappear in any release; do
not depend on them outside OpenClaw.
