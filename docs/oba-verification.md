# OpenBotAuth (OBA) Publisher Verification

OpenClaw supports optional publisher identity verification for plugins and skills using the [OpenBotAuth](https://github.com/OpenBotAuth/openbotauth) specification. Publishers can cryptographically sign their plugin manifests and skill metadata, allowing users to verify authenticity.

## How It Works

Publishers register Ed25519 key pairs and host JWKS (JSON Web Key Set) endpoints (e.g. on the OpenBotAuth registry or any HTTPS endpoint). When a plugin or skill includes an `oba` block, OpenClaw can fetch the publisher's public key from the JWKS URL and verify the signature locally.

### Verification Flow

1. Plugin/skill includes an `oba` block with publisher identity and signature
2. By default, OpenClaw classifies the block **offline** (no network required)
3. When `--verify` is passed, OpenClaw fetches the publisher's JWKS from the `owner` URL
4. The Ed25519 signature is verified locally using Node.js `crypto.verify()`

## Status Model

| Status     | Meaning                                                            | When                                                                                 |
| ---------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| `unsigned` | No `oba` block present                                             | Default for plugins/skills without publisher identity                                |
| `signed`   | `oba` block has valid fields including signature, not yet verified | Offline parse only (default CLI behavior)                                            |
| `verified` | Signature verified against publisher's JWKS                        | Only with `--verify` flag (requires network)                                         |
| `invalid`  | Malformed `oba` block or verification failed                       | Offline (malformed) or `--verify` (signature mismatch, key not found, fetch failure) |

## OBA Block Format

The `oba` block is a JSON object with the following fields:

```json
{
  "owner": "https://api.openbotauth.org/agent-jwks/<agent_id>",
  "kid": "derived-key-id",
  "alg": "EdDSA",
  "sig": "base64url-encoded-ed25519-signature"
}
```

- **owner**: JWKS URL for the publisher. After running `openclaw oba register`, this is set automatically to the agent JWKS endpoint (e.g. `https://api.openbotauth.org/agent-jwks/<agent_id>`)
- **kid**: Key ID derived from the public key (SHA-256 hash, base64url, first 16 chars)
- **alg**: Algorithm, must be `EdDSA` (Ed25519)
- **sig**: Base64url-encoded Ed25519 signature over the canonicalized container

## Plugin Verification

For plugins, the `oba` block is placed at the root of `openclaw.plugin.json`, as a sibling to `id` and `configSchema`:

```json
{
  "id": "my-plugin",
  "configSchema": { ... },
  "oba": {
    "owner": "https://api.openbotauth.org/agent-jwks/<agent_id>",
    "kid": "derived-key-id",
    "alg": "EdDSA",
    "sig": "..."
  }
}
```

### CLI Usage

```bash
# List plugins (offline - shows signed/unsigned status)
openclaw plugins list

# List plugins with verification (fetches JWKS, verifies signatures)
openclaw plugins list --verify

# Show plugin details with verification
openclaw plugins info my-plugin --verify

# JSON output includes oba and obaVerification fields
openclaw plugins list --json --verify
```

## Skill Verification

For skills, the `oba` block is placed at the root of the JSON5 metadata object in the SKILL.md frontmatter, as a sibling to the `openclaw` key:

```markdown
---
metadata:
  {
    openclaw: { emoji: "...", requires: { ... } },
    oba:
      {
        owner: "https://api.openbotauth.org/agent-jwks/<agent_id>",
        kid: "derived-key-id",
        alg: "EdDSA",
        sig: "...",
      },
  }
---
```

### CLI Usage

```bash
# List skills (offline - shows signed/unsigned status)
openclaw skills list

# List skills with verification
openclaw skills list --verify

# Show skill details with verification
openclaw skills info my-skill --verify

# JSON output includes oba and obaVerification fields
openclaw skills list --json --verify
```

## Publisher Registration

Before signing, generate a key pair and register it with OpenBotAuth:

```bash
# Generate a new Ed25519 key pair
openclaw oba keygen

# Register the key as an agent (sets owner URL automatically)
openclaw oba register --token <your-pat>

# Sign a plugin manifest (uses the registered owner URL)
openclaw oba sign plugin path/to/openclaw.plugin.json

# Sign a skill
openclaw oba sign skill path/to/SKILL.md
```

The `register` command creates an agent on the OpenBotAuth registry and stores the agent ID and JWKS owner URL in the local key file. Subsequent runs of `register` with the same key will update the existing agent (idempotent).

### Registration Options

| Flag                  | Description           | Default                                            |
| --------------------- | --------------------- | -------------------------------------------------- |
| `--kid <id>`          | Key ID to register    | Most recent key                                    |
| `--name <name>`       | Agent name            | Key ID                                             |
| `--agent-type <type>` | Agent type            | `publisher`                                        |
| `--token <pat>`       | OpenBotAuth API token | `OPENBOTAUTH_TOKEN` env or `~/.openclaw/oba/token` |
| `--api-url <url>`     | API base URL          | `https://api.openbotauth.org`                      |

## Signing Process

The signature covers the entire container (plugin manifest JSON or skill metadata JSON5 object) with only the `sig` field removed from the `oba` block. The `owner`, `kid`, and `alg` fields remain in the signed payload, binding the publisher identity to the content.

### Canonicalization

Before signing, the container is canonicalized using deterministic JSON serialization:

- Object keys are sorted alphabetically
- No whitespace
- The `oba.sig` field is removed (but `oba.owner`, `oba.kid`, `oba.alg` remain)

## Security Notes

- Default CLI commands are fully **offline** and never make network requests
- The `--verify` flag is the only path that triggers network access (JWKS fetch)
- JWKS responses are cached in-memory per `owner` URL to avoid redundant fetches
- Fetch requests have a 3-second timeout via `AbortController`
- Only Ed25519 (`EdDSA`) signatures are supported
- Verification is **display-only** and does not affect plugin/skill loading behavior
- Owner URLs must be HTTPS with no credentials or fragments
- Private/local hosts (localhost, RFC1918, link-local, CGNAT) are rejected by default (best-effort IP literal check; does not cover DNS-resolved private IPs)

### Development Overrides

For local OpenBotAuth development:

| Environment Variable                  | Effect                                                        |
| ------------------------------------- | ------------------------------------------------------------- |
| `OPENCLAW_OBA_ALLOW_INSECURE_OWNER=1` | Allow `http://localhost` and `http://127.0.0.1` as owner URLs |
| `OPENCLAW_OBA_ALLOW_PRIVATE_OWNER=1`  | Allow private/local host owner URLs                           |
