# Pact.js Utils Provider Verifier

## Principle

Use `buildVerifierOptions`, `buildMessageVerifierOptions`, `handlePactBrokerUrlAndSelectors`, and `getProviderVersionTags` from `@seontechnologies/pactjs-utils` to assemble complete provider verification configuration in a single call. These utilities handle local/remote flow detection, broker URL resolution, consumer version selector strategy, and CI-aware version tagging. The caller controls breaking change behavior via the required `includeMainAndDeployed` parameter.

## Rationale

### Problems with manual VerifierOptions

- **30+ lines of scattered config**: Assembling `VerifierOptions` manually requires broker URL, token, selectors, state handlers, request filters, version info, publish flags — all in one object
- **Environment variable logic**: Different env vars for local vs remote, CI vs local dev, breaking change vs normal flow
- **Consumer version selector complexity**: Choosing between `mainBranch`, `deployedOrReleased`, `matchingBranch`, and `includeMainAndDeployed` requires understanding Pact Broker semantics
- **Breaking change coordination**: When a provider intentionally breaks a contract, manual selector switching is error-prone
- **Cross-execution protection**: `PACT_PAYLOAD_URL` webhook payloads need special handling to verify only the triggering pact

### Solutions

- **`buildVerifierOptions`**: Single function that reads env vars, selects the right flow, and returns complete `VerifierOptions`
- **`buildMessageVerifierOptions`**: Same as above for message/Kafka provider verification
- **`handlePactBrokerUrlAndSelectors`**: Pure function for broker URL + selector resolution (used internally, also exported for advanced use)
- **`getProviderVersionTags`**: Extracts CI branch/tag info from environment for provider version tagging

## Pattern Examples

### Example 1: HTTP Provider Verification (Remote Flow)

```typescript
import { Verifier } from "@pact-foundation/pact";
import { buildVerifierOptions, createRequestFilter } from "@seontechnologies/pactjs-utils";
import type { StateHandlers } from "@seontechnologies/pactjs-utils";

const stateHandlers: StateHandlers = {
  "movie with id 1 exists": {
    setup: async (params) => {
      await db.seed({ movies: [{ id: params?.id ?? 1, name: "Inception" }] });
    },
    teardown: async () => {
      await db.clean("movies");
    },
  },
  "no movies exist": async () => {
    await db.clean("movies");
  },
};

// buildVerifierOptions reads these env vars automatically:
// - PACT_BROKER_BASE_URL (broker URL)
// - PACT_BROKER_TOKEN (broker auth)
// - PACT_PAYLOAD_URL (webhook trigger — cross-execution protection)
// - PACT_BREAKING_CHANGE (if "true", uses includeMainAndDeployed selectors)
// - GITHUB_SHA (provider version)
// - CI (publish verification results if "true")

const opts = buildVerifierOptions({
  provider: "SampleMoviesAPI",
  port: "3001",
  includeMainAndDeployed: process.env.PACT_BREAKING_CHANGE !== "true",
  stateHandlers,
  requestFilter: createRequestFilter({
    tokenGenerator: () => process.env.TEST_AUTH_TOKEN ?? "test-token",
  }),
});

await new Verifier(opts).verifyProvider();
```

**Key Points**:

- Set `PACT_BROKER_BASE_URL` and `PACT_BROKER_TOKEN` as env vars — `buildVerifierOptions` reads them automatically
- `port` is a string (e.g., `'3001'`) — the function builds `providerBaseUrl: http://localhost:${port}` internally
- `includeMainAndDeployed` is **required** — set `true` for normal flow, `false` for breaking changes
- State handlers support both simple functions and `{ setup, teardown }` objects
- `params` in state handlers correspond to the `JsonMap` from consumer's `createProviderState`
- Verification results are published by default (`publishVerificationResult` defaults to `true`)

### Example 2: Local Flow (Monorepo, No Broker)

```typescript
import { Verifier } from "@pact-foundation/pact";
import { buildVerifierOptions } from "@seontechnologies/pactjs-utils";

// When PACT_BROKER_BASE_URL is NOT set, buildVerifierOptions
// falls back to local pact file verification
const opts = buildVerifierOptions({
  provider: "SampleMoviesAPI",
  port: "3001",
  includeMainAndDeployed: true,
  // Specify local pact files directly — skips broker entirely
  pactUrls: ["./pacts/movie-web-SampleMoviesAPI.json"],
  stateHandlers: {
    "movie exists": async (params) => {
      await db.seed({ movies: [{ id: params?.id }] });
    },
  },
});

await new Verifier(opts).verifyProvider();
```

### Example 3: Message Provider Verification (Kafka/Async)

```typescript
import { Verifier } from "@pact-foundation/pact";
import { buildMessageVerifierOptions } from "@seontechnologies/pactjs-utils";

const opts = buildMessageVerifierOptions({
  provider: "OrderEventsProducer",
  includeMainAndDeployed: process.env.PACT_BREAKING_CHANGE !== "true",
  // Message handlers return the message content that the provider would produce
  messageProviders: {
    "an order created event": async () => ({
      orderId: "order-123",
      userId: "user-456",
      items: [{ productId: "prod-789", quantity: 2 }],
      createdAt: new Date().toISOString(),
    }),
    "an order cancelled event": async () => ({
      orderId: "order-123",
      reason: "customer_request",
      cancelledAt: new Date().toISOString(),
    }),
  },
  stateHandlers: {
    "order exists": async (params) => {
      await db.seed({ orders: [{ id: params?.orderId }] });
    },
  },
});

await new Verifier(opts).verifyProvider();
```

**Key Points**:

- `buildMessageVerifierOptions` adds `messageProviders` to the verifier config
- Each message provider function returns the expected message payload
- State handlers work the same as HTTP verification
- Broker integration works identically (same env vars)

### Example 4: Breaking Change Coordination

```typescript
// When a provider intentionally introduces a breaking change:
//
// 1. Set PACT_BREAKING_CHANGE=true in CI environment
// 2. Your test reads the env var and passes includeMainAndDeployed: false
//    to buildVerifierOptions — this verifies ONLY against the matching
//    branch, skipping main/deployed consumers that would fail
// 3. Coordinate with consumer team to update their pact on a matching branch
// 4. Remove PACT_BREAKING_CHANGE flag after consumer updates

// In CI environment (.github/workflows/provider-verify.yml):
// env:
//   PACT_BREAKING_CHANGE: 'true'

// Your provider test code reads the env var:
const isBreakingChange = process.env.PACT_BREAKING_CHANGE === "true";

const opts = buildVerifierOptions({
  provider: "SampleMoviesAPI",
  port: "3001",
  includeMainAndDeployed: !isBreakingChange, // false during breaking changes
  stateHandlers: {
    /* ... */
  },
});
// When includeMainAndDeployed is false (breaking change):
//   selectors = [{ matchingBranch: true }]
// When includeMainAndDeployed is true (normal):
//   selectors = [{ matchingBranch: true }, { mainBranch: true }, { deployedOrReleased: true }]
```

### Example 5: handlePactBrokerUrlAndSelectors (Advanced)

```typescript
import { handlePactBrokerUrlAndSelectors } from "@seontechnologies/pactjs-utils";
import type { VerifierOptions } from "@pact-foundation/pact";

// For advanced use cases — mutates the options object in-place (returns void)
const options: VerifierOptions = {
  provider: "SampleMoviesAPI",
  providerBaseUrl: "http://localhost:3001",
};

handlePactBrokerUrlAndSelectors({
  pactPayloadUrl: process.env.PACT_PAYLOAD_URL,
  pactBrokerUrl: process.env.PACT_BROKER_BASE_URL,
  consumer: undefined, // or specific consumer name
  includeMainAndDeployed: true,
  options, // mutated in-place: sets pactBrokerUrl, consumerVersionSelectors, or pactUrls
});

// After call, options has been mutated with:
// - options.pactBrokerUrl (from pactBrokerUrl param)
// - options.consumerVersionSelectors (based on includeMainAndDeployed)
// OR if pactPayloadUrl matches: options.pactUrls = [pactPayloadUrl]
```

**Note**: `handlePactBrokerUrlAndSelectors` is called internally by `buildVerifierOptions`. You rarely need it directly — use it only for advanced custom verifier assembly.

### Example 6: getProviderVersionTags

```typescript
import { getProviderVersionTags } from "@seontechnologies/pactjs-utils";

// Extracts version tags from CI environment
const tags = getProviderVersionTags();

// In GitHub Actions on branch "feature/add-movies" (non-breaking):
//   tags = ['dev', 'feature/add-movies']
//
// In GitHub Actions on main branch (non-breaking):
//   tags = ['dev', 'main']
//
// In GitHub Actions with PACT_BREAKING_CHANGE=true:
//   tags = ['feature/add-movies']  (no 'dev' tag)
//
// Locally (no CI):
//   tags = ['local']
```

## Environment Variables Reference

| Variable               | Required        | Description                                                                                                                           | Default     |
| ---------------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| `PACT_BROKER_BASE_URL` | For remote flow | Pact Broker / PactFlow URL                                                                                                            | —           |
| `PACT_BROKER_TOKEN`    | For remote flow | API token for broker authentication                                                                                                   | —           |
| `GITHUB_SHA`           | Recommended     | Provider version for verification result publishing (auto-set by GitHub Actions)                                                      | `'unknown'` |
| `GITHUB_BRANCH`        | Recommended     | Branch name for provider version branch and version tags (**not auto-set** — define as `${{ github.head_ref \|\| github.ref_name }}`) | `'main'`    |
| `PACT_PAYLOAD_URL`     | Optional        | Webhook payload URL — triggers verification of specific pact only                                                                     | —           |
| `PACT_BREAKING_CHANGE` | Optional        | Set to `"true"` to use breaking change selector strategy                                                                              | `'false'`   |
| `CI`                   | Auto-detected   | When `"true"`, enables verification result publishing                                                                                 | —           |

## Key Points

- **Flow auto-detection**: If `PACT_BROKER_BASE_URL` is set → remote flow; otherwise → local flow (requires `pactUrls`)
- **`port` is a string**: Pass port number as string (e.g., `'3001'`); function builds `http://localhost:${port}` internally
- **`includeMainAndDeployed` is required**: `true` = verify matchingBranch + mainBranch + deployedOrReleased; `false` = verify matchingBranch only (for breaking changes)
- **Selector strategy**: Normal flow (`includeMainAndDeployed: true`) includes all selectors; breaking change flow (`false`) includes only `matchingBranch`
- **Webhook support**: `PACT_PAYLOAD_URL` takes precedence — verifies only the specific pact that triggered the webhook
- **State handler types**: Both `async (params) => void` and `{ setup: async (params) => void, teardown: async () => void }` are supported
- **Version publishing**: Verification results are published by default (`publishVerificationResult` defaults to `true`)

## Related Fragments

- `pactjs-utils-overview.md` — installation, decision tree, design philosophy
- `pactjs-utils-consumer-helpers.md` — consumer-side state parameter creation
- `pactjs-utils-request-filter.md` — auth injection for provider verification
- `contract-testing.md` — foundational patterns with raw Pact.js

## Anti-Patterns

### Wrong: Manual broker URL and selector assembly

```typescript
// ❌ Manual environment variable handling
const opts: VerifierOptions = {
  provider: "my-api",
  providerBaseUrl: "http://localhost:3001",
  pactBrokerUrl: process.env.PACT_BROKER_BASE_URL,
  pactBrokerToken: process.env.PACT_BROKER_TOKEN,
  publishVerificationResult: process.env.CI === "true",
  providerVersion: process.env.GIT_SHA || process.env.GITHUB_SHA || "dev",
  providerVersionBranch: process.env.GITHUB_HEAD_REF || process.env.GITHUB_REF_NAME,
  consumerVersionSelectors:
    process.env.PACT_BREAKING_CHANGE === "true"
      ? [{ matchingBranch: true }]
      : [{ matchingBranch: true }, { mainBranch: true }, { deployedOrReleased: true }],
  pactUrls: process.env.PACT_PAYLOAD_URL ? [process.env.PACT_PAYLOAD_URL] : undefined,
  stateHandlers: {
    /* ... */
  },
  requestFilter: (req, res, next) => {
    req.headers["authorization"] = `Bearer ${process.env.TEST_TOKEN}`;
    next();
  },
};
```

### Right: Use buildVerifierOptions

```typescript
// ✅ All env var logic handled internally
const opts = buildVerifierOptions({
  provider: "my-api",
  port: "3001",
  includeMainAndDeployed: process.env.PACT_BREAKING_CHANGE !== "true",
  stateHandlers: {
    /* ... */
  },
  requestFilter: createRequestFilter({
    tokenGenerator: () => process.env.TEST_TOKEN ?? "test-token",
  }),
});
```

### Wrong: Hardcoding consumer version selectors

```typescript
// ❌ Hardcoded selectors — breaks when flow changes
consumerVersionSelectors: [{ mainBranch: true }, { deployedOrReleased: true }],
```

### Right: Let buildVerifierOptions choose selectors

```typescript
// ✅ Selector strategy adapts to PACT_BREAKING_CHANGE env var
const opts = buildVerifierOptions({
  /* ... */
});
// Selectors chosen automatically based on environment
```

_Source: @seontechnologies/pactjs-utils provider-verifier module, pact-js-example-provider CI workflows_
