# Pact.js Utils Overview

## Principle

Use production-ready utilities from `@seontechnologies/pactjs-utils` to eliminate boilerplate in consumer-driven contract testing. The library wraps `@pact-foundation/pact` with type-safe helpers for provider state creation, PactV4 JSON interaction builders, verifier configuration, and request filter injection — working equally well for HTTP and message (async/Kafka) contracts.

## Rationale

### Problems with raw @pact-foundation/pact

- **JsonMap casting**: Provider state parameters require `JsonMap` type — manually casting every value is error-prone and verbose
- **Repeated builder lambdas**: PactV4 interactions often repeat inline callbacks with `builder.query(...)`, `builder.headers(...)`, and `builder.jsonBody(...)`
- **Verifier configuration sprawl**: `VerifierOptions` requires 30+ lines of scattered configuration (broker URL, selectors, state handlers, request filters, version tags)
- **Environment variable juggling**: Different env vars for local vs remote flows, breaking change coordination, payload URL matching
- **Express middleware types**: Request filter requires Express types that aren't re-exported from Pact
- **Bearer prefix bugs**: Easy to double-prefix tokens as `Bearer Bearer ...` in request filters
- **CI version tagging**: Manual logic to extract branch/tag info from CI environment

### Solutions from pactjs-utils

- **`createProviderState`**: One-call tuple builder for `.given()` — handles all JsonMap conversion automatically
- **`toJsonMap`**: Explicit type coercion (null→"null", Date→ISO string, nested objects flattened)
- **`setJsonContent`**: Curried callback helper for PactV4 `.withRequest(...)` / `.willRespondWith(...)` builders (query/headers/body)
- **`setJsonBody`**: Body-only shorthand alias of `setJsonContent({ body })`
- **`buildVerifierOptions`**: Single function assembles complete VerifierOptions from minimal inputs — handles local/remote/BDCT flows
- **`buildMessageVerifierOptions`**: Same as above but for message/Kafka provider verification
- **`handlePactBrokerUrlAndSelectors`**: Resolves broker URL and consumer version selectors from env vars with breaking change awareness
- **`getProviderVersionTags`**: CI-aware version tagging (extracts branch/tag from GitHub Actions, GitLab CI, etc.)
- **`createRequestFilter`**: Pluggable token generator pattern — prevents double-Bearer bugs by contract
- **`noOpRequestFilter`**: Pass-through for providers that don't require auth injection

## Installation

```bash
npm install -D @seontechnologies/pactjs-utils

# Peer dependency
npm install -D @pact-foundation/pact
```

**Requirements**: `@pact-foundation/pact` >= 16.2.0, Node.js >= 18

## Available Utilities

| Category          | Function                          | Description                                          | Use Case                                                         |
| ----------------- | --------------------------------- | ---------------------------------------------------- | ---------------------------------------------------------------- |
| Consumer Helpers  | `createProviderState`             | Builds `[stateName, JsonMap]` tuple from typed input | Consumer tests: `.given(...createProviderState(input))`          |
| Consumer Helpers  | `toJsonMap`                       | Converts any object to Pact-compatible `JsonMap`     | Explicit type coercion for provider state params                 |
| Consumer Helpers  | `setJsonContent`                  | Curried request/response JSON callback helper        | PactV4 `.withRequest(...)` and `.willRespondWith(...)` builders  |
| Consumer Helpers  | `setJsonBody`                     | Body-only alias of `setJsonContent`                  | Body-only `.willRespondWith(...)` responses                      |
| Provider Verifier | `buildVerifierOptions`            | Assembles complete HTTP `VerifierOptions`            | Provider verification: `new Verifier(buildVerifierOptions(...))` |
| Provider Verifier | `buildMessageVerifierOptions`     | Assembles message `VerifierOptions`                  | Kafka/async provider verification                                |
| Provider Verifier | `handlePactBrokerUrlAndSelectors` | Resolves broker URL + selectors from env vars        | Env-aware broker configuration                                   |
| Provider Verifier | `getProviderVersionTags`          | CI-aware version tag extraction                      | Provider version tagging in CI                                   |
| Request Filter    | `createRequestFilter`             | Express middleware with pluggable token generator    | Auth injection for provider verification                         |
| Request Filter    | `noOpRequestFilter`               | Pass-through filter (no-op)                          | Providers without auth requirements                              |

## Decision Tree: Which Flow?

```
Is this a monorepo (consumer + provider in same repo)?
├── YES → Local Flow
│   - Consumer generates pact files to ./pacts/
│   - Provider reads pact files from ./pacts/ (no broker needed)
│   - Use buildVerifierOptions with pactUrls option
│
└── NO → Do you have a Pact Broker / PactFlow?
    ├── YES → Remote (CDCT) Flow
    │   - Consumer publishes pacts to broker
    │   - Provider verifies from broker
    │   - Use buildVerifierOptions with broker config
    │   - Set PACT_BROKER_BASE_URL + PACT_BROKER_TOKEN
    │
    └── Do you have an OpenAPI spec?
        ├── YES → BDCT Flow (PactFlow only)
        │   - Provider publishes OpenAPI spec to PactFlow
        │   - PactFlow cross-validates consumer pacts against spec
        │   - No provider verification test needed
        │
        └── NO → Start with Local Flow, migrate to Remote later
```

## Design Philosophy

1. **One-call setup**: Each utility does one thing completely — no multi-step assembly required
2. **Environment-aware**: Utilities read env vars for CI/CD integration without manual wiring
3. **Type-safe**: Full TypeScript types for all inputs and outputs, exported for consumer use
4. **Fail-safe defaults**: Sensible defaults that work locally; env vars override for CI
5. **Composable**: Utilities work independently — use only what you need

## Pattern Examples

### Example 1: Minimal Consumer Test

```typescript
import { PactV3 } from "@pact-foundation/pact";
import { createProviderState } from "@seontechnologies/pactjs-utils";

const provider = new PactV3({
  consumer: "my-frontend",
  provider: "my-api",
  dir: "./pacts",
});

it("should get user by id", async () => {
  await provider
    .given(...createProviderState({ name: "user exists", params: { id: 1 } }))
    .uponReceiving("a request for user 1")
    .withRequest({ method: "GET", path: "/users/1" })
    .willRespondWith({ status: 200, body: { id: 1, name: "John" } })
    .executeTest(async (mockServer) => {
      const res = await fetch(`${mockServer.url}/users/1`);
      expect(res.status).toBe(200);
    });
});
```

### Example 2: Minimal Provider Verification

```typescript
import { Verifier } from "@pact-foundation/pact";
import { buildVerifierOptions, createRequestFilter } from "@seontechnologies/pactjs-utils";

const opts = buildVerifierOptions({
  provider: "my-api",
  port: "3001",
  includeMainAndDeployed: true,
  stateHandlers: {
    "user exists": async (params) => {
      await db.seed({ users: [{ id: params?.id }] });
    },
  },
  requestFilter: createRequestFilter({
    tokenGenerator: () => "test-token-123",
  }),
});

await new Verifier(opts).verifyProvider();
```

## Key Points

- **Import path**: Always use `@seontechnologies/pactjs-utils` (no subpath exports)
- **Peer dependency**: `@pact-foundation/pact` must be installed separately
- **Local flow**: No broker needed — set `pactUrls` in verifier options pointing to local pact files
- **Remote flow**: Set `PACT_BROKER_BASE_URL` and `PACT_BROKER_TOKEN` env vars
- **Breaking changes**: Set `includeMainAndDeployed: false` when coordinating breaking changes (verifies only matchingBranch)
- **Builder helpers**: Use `setJsonContent` when you need query/headers/body together; use `setJsonBody` for body-only callbacks
- **Type exports**: Library exports `StateHandlers`, `RequestFilter`, `JsonMap`, `JsonContentInput`, `ConsumerVersionSelector` types

## Related Fragments

- `pactjs-utils-consumer-helpers.md` — detailed createProviderState, toJsonMap, setJsonContent, and setJsonBody usage
- `pactjs-utils-provider-verifier.md` — detailed buildVerifierOptions and broker configuration
- `pactjs-utils-request-filter.md` — detailed createRequestFilter and auth patterns
- `contract-testing.md` — foundational contract testing patterns (raw Pact.js approach)
- `test-levels-framework.md` — where contract tests fit in the testing pyramid

## Anti-Patterns

### Wrong: Manual VerifierOptions assembly when pactjs-utils is available

```typescript
// ❌ Don't assemble VerifierOptions manually
const opts: VerifierOptions = {
  provider: "my-api",
  providerBaseUrl: "http://localhost:3001",
  pactBrokerUrl: process.env.PACT_BROKER_BASE_URL,
  pactBrokerToken: process.env.PACT_BROKER_TOKEN,
  publishVerificationResult: process.env.CI === "true",
  providerVersion: process.env.GIT_SHA || "dev",
  consumerVersionSelectors: [{ mainBranch: true }, { deployedOrReleased: true }],
  stateHandlers: {
    /* ... */
  },
  requestFilter: (req, res, next) => {
    /* ... */
  },
  // ... 20 more lines
};
```

### Right: Use buildVerifierOptions

```typescript
// ✅ Single call handles all configuration
const opts = buildVerifierOptions({
  provider: "my-api",
  port: "3001",
  includeMainAndDeployed: true,
  stateHandlers: {
    /* ... */
  },
  requestFilter: createRequestFilter({ tokenGenerator: () => "token" }),
});
```

### Wrong: Importing raw Pact types for JsonMap conversion

```typescript
// ❌ Manual JsonMap casting
import type { JsonMap } from "@pact-foundation/pact";

provider.given("user exists", { id: 1 as unknown as JsonMap["id"] });
```

### Right: Use createProviderState

```typescript
// ✅ Automatic type conversion
import { createProviderState } from "@seontechnologies/pactjs-utils";

provider.given(...createProviderState({ name: "user exists", params: { id: 1 } }));
```

_Source: @seontechnologies/pactjs-utils library, pactjs-utils README, pact-js-example-provider workflows_
