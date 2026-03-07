# Pact.js Utils Request Filter

## Principle

Use `createRequestFilter` and `noOpRequestFilter` from `@seontechnologies/pactjs-utils` to inject authentication headers during provider verification. The pluggable token generator pattern prevents double-Bearer bugs and separates auth concerns from verification logic.

## Rationale

### Problems with manual request filters

- **Express type gymnastics**: Pact's `requestFilter` expects `(req, res, next) => void` with Express-compatible types — but Pact doesn't re-export these types
- **Double-Bearer bug**: Easy to write `Authorization: Bearer Bearer ${token}` when the token generator already includes the prefix
- **Inline complexity**: Auth logic mixed with verifier config makes tests harder to read
- **No-op boilerplate**: Providers without auth still need a pass-through function or `undefined`

### Solutions

- **`createRequestFilter`**: Accepts `{ tokenGenerator: () => string }` — generator returns raw token value synchronously, filter adds `Bearer ` prefix
- **`noOpRequestFilter`**: Pre-built pass-through for providers without auth requirements
- **Bearer prefix contract**: `tokenGenerator` returns raw value (e.g., `"abc123"`), filter always adds `"Bearer "` — impossible to double-prefix

## Pattern Examples

### Example 1: Basic Auth Injection

```typescript
import { buildVerifierOptions, createRequestFilter } from "@seontechnologies/pactjs-utils";

const opts = buildVerifierOptions({
  provider: "SampleMoviesAPI",
  port: "3001",
  includeMainAndDeployed: true,
  stateHandlers: {
    /* ... */
  },
  requestFilter: createRequestFilter({
    // tokenGenerator returns raw token — filter adds "Bearer " prefix
    tokenGenerator: () => "test-auth-token-123",
  }),
});

// Every request during verification will have:
// Authorization: Bearer test-auth-token-123
```

**Key Points**:

- `tokenGenerator` is **synchronous** (`() => string`) — if you need async token fetching, resolve the token before creating the filter
- Return the raw token value, NOT `"Bearer ..."` — the filter adds the prefix
- Filter sets `Authorization` header on every request during verification

### Example 2: Dynamic Token (Pre-resolved)

```typescript
import { createRequestFilter } from "@seontechnologies/pactjs-utils";

// Since tokenGenerator is synchronous, fetch the token before creating the filter
let cachedToken: string;

async function setupRequestFilter() {
  const response = await fetch("http://localhost:8080/auth/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      clientId: process.env.TEST_CLIENT_ID,
      clientSecret: process.env.TEST_CLIENT_SECRET,
    }),
  });
  const { access_token } = await response.json();
  cachedToken = access_token;
}

const requestFilter = createRequestFilter({
  tokenGenerator: () => cachedToken, // Synchronous — returns pre-fetched token
});

const opts = buildVerifierOptions({
  provider: "SecureAPI",
  port: "3001",
  includeMainAndDeployed: true,
  stateHandlers: {
    /* ... */
  },
  requestFilter,
});
```

### Example 3: No-Auth Provider

```typescript
import { buildVerifierOptions, noOpRequestFilter } from "@seontechnologies/pactjs-utils";

// For providers that don't require authentication
const opts = buildVerifierOptions({
  provider: "PublicAPI",
  port: "3001",
  includeMainAndDeployed: true,
  stateHandlers: {
    /* ... */
  },
  requestFilter: noOpRequestFilter,
});

// noOpRequestFilter is equivalent to: (req, res, next) => next()
```

### Example 4: Integration with buildVerifierOptions

```typescript
import { buildVerifierOptions, createRequestFilter } from "@seontechnologies/pactjs-utils";
import type { StateHandlers } from "@seontechnologies/pactjs-utils";

// Complete provider verification setup
const stateHandlers: StateHandlers = {
  "user is authenticated": async () => {
    // Auth state is handled by the request filter, not state handler
  },
  "movie exists": {
    setup: async (params) => {
      await db.seed({ movies: [{ id: params?.id }] });
    },
    teardown: async () => {
      await db.clean("movies");
    },
  },
};

const requestFilter = createRequestFilter({
  tokenGenerator: () => process.env.TEST_AUTH_TOKEN ?? "fallback-token",
});

const opts = buildVerifierOptions({
  provider: "SampleMoviesAPI",
  port: process.env.PORT ?? "3001",
  includeMainAndDeployed: process.env.PACT_BREAKING_CHANGE !== "true",
  stateHandlers,
  requestFilter,
});

// Run verification
await new Verifier(opts).verifyProvider();
```

## Key Points

- **Bearer prefix contract**: `tokenGenerator` returns raw value → filter adds `"Bearer "` → impossible to double-prefix
- **Synchronous only**: `tokenGenerator` must return `string` (not `Promise<string>`) — pre-resolve async tokens before creating the filter
- **Separation of concerns**: Auth logic in `createRequestFilter`, verification logic in `buildVerifierOptions`
- **noOpRequestFilter**: Use for providers without auth — cleaner than `undefined` or inline no-op
- **Express compatible**: The returned filter matches Pact's expected `(req, res, next) => void` signature

## Related Fragments

- `pactjs-utils-overview.md` — installation, utility table, decision tree
- `pactjs-utils-provider-verifier.md` — buildVerifierOptions integration
- `contract-testing.md` — foundational patterns with raw Pact.js

## Anti-Patterns

### Wrong: Manual Bearer prefix with double-prefix risk

```typescript
// ❌ Risk of double-prefix: "Bearer Bearer token"
requestFilter: (req, res, next) => {
  const token = getToken(); // What if getToken() returns "Bearer abc123"?
  req.headers["authorization"] = `Bearer ${token}`;
  next();
};
```

### Right: Use createRequestFilter with raw token

```typescript
// ✅ tokenGenerator returns raw value — filter handles prefix
requestFilter: createRequestFilter({
  tokenGenerator: () => getToken(), // Returns "abc123", not "Bearer abc123"
});
```

### Wrong: Inline auth logic in verifier config

```typescript
// ❌ Auth logic mixed with verifier config
const opts: VerifierOptions = {
  provider: "my-api",
  providerBaseUrl: "http://localhost:3001",
  requestFilter: (req, res, next) => {
    const clientId = process.env.CLIENT_ID;
    const clientSecret = process.env.CLIENT_SECRET;
    // 10 lines of token fetching logic...
    req.headers["authorization"] = `Bearer ${token}`;
    next();
  },
  // ... rest of config
};
```

### Right: Separate auth into createRequestFilter

```typescript
// ✅ Clean separation — async setup wraps token fetch (CommonJS-safe)
async function setupVerifierOptions() {
  const token = await fetchAuthToken(); // Resolve async token BEFORE creating filter

  const requestFilter = createRequestFilter({
    tokenGenerator: () => token, // Synchronous — returns pre-fetched value
  });

  return buildVerifierOptions({
    provider: "my-api",
    port: "3001",
    includeMainAndDeployed: true,
    requestFilter,
    stateHandlers: {
      /* ... */
    },
  });
}

// In tests/hooks, callers can await setupVerifierOptions():
// const opts = await setupVerifierOptions();
```

_Source: @seontechnologies/pactjs-utils request-filter module, pact-js-example-provider verification tests_
