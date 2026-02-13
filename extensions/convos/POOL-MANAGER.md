# Convos Pool Manager Integration

How to provision OpenClaw instances with Convos from a pool manager.

## Architecture

Each OpenClaw instance runs exactly one Convos conversation. The pool manager provisions fresh instances, each bound to a single conversation. No setup flow or onboarding is needed.

## Provisioning Flow

### 1. Configure the instance

The pool manager should configure the OpenClaw instance with an API key and enable the Convos plugin. This can be done via CLI commands or by writing the config file directly.

```bash
# Set the AI provider token
openclaw config set auth.profiles.anthropic:default.provider anthropic
openclaw config set auth.profiles.anthropic:default.mode token
# (API key is set via ANTHROPIC_API_KEY env var or openclaw config set)

# Enable convos plugin and set environment
openclaw config set channels.convos.enabled true
openclaw config set channels.convos.env dev
```

Or write `~/.openclaw/openclaw.json` directly:

```json
{
  "auth": {
    "profiles": {
      "anthropic:default": {
        "provider": "anthropic",
        "mode": "token"
      }
    }
  },
  "channels": {
    "convos": {
      "enabled": true,
      "env": "dev"
    }
  }
}
```

### 2. Start the gateway

```bash
openclaw gateway run --port 18789
```

At this point, the Convos plugin is loaded and HTTP routes are available, but no XMTP identity or conversation exists yet.

### 3. Create a conversation

```bash
curl -s -X POST http://localhost:18789/convos/conversation \
  -H 'Content-Type: application/json' \
  -d '{"name":"My Agent","env":"dev"}' | jq .
```

Response:

```json
{
  "conversationId": "56f2293389ad742e693ddb277464c3d3",
  "inviteUrl": "https://dev.convos.org/v2?i=...",
  "inviteSlug": "..."
}
```

This single call does everything:

- Creates a new XMTP identity (private keys stored in `~/.convos/identities/`)
- Creates a new XMTP conversation
- Writes config (`ownerConversationId`, `identityId`, `env`, `enabled`)
- Starts the message stream and join-request processor
- The instance is immediately ready to send and receive messages

### 4. Share the invite

Give the `inviteUrl` to the user. They open it in the Convos iOS app to join the conversation.

### Alternative: Join an existing conversation

If the user already created a conversation and has an invite:

```bash
curl -s -X POST http://localhost:18789/convos/join \
  -H 'Content-Type: application/json' \
  -d '{"inviteUrl":"https://dev.convos.org/v2?i=...","name":"My Agent","env":"dev"}' | jq .
```

## When are XMTP keys created?

XMTP identity and private keys are created lazily on the first `/convos/conversation` or `/convos/join` call. Enabling the plugin does NOT create any XMTP state. The `convos` CLI manages keys internally in `~/.convos/identities/`.

## Important constraints

- **One conversation per process.** Calling `/convos/conversation` or `/convos/join` a second time returns `409`. To provision a new conversation, terminate the process and start a fresh one.
- **No setup flow needed.** The `/convos/setup` endpoints exist for the Control UI onboarding experience (show QR, wait for join, confirm). The pool manager should skip these entirely.
- **No restart needed.** After `/convos/conversation` or `/convos/join`, the instance is immediately live with full message handling. No gateway restart required.

## Customizing agent behavior

Write operator-level directives to `~/.openclaw/workspace/INSTRUCTIONS.md` to customize the agent's system prompt. This is an OpenClaw core feature (not Convos-specific) — any text in that file is injected into every agent invocation as operator-provided instructions.

- Write the file before or after starting the gateway; it is loaded fresh on each agent invocation, so changes take effect immediately without a restart.
- Use it for personality, tone, tool restrictions, domain knowledge, or any behavioral guardrails.
- Each instance can have its own `INSTRUCTIONS.md`, or you can bake a shared one into your golden image.

Example `~/.openclaw/workspace/INSTRUCTIONS.md`:

```markdown
You are a customer support agent for Acme Corp.

- Always greet the user by name if known.
- Never discuss competitor products.
- Escalate billing disputes to a human operator.
```

For the golden checkpoint approach, write `INSTRUCTIONS.md` during step 1 (building the golden image) so every instance launched from the checkpoint inherits the same directives.

## HTTP API Reference

| Method | Path                        | Description                                       |
| ------ | --------------------------- | ------------------------------------------------- |
| GET    | `/convos/status`            | Health check — ready, conversation, streaming     |
| POST   | `/convos/conversation`      | Create a new conversation (returns invite URL)    |
| POST   | `/convos/join`              | Join an existing conversation via invite URL      |
| POST   | `/convos/conversation/send` | Send a message                                    |
| POST   | `/convos/rename`            | Rename the conversation                           |
| POST   | `/convos/lock`              | Lock/unlock the conversation (`{"unlock": true}`) |
| POST   | `/convos/explode`           | Destroy the conversation (irreversible)           |

All endpoints accept JSON bodies. All return JSON responses.

## Request body parameters

### POST /convos/conversation

| Param     | Type   | Default     | Description                           |
| --------- | ------ | ----------- | ------------------------------------- |
| name      | string | "OpenClaw"  | Conversation and profile display name |
| env       | string | from config | "dev" or "production"                 |
| accountId | string | "default"   | Account ID (for multi-account setups) |

### POST /convos/join

| Param     | Type   | Default     | Description           |
| --------- | ------ | ----------- | --------------------- |
| inviteUrl | string | required    | Invite URL or slug    |
| name      | string | "OpenClaw"  | Profile display name  |
| env       | string | from config | "dev" or "production" |
| accountId | string | "default"   | Account ID            |

### GET /convos/status

Returns the instance health. The `streaming` field confirms the XMTP child process is alive (not just that the instance variable is set).

```jsonc
// Gateway up, no conversation bound
{ "ready": true, "conversation": null, "streaming": false }

// Conversation bound, XMTP stream alive
{ "ready": true, "conversation": { "id": "abc..." }, "streaming": true }

// Conversation bound, XMTP stream dead
{ "ready": true, "conversation": { "id": "abc..." }, "streaming": false }
```

## Recommendation: Golden Checkpoint Instead of Pool Manager

Because XMTP identity creation happens lazily on `/convos/conversation`, you can eliminate the pool manager entirely using a golden checkpoint approach:

### The insight

A fully configured OpenClaw instance — with API key, plugin enabled, env set, gateway ready — is identical before the `/convos/conversation` call. No XMTP state exists yet. This means you can snapshot this state once and stamp out copies on demand.

### Golden checkpoint flow

1. **Build the golden image once:**

   ```bash
   # Configure everything except the conversation
   openclaw config set auth.profiles.anthropic:default.provider anthropic
   openclaw config set auth.profiles.anthropic:default.mode token
   openclaw config set channels.convos.enabled true
   openclaw config set channels.convos.env dev

   # (Optional) Write operator-level directives
   mkdir -p ~/.openclaw/workspace
   cat > ~/.openclaw/workspace/INSTRUCTIONS.md << 'EOF'
   You are a helpful assistant for Acme Corp.
   EOF
   ```

   Snapshot this as your golden checkpoint (container image, VM snapshot, Sprite checkpoint, etc). No XMTP keys, no conversations, no per-instance state.

2. **On demand, launch from checkpoint:**
   - Restore the golden checkpoint into a fresh instance
   - Start the gateway
   - `POST /convos/conversation` — creates XMTP identity + conversation in one call
   - Instance is immediately live

3. **Each instance is fully independent:**
   - Own XMTP identity (created at launch, not baked into the image)
   - Own conversation
   - Own `~/.convos/identities/` directory
   - No shared state between instances

### Why this eliminates the pool manager

| Pool manager approach                          | Golden checkpoint approach                                |
| ---------------------------------------------- | --------------------------------------------------------- |
| Pre-provisions N instances, keeps them warm    | Launches instances on demand from snapshot                |
| Manages a registry of available instances      | No registry — each instance is stateless until first call |
| Assigns pre-created conversations to users     | Creates conversation at the moment the user needs it      |
| Wastes resources on idle instances             | Zero idle cost — instances only exist when needed         |
| Complex: health checks, recycling, rebalancing | Simple: launch, call one endpoint, done                   |

### Cold start time

The only tradeoff is cold start time. Launching from a golden checkpoint adds:

- Checkpoint restore time (platform-dependent)
- Gateway startup (~1-3s)
- `/convos/conversation` call (~2-5s for XMTP identity creation + conversation)

Total: roughly 5-10 seconds from launch to a live conversation. If this is acceptable, no pool manager is needed.

### When you still need a pool manager

- Cold start time is unacceptable (sub-second provisioning required)
- You need to pre-assign conversations before users arrive
- You're running on infrastructure that doesn't support fast checkpoints
