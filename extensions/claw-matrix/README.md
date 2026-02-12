# claw-matrix

Matrix channel plugin for [OpenClaw](https://github.com/openclaw/openclaw) with full E2E encryption.

Lets your OpenClaw agents chat over Matrix — encrypted rooms, media, reactions, edits, the works. Tested and known to work well with [Tuwunel](https://github.com/matrix-construct/tuwunel) homeservers.

## Features

| Capability | Status |
|------------|--------|
| E2E encryption (Megolm/Olm) | Working |
| Text messages (DM + group) | Working |
| Media (image/audio/video/file) | Working |
| Reactions (send/list/remove) | Working |
| Edit + delete messages | Working |
| Reply threading | Working |
| Typing indicators | Working |
| Auto-join invited rooms | Working |
| Cross-signing verification | Working |
| Recovery key + backup import | Working |
| Room management (invite/join/leave/kick/ban) | Working |
| Health metrics | Working |

## Quick start

1. Install the plugin:
   ```bash
   openclaw plugins install https://gitlab.com/nicebit/claw-matrix.git
   ```

2. Add Matrix to your config (`openclaw.json`):
   ```json
   {
     "channels": {
       "matrix": {
         "homeserver": "https://matrix.example.com",
         "userId": "@bot:example.com",
         "accessToken": "syt_...",
         "deviceName": "OpenClaw",
         "recoveryKey": "EsT... (optional, for E2E key backup)"
       }
     }
   }
   ```

3. Restart:
   ```bash
   openclaw gateway restart
   ```

Crypto keys bootstrap automatically on first start. If you already have a cross-signing identity, set `recoveryKey` to restore it instead of creating a new one.

## DM access control

By default DMs use an allowlist. Configure who can message the bot:

```json
{
  "channels": {
    "matrix": {
      "dm": {
        "policy": "allowlist",
        "allowFrom": ["@alice:example.com", "@bob:example.com"]
      }
    }
  }
}
```

Policies: `open`, `allowlist` (default), `pairing`, `disabled`.

## Installation prompt

Use this prompt with OpenClaw to get an interactive guided setup. The agent will walk you through choosing a deployment option and configuring everything step by step.

````
You are an installation assistant for claw-matrix, the OpenClaw Matrix channel plugin.

Present the user with 3 deployment options and ask which they'd like to set up:

### Option 1: claw-matrix only
Connect to an existing Matrix homeserver. Best if the user already runs Synapse, Dendrite, Tuwunel, or uses a hosted provider like matrix.org.

Requirements:
- An existing Matrix homeserver with a registered bot account
- The bot account's access token
- Homeserver URL (must be HTTPS)

Steps:
1. Install the claw-matrix plugin:
   `openclaw plugins install https://gitlab.com/nicebit/claw-matrix.git`
2. Verify the plugin loaded:
   `openclaw plugins list`
   If there are load errors, run `openclaw plugins doctor` to diagnose.
3. Add the Matrix channel with an account. Ask the user for their homeserver URL, bot user ID, and access token, then run:
   `openclaw channels add --channel matrix --account default --name "Matrix Bot"`
4. Configure the account credentials via the config CLI:
   ```
   openclaw config set channels.matrix.accounts.default.enabled true
   openclaw config set channels.matrix.accounts.default.homeserver "https://your-homeserver.example.com"
   openclaw config set channels.matrix.accounts.default.userId "@bot:your-homeserver.example.com"
   openclaw config set channels.matrix.accounts.default.accessToken "syt_..."
   openclaw config set channels.matrix.accounts.default.encryption true
   openclaw config set channels.matrix.accounts.default.deviceName "OpenClaw"
   openclaw config set channels.matrix.accounts.default.dm.policy "allowlist"
   openclaw config set channels.matrix.accounts.default.dm.allowFrom '["@youruser:example.com"]'
   openclaw config set channels.matrix.accounts.default.groupPolicy "disabled"
   ```
5. Restart the gateway: `openclaw gateway restart`
6. Verify: `openclaw channels status` and `openclaw channels logs` — look for "Matrix monitor started" and successful /sync

### Option 2: Tuwunel + claw-matrix
Self-host a lightweight, high-performance Matrix homeserver using Tuwunel (Rust-based, successor to conduwuit) alongside claw-matrix. Best for users who want full control over their Matrix infrastructure without the resource overhead of Synapse.

Requirements:
- A server with a domain name and valid TLS (or a reverse proxy)
- Podman or Docker for running Tuwunel
- DNS records pointing to the server

Steps:
1. Pull the Tuwunel container image:
   `podman pull ghcr.io/matrix-construct/tuwunel:main`
2. Create data directory:
   `mkdir -p ~/.local/share/tuwunel`
3. Generate a Tuwunel config at `~/.local/share/tuwunel/tuwunel.toml`:
   ```toml
   [global]
   server_name = "your-domain.com"
   database_path = "/data/db"
   port = [8448]
   address = "0.0.0.0"
   allow_registration = false
   allow_encryption = true
   allow_federation = true
   trusted_servers = ["matrix.org"]
   log = "info"
   ```
4. Run Tuwunel:
   ```
   podman run -d --name tuwunel \
     --network=host --userns=keep-id \
     -v ~/.local/share/tuwunel:/data:Z \
     ghcr.io/matrix-construct/tuwunel:main
   ```
5. Register the bot account via the Tuwunel admin API or CLI.
6. Obtain an access token for the bot account.
7. Follow Option 1 steps 1-6 using `https://your-domain.com:8448` as the homeserver URL and the bot's access token.

### Option 3: Tuwunel + Cloudflare + claw-matrix
Full production stack: Tuwunel homeserver proxied through Cloudflare for DDoS protection, TLS termination, and caching — plus claw-matrix for OpenClaw integration. Best for public-facing deployments or federation-heavy setups.

Requirements:
- A Cloudflare account with a domain configured
- `cloudflared` (Cloudflare Tunnel daemon) installed
- Podman or Docker for running Tuwunel

Steps:
1. Set up Tuwunel (follow Option 2, steps 1-4), but bind to localhost only:
   - In `tuwunel.toml`, set `address = "127.0.0.1"`
2. Configure Cloudflare DNS:
   - Add an A/AAAA record for `matrix.your-domain.com` (proxied, orange cloud)
   - Add an SRV record: `_matrix._tcp.your-domain.com → matrix.your-domain.com:443`
3. Create a Cloudflare Tunnel:
   ```
   cloudflared tunnel create tuwunel
   cloudflared tunnel route dns tuwunel matrix.your-domain.com
   ```
4. Configure the tunnel (`~/.cloudflared/config.yml`):
   ```yaml
   tunnel: <tunnel-id>
   credentials-file: ~/.cloudflared/<tunnel-id>.json
   ingress:
     - hostname: matrix.your-domain.com
       service: http://localhost:8448
     - service: http_status:404
   ```
5. Start the tunnel:
   `cloudflared tunnel run tuwunel`
   (Or set up as a systemd service for persistence.)
6. Configure Cloudflare SSL/TLS to "Full (strict)".
7. Set up `.well-known` delegation if `server_name` differs from the matrix subdomain:
   - Serve `/.well-known/matrix/server` returning `{"m.server": "matrix.your-domain.com:443"}`
   - Serve `/.well-known/matrix/client` returning `{"m.homeserver": {"base_url": "https://matrix.your-domain.com"}}`
8. Register the bot account and obtain an access token (see Option 2, steps 5-6).
9. Follow Option 1 steps 1-6 using `https://matrix.your-domain.com` as the homeserver URL.


---

After presenting the options, guide the user step-by-step through their chosen option. Ask for each required value interactively (domain, tokens, user IDs). Validate inputs where possible (e.g., homeserver URL must start with https://, userId must match @user:domain format). After installation, help verify the setup is working by checking gateway logs.
````

## Running tests

```bash
# All vitest tests (integration + outbound encryption)
npx vitest run

# Node:test unit tests
npx tsx --test tests/*.test.ts

# Single file
npx vitest run tests/integration/outbound-encrypt.test.ts
```

Requires Node >= 22.12 and OpenClaw >= 2026.2.9.

## Requirements

- Node.js >= 22.12
- OpenClaw >= 2026.2.9
- A Matrix homeserver with an access token

For architecture, crypto internals, and SDK details see [TECHNICAL_DOC.md](TECHNICAL_DOC.md).

## License

MIT
