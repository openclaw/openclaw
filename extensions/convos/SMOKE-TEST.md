# Convos CLI Migration — Smoke Test

Manual smoke test for the CLI subprocess architecture (`@convos/cli`).

## Prerequisites

- Convos iOS app installed on a real device
- `@convos/cli` binary resolves (installed via `pnpm install` in the extension)
- Fresh config (no existing `channels.convos` section), or willingness to reset

```bash
# Verify the CLI binary works
node extensions/convos/node_modules/@convos/cli/bin/run.js --help
```

## Clean Start (reset a previously bound conversation)

If you have already bound a conversation (ran onboarding, HTTP create, or HTTP join),
the gateway will refuse to create/join again (409). To start fresh:

```bash
# 1. Stop the gateway (Ctrl-C or kill the process)

# 2. Clear the Convos config keys
pnpm openclaw config set channels.convos.ownerConversationId ""
pnpm openclaw config set channels.convos.identityId ""
pnpm openclaw config set channels.convos.enabled false

# 3. (Optional) Wipe the CLI's local identity + XMTP database files
#    This forces the CLI to create a brand-new identity on next create/join.
rm -rf ~/.convos/identities ~/.convos/db

# 4. Verify config is cleared
pnpm openclaw config get channels.convos
```

After this, `ownerConversationId` and `identityId` should be empty, and you can
re-run any test from scratch.

## Test 1: CLI Onboarding

Tests `onboarding.ts` -> `ConvosInstance.join()`.

```bash
pnpm openclaw configure
```

1. Select Convos when prompted for channels
2. In the Convos iOS app, open/create a conversation, tap +, share the invite link
3. Paste the invite URL when prompted
4. Expected: "Successfully joined conversation!" with a conversation ID
5. Verify config:

```bash
pnpm openclaw config get channels.convos
```

Should show `identityId`, `ownerConversationId`, `env`, `enabled: true`. Should NOT have `privateKey`.

## Test 2: Gateway Start + Message Round-Trip

Tests `channel.ts` -> `ConvosInstance.fromExisting()` -> `start()` -> streaming.

```bash
pnpm openclaw gateway run --port 18789
```

1. Verify channel status:

```bash
pnpm openclaw channels status --probe
```

Convos should show `running: true`, probe `ok: true`.

2. Send a message from the Convos iOS app into the owner conversation
3. Expected: gateway logs show inbound message, agent processes and replies
4. Verify the reply appears in the Convos iOS app

## Test 3: HTTP Setup Flow (Control UI path)

Tests `POST /convos/setup` -> status polling -> `POST /convos/setup/complete`.

Start with a clean config or use `force: true`.

```bash
# 1. Start setup — creates a conversation + returns QR invite
curl -s -X POST http://localhost:18789/convos/setup \
  -H 'Content-Type: application/json' \
  -d '{"env":"dev","name":"Smoke Test","force":true}' | jq .
```

Expected: `{ inviteUrl, conversationId, qrDataUrl }`.

```bash
# 2. Poll join status
curl -s http://localhost:18789/convos/setup/status | jq .
```

Expected: `{ active: true, joined: false, joinerInboxId: null }`.

3. Scan the QR or paste the invite URL in Convos iOS app and join the conversation.

```bash
# 4. Poll again — should flip to joined
curl -s http://localhost:18789/convos/setup/status | jq .
```

Expected: `{ active: true, joined: true, joinerInboxId: "<hex>" }`.

```bash
# 5. Complete setup — writes config
curl -s -X POST http://localhost:18789/convos/setup/complete | jq .
```

Expected: `{ saved: true, conversationId: "..." }`.

```bash
# 6. Verify config was written
pnpm openclaw config get channels.convos
```

Should show `identityId`, `ownerConversationId`, `env`, `enabled: true`, `allowFrom` containing the joiner inbox ID.

## Test 4: HTTP Create Conversation

Tests `POST /convos/conversation` (pool manager path).

```bash
curl -s -X POST http://localhost:18789/convos/conversation \
  -H 'Content-Type: application/json' \
  -d '{"name":"Pool Test"}' | jq .
```

Expected: `{ conversationId, inviteUrl, inviteSlug }`.

```bash
# Calling again should return 409 (instance already bound)
curl -s -X POST http://localhost:18789/convos/conversation \
  -H 'Content-Type: application/json' \
  -d '{"name":"Second"}' | jq .
```

Expected: `409 { error: "Instance already bound..." }`.

## Test 5: HTTP Join Conversation

Tests `POST /convos/join`. Requires a fresh process (no instance bound).

1. Create an invite from the Convos iOS app
2. Call the join endpoint:

```bash
curl -s -X POST http://localhost:18789/convos/join \
  -H 'Content-Type: application/json' \
  -d '{"inviteUrl":"https://convos.app/join/SLUG","name":"Join Test"}' | jq .
```

Expected: `{ status: "joined", conversationId: "..." }` or `{ status: "waiting_for_acceptance" }`.

## Test 6: Send Message via HTTP

```bash
curl -s -X POST http://localhost:18789/convos/conversation/send \
  -H 'Content-Type: application/json' \
  -d '{"message":"Hello from HTTP route"}' | jq .
```

Expected: `{ success: true, messageId: "..." }` and the message appears in the Convos iOS app.

## Test 7: Rename

```bash
curl -s -X POST http://localhost:18789/convos/rename \
  -H 'Content-Type: application/json' \
  -d '{"name":"Renamed Bot"}' | jq .
```

Expected: `{ ok: true }`. Conversation name updates in the Convos iOS app.

## Test 8: Lock / Unlock

```bash
# Lock
curl -s -X POST http://localhost:18789/convos/lock \
  -H 'Content-Type: application/json' \
  -d '{}' | jq .
```

Expected: `{ ok: true, locked: true }`.

```bash
# Unlock
curl -s -X POST http://localhost:18789/convos/lock \
  -H 'Content-Type: application/json' \
  -d '{"unlock":true}' | jq .
```

Expected: `{ ok: true, locked: false }`.

## Test 9: Explode (Destructive)

WARNING: This permanently destroys the conversation.

```bash
curl -s -X POST http://localhost:18789/convos/explode \
  -H 'Content-Type: application/json' \
  -d '{}' | jq .
```

Expected: `{ ok: true, exploded: true }`. Instance is now null — subsequent send calls return `400 { error: "No active conversation" }`.

## Test 10: Message Actions (via agent tool calls)

With the gateway running and a conversation active, send a message from the Convos app. The agent should be able to:

- Send: action `send` with `message` param
- React: action `react` with `messageId` and `emoji` params

Verify reactions appear in the Convos iOS app.

## Failure Modes to Check

| Scenario                     | Expected                                               |
| ---------------------------- | ------------------------------------------------------ |
| `convos` binary not found    | Error on gateway start mentioning CLI                  |
| Invalid invite slug          | `ConvosInstance.join()` throws, onboarding shows error |
| Network down during stream   | Stream child exits, gateway logs exit code             |
| Send with no active instance | `400 { error: "No active conversation" }`              |
| Double create                | `409` on second call                                   |
