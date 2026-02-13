# claw-matrix Test Suite

Tests use Node's built-in test runner (`node:test` + `node:assert`). No external test framework needed.

## Running Tests

```bash
# Run all tests (requires Node >= 22.12)
npx tsx --test tests/**/*.test.ts

# Run a specific test file
npx tsx --test tests/rate-limit.test.ts

# Run unit tests only
npx tsx --test tests/rate-limit.test.ts tests/media.test.ts tests/config.test.ts tests/rooms.test.ts tests/targets.test.ts

# Run integration tests only
npx tsx --test tests/integration/*.test.ts

# Type-check tests without running
npx tsc --noEmit
```

Note: We use `npx tsx` to run TypeScript test files directly. If tsx is not available, install it:

```bash
npm i -D tsx
```

## Test Structure

```
tests/
  rate-limit.test.ts      # TokenBucket timing and burst behavior
  media.test.ts           # AES-256-CTR encrypt/decrypt round-trip, MIME mapping
  config.test.ts          # Zod schema validation, resolveMatrixAccount()
  rooms.test.ts           # processStateEvents() state machine
  targets.test.ts         # Target resolution prefix stripping and routing
  integration/
    mock-homeserver.ts     # Configurable mock Matrix homeserver (HTTP)
    http-client.test.ts    # matrixFetch against mock homeserver
  README.md               # This file
```

## Unit Tests

### rate-limit.test.ts

Tests the `TokenBucket` class: token acquisition, refill timing, burst capacity, and concurrent acquire behavior.

### media.test.ts

Tests AES-256-CTR encryption round-trip (encrypt then decrypt returns original data), SHA-256 hash validation, base64url correctness, and various input sizes. Also tests `mimeToMsgtype()` and `isValidMxcUrl()`.

### config.test.ts

Tests the Zod schema (`MatrixConfigSchema`) with valid full config, minimal config with defaults, homeserver normalization, userId validation, and invalid config rejection. Also tests `resolveMatrixAccount()` including the fallback path.

### rooms.test.ts

Tests `processStateEvents()` — the synchronous state machine that tracks encryption state (write-once), room names, member join/leave/ban, and DM detection heuristic.

### targets.test.ts

Tests `resolveMatrixTarget()` prefix stripping (matrix:, room:, channel:, user:), !roomId passthrough, and error handling. Network-dependent paths (@user, #alias) are tested for correct routing to the resolution functions.

## Integration Tests

### mock-homeserver.ts

A minimal HTTP server implementing key Matrix Client-Server API endpoints. Configurable sync responses, event capture, alias mapping, and auth validation.

### http-client.test.ts

Demonstrates wiring the mock homeserver with the real `matrixFetch` and `initHttpClient`. Tests /sync, event sending, alias resolution, auth failures, media upload, and key management endpoints.

## Extending Tests

### Adding unit tests

1. Create `tests/<module>.test.ts`
2. Import from the source module under `../src/...`
3. Use `describe`/`it` from `node:test` and `assert` from `node:assert/strict`

### Adding integration tests

1. Create `tests/integration/<feature>.test.ts`
2. Import `MockHomeserver` from `./mock-homeserver.js`
3. Start the server in `before()`, configure responses, stop in `after()`
4. Initialize `initHttpClient(server.url, token)` before tests

### Mock homeserver features

- `server.syncResponse` — set the response for /sync
- `server.sentEvents` — array of events captured from PUT /send
- `server.aliasMap` — configure alias → roomId mappings
- `server.mDirectData` — configure m.direct account data
- `server.joinedRooms` — configure joined_rooms response
- `server.reset()` — clear all state between tests
