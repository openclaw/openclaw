# claw-matrix Technical Documentation

## Architecture

```
index.ts                    → register(api): stores PluginRuntime, registers channel
src/channel.ts              → ChannelPlugin contract (all OpenClaw adapters)
src/monitor.ts              → sync loop lifecycle, inbound dispatch (per-room serial queue)
src/config.ts               → Zod schema + ResolvedMatrixAccount resolver
src/runtime.ts              → module-level PluginRuntime store (get/set)
src/actions.ts              → agent tool actions (send/read/react/edit/delete/channel-list/invite/join/leave/kick/ban)
src/types.ts                → Matrix event/response interfaces + typed content guards
src/health.ts               → sync, crypto, room health metrics + 12 operational counters
src/openclaw-types.ts       → TypeScript interfaces for OpenClaw plugin SDK contract
src/util/
  rate-limit.ts             → token bucket rate limiter
  logger.ts                 → structured logging wrapper (key=value fields)
src/client/
  http.ts                   → matrixFetch() — auth, rate limiting, 429 retry
  sync.ts                   → runSyncLoop() — long-poll, decrypt, dedup, auto-join
  send.ts                   → send/edit/delete/react, typing indicators, media send
  media.ts                  → upload/download, AES-256-CTR encrypt/decrypt
  rooms.ts                  → room state (encryption, type, names, members, display names)
  targets.ts                → target resolution (@user → DM, #alias → roomId)
src/crypto/
  machine.ts                → OlmMachine init/close, crypto store path, FFI timeout wrapper
  outgoing.ts               → processOutgoingRequests() — key upload/query/claim/share
  recovery.ts               → recovery key decode, backup activation, per-session backup fetch
  ssss.ts                   → SSSS decrypt, cross-signing restore from server secret storage
  self-sign.ts              → canonical JSON, ed25519 device self-signing, signature upload
tests/
  mocks/
    olm-machine.ts          → vitest mock OlmMachine with spy functions
    matrix-server.ts        → wrapper around MockHomeserver with request query API
  integration/
    mock-homeserver.ts       → configurable HTTP server implementing Matrix CS API
    outbound-encrypt.test.ts → ensureRoomKeysShared → encryptRoomEvent → putEvent flow
    media-roundtrip.test.ts  → AES-256-CTR encrypt/decrypt + SHA-256 tamper detection
    recovery-roundtrip.test.ts → recovery key decode/encode round-trip
    http-client.test.ts      → matrixFetch against mock homeserver
```

## Plugin loading

Loaded via jiti (JIT TypeScript) — NOT compiled. Entry point is `index.ts` directly. External extensions cannot import from `openclaw/plugin-sdk` at runtime, so `register(api)` stores `api.runtime` via a setter/getter pattern in `src/runtime.ts`.

## Key interfaces

### MonitorMatrixOpts (monitor.ts)

```typescript
{ config: OpenClawConfig, account: ResolvedMatrixAccount, accountId,
  abortSignal, log?, getStatus, setStatus }
```

### ResolvedMatrixAccount (config.ts)

Derived from `z.infer<MatrixConfigSchema> & { accountId: string }`. Zod schema is the single source of truth.

### MsgContext fields (set by monitor.ts)

```typescript
{ Body, RawBody, CommandBody,
  From: "matrix:${sender}" | "matrix:room:${roomId}",
  To: "matrix:${roomId}", SessionKey, AccountId,
  ChatType: "direct"|"group", GroupSubject?, SenderName, SenderId,
  Provider: "matrix", Surface: "matrix", MessageSid,
  OriginatingChannel: "matrix", OriginatingTo: roomId, Timestamp,
  MediaPath, MediaType, CommandAuthorized: true }
```

### Action result format

MUST return `{ content: [{ type: "text", text: JSON.stringify(payload) }], details: payload }`. Returning a plain object crashes.

## Message flow

### Inbound (Matrix → Agent)

1. `runSyncLoop()` long-polls `/sync` (30s timeout, exponential backoff)
2. To-device events fed to OlmMachine FIRST (key deliveries)
3. Sync token saved (after crypto state, before timeline — crash-safe)
4. UTD queue retried (previously undecryptable events)
5. Timeline events: dedup check → encrypted → `decryptRoomEvent()` → plaintext
6. Media messages: download + decrypt → save to workspace
7. `onMessage(event, roomId)` fires in `monitor.ts`
8. Monitor: skip own → access control (allowlist, prefix-normalized) → empty body
9. Display name resolved (cache → profile API → raw userId)
10. Thread ID extracted if present → session key adjusted
11. `enqueueForRoom()` → serialized per-room dispatch via OpenClaw pipeline
12. Agent reply delivered via `deliver` callback → `sendMatrixMessage()`

### Outbound (Agent → Matrix)

1. OpenClaw calls `outbound.sendText()`, `outbound.sendMedia()`, or deliver callback
2. Text: markdown→HTML via markdown-it + sanitize-html, reply fallback with HTML-escaped sender + quoted text (spec §11.19.1)
3. Media: AES-256-CTR encrypt (if room encrypted) → upload → construct event
4. Size check: pre-encryption (65KB) + post-encryption (65KB, catches base64 expansion)
5. Encrypted rooms: `ensureRoomKeysShared()` → `encryptRoomEvent()` → PUT
6. Plaintext rooms: PUT `m.room.message` directly

## Configuration reference

```typescript
// channels.matrix in openclaw.json
{
  homeserver: string,           // HTTPS URL (normalized to origin)
  userId: string,               // @user:domain format
  accessToken: string,
  password?: string,            // for soft logout re-auth
  encryption: boolean,          // default: true
  deviceName: string,           // default: "OpenClaw"
  dm: {
    policy: "pairing"|"allowlist"|"open"|"disabled",  // default: "allowlist"
    allowFrom: string[],
  },
  groupPolicy: "allowlist"|"open"|"disabled",         // default: "allowlist"
  groups: Record<roomId, { allow, requireMention }>,
  groupAllowFrom: string[],
  autoJoin: "always"|"allowlist"|"off",               // default: "off"
  autoJoinAllowFrom: string[],
  replyToMode: "off"|"first"|"all",                   // default: "first"
  chunkMode: "length"|"paragraph",                    // default: "length"
  textChunkLimit: number,                             // default: 4096
  maxMediaSize: number,                               // default: 50MB
  rateLimitTokens: number,                            // default: 10
  rateLimitRefillPerSec: number,                      // default: 2
  recoveryKey?: string,
  trustMode: "tofu"|"strict",                         // default: "tofu"
}
```

## Crypto internals

- **Library:** `@matrix-org/matrix-sdk-crypto-nodejs` ^0.4.0 (Rust FFI via NAPI)
- **Store:** SQLite at `~/.openclaw/claw-matrix/accounts/default/{server}__{user}/{tokenHash}/crypto` — path is hardcoded per plugin ID in `machine.ts`. Upgrading from `matrix-rust` creates a new store (old keys at `~/.openclaw/matrix-rust/accounts/` are NOT migrated). Configure a `recoveryKey` to recover old room keys from server-side backup.
- **Trust:** TOFU mode (configurable to strict)
- **Cross-signing:** On startup, SSSS secrets are decrypted using the recovery key (HKDF-SHA-256 + AES-256-CTR + HMAC-SHA-256), then the device is self-signed with the self-signing key (ed25519) and the signature uploaded to the homeserver. Already-signed devices are detected and skipped. This bypasses the SDK's `crossSigningStatus()` limitation (which checks an internal MessagePack blob, not the secrets table).
- **OTK type safety:** `otkCounts` wrapped as `Map<string, number>` for FFI compatibility with `receiveSyncChanges()`
- **Key sharing:** `ensureRoomKeysShared()` — track users → query keys → claim OTKs → share Megolm session
- **Encryption config caching:** `m.room.encryption` state events store algorithm, `rotation_period_ms`, `rotation_period_msgs` (not just a boolean flag)
- **UTD queue:** max 200 entries, 5min retry window, 1hr expiry, FIFO eviction, backup fallback after 2+ retries
- **Recovery key:** base58 decode → 0x8B01 prefix validation → parity check → BackupDecryptionKey → server backup activation
- **Backup UTD fallback:** per-session fetch from server backup, decryptV1, inject via synthetic forwarded_room_key
- **Media encryption:** AES-256-CTR with SHA-256 hash-before-decrypt (malleability protection)
- **MXC URI validation:** Strict regex — server_name `[a-zA-Z0-9._:-]`, media_id `[a-zA-Z0-9._-]` (prevents path traversal)
- **SSSS key verification:** Recovery key verified against key metadata (HKDF info="") before decrypting secrets (HKDF info=secretName)
- **Startup diagnostics:** Logs device keys + cross-signing status

## SDK v0.4.0 empirical findings

Critical discoveries from testing — these are NOT documented upstream:

- `crossSigningStatus()` checks `kv["identity"]` blob (MessagePack), NOT the `secrets` table
- `bootstrapCrossSigning(true)` writes to `kv["identity"]` + `identity` table, but 0 rows to `secrets`
- `secrets` table schema: `(secret_name BLOB NOT NULL, data BLOB NOT NULL)` — no primary key
- Inserting into `secrets` has no effect on `crossSigningStatus()` — always returns false
- `kv["identity"]` blob format: MessagePack `{ user_id, shared, keys: { master_key: { pickle, public_key }, ... } }`
- HKDF info parameter differs by context:
  - Per-secret decryption: `info = secretName` (e.g. "m.cross_signing.master")
  - Key metadata self-verification: `info = ""` (empty string)
- Salt for both: `Buffer.alloc(32, 0)` (32 zero bytes)
- `CrossSigningStatus` has prototype getters (hasMaster/hasSelfSigning/hasUserSigning), `JSON.stringify()` returns `{}`
- Self-signing approach: bypass SDK entirely — sign device keys with Node.js `crypto.sign()` ed25519
- SDK limitation (v0.4.0): No `importRoomKeys()` — synthetic to-device injection workaround
- `receiveSyncChanges` OTK parameter: FFI `.d.ts` declares `Record<string, number>`, not `Map`

## Singleton state

The following modules hold module-level singleton state, marked with `// SINGLETON` comments. Multi-account support requires refactoring all of these to per-account instances:

- `src/client/http.ts` — HTTP client and rate limiter
- `src/client/sync.ts` — sync token, dedup array
- `src/client/rooms.ts` — room encryption, members, names, DM caches
- `src/client/send.ts` — typing indicator throttle
- `src/crypto/machine.ts` — OlmMachine instance
- `src/monitor.ts` — active account ID guard
- `src/runtime.ts` — PluginRuntime reference

## Error handling patterns

### Sync loop (sync.ts)

- Exponential backoff with jitter, capped at 60s
- Max 10 consecutive failures marks status as degraded (loop continues for auto-recovery)
- Timeout errors (`MatrixTimeoutError`) skip backoff
- Soft logout: re-authenticate with password if available
- Hard logout: close crypto, delete store, throw
- Per-event try/catch prevents one bad event from breaking the entire cycle

### Outbound send (send.ts)

- Optimistic encrypt, one retry after flushing outgoing requests
- Pre- and post-encryption size checks (65KB limit)
- Reply fallback is graceful (no throw if event fetch fails)
- Typing indicators are fire-and-forget

### Crypto operations (outgoing.ts)

- Per-request try/catch; failed requests are NOT marked as sent (OlmMachine retries)
- Per-request rate limiting prevents blast

## Reliability

- **Event dedup:** FIFO set (1000 entries), persisted with sync token across restarts
- **Rate limiting:** HTTP (10 tokens, 2/s refill) + crypto outgoing (5 tokens, 1/s)
- **429 handling:** Parses Retry-After header, automatic single retry
- **Auto-join rate limit:** Max 3 joins per 60 seconds
- **Sync token:** Saved after crypto state ingestion, before timeline processing
- **Per-room serial dispatch:** Prevents interleaved agent replies from batched messages
- **Per-event error boundary:** One bad event in sync doesn't break the entire cycle
- **Pre-send + post-encryption size check:** 65KB limit for all event types
- **Soft logout:** Re-authenticates with stored password, preserves crypto store
- **Config validation:** Zod schema with fallback logging (field-level error messages)
- **Timeout protection:** Typed MatrixTimeoutError/MatrixNetworkError; 30s crypto FFI timeouts
- **Graceful shutdown:** Sync loop drains per-room dispatch queues before crypto teardown; closeMachine() is idempotent
- **Double-start guard:** Prevents hot-reload from launching duplicate sync loops
- **DM detection:** Uses m.direct account data (authoritative) with member-count fallback
- **Health metrics:** Sync failures, UTD queue depth, room counts + 12 operational counters
- **Structured logging:** Key=value fields on all monitor log lines

## ChannelPlugin adapters

- **meta** — id, label, blurb
- **capabilities** — text, media, reactions, edit, unsend, reply, typing, dm+group, blockStreaming
- **config** — listAccountIds, resolveAccount, isEnabled, isConfigured, resolveAllowFrom
- **gateway** — startAccount (launches monitor), stopAccount (abortSignal)
- **outbound** — deliveryMode: "direct", sendText, sendPayload, sendMedia, resolveTarget
- **security** — resolveDmPolicy (returns dm.policy + dm.allowFrom)
- **groups** — resolveRequireMention
- **actions** — send, read, react, reactions, unreact, edit, delete, unsend, channel-list, invite, join, leave, kick, ban
- **status** — buildAccountSnapshot (includes health metrics)
- **messaging** — normalizeTarget + targetResolver.looksLikeId

## Allowlist foot-gun

`From` uses prefixed format (`matrix:@user:domain`) for session routing, but allowlist checks compare raw Matrix IDs (`@user:domain`). Configuring `allowFrom: ["matrix:@user:domain"]` silently fails. Both `monitor.ts` DM and group checks strip the prefix before comparing.

## Test infrastructure

See [tests/README.md](tests/README.md) for test runner details.

### Mock files

- `tests/mocks/olm-machine.ts` — vitest mock OlmMachine with spy functions
- `tests/mocks/matrix-server.ts` — wrapper around MockHomeserver with request query API
- `tests/integration/mock-homeserver.ts` — configurable HTTP server implementing Matrix CS API

### Coverage gaps

High-priority untested paths: `monitor.ts` (inbound dispatch), `channel.ts` (ChannelPlugin contract), `actions.ts` (action handlers), `sync.ts` (sync loop). These require significant mocking infrastructure.

## Dependencies

```json
{
  "@matrix-org/matrix-sdk-crypto-nodejs": "^0.4.0",
  "bs58": "^6.0.0",
  "markdown-it": "14.1.0",
  "sanitize-html": "^2.13.0",
  "zod": "^4.3.6"
}
```

Only one Matrix account is supported per gateway instance (single-account limitation). OlmMachine, sync loop, and room state caches are global singletons.
