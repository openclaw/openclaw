---
summary: "Vault proxy: age-encrypted credential isolation for model API keys"
read_when:
  - Isolating API keys from the gateway process
  - Setting up encrypted secrets with age and a reverse proxy sidecar
  - Migrating plaintext API keys to vault-encrypted storage
title: "Vault Proxy"
---

# Vault Proxy

The vault proxy keeps model API keys out of the OpenClaw gateway process.
Secrets are stored in an age-encrypted file (`vault.age`) and injected at
request time by a reverse proxy sidecar (nginx). The gateway never sees the
real credentials.

## Architecture

```
User/Client
    |
    v
[OpenClaw Gateway]  -- http://vault:8081 -->  [Vault Sidecar (nginx)]  -- https://api.openai.com -->
                                                 |
                                       Injects Authorization header
                                       from decrypted vault.age
```

Two Docker networks enforce isolation:

| Network    | Members         | Internet | Purpose                     |
| ---------- | --------------- | -------- | --------------------------- |
| `internal` | Gateway + Vault | No       | Gateway reaches vault only  |
| `external` | Vault only      | Yes      | Vault reaches upstream APIs |

The gateway has no route to the internet and no access to plaintext keys.

## Trust boundaries

| Boundary                | Has secret key?             | Has plaintext API keys?           |
| ----------------------- | --------------------------- | --------------------------------- |
| User workstation (CLI)  | Transiently (user provides) | Transiently (during add/migrate)  |
| Docker host (.env file) | At rest (0600 root)         | No                                |
| Vault sidecar (startup) | Briefly                     | In rendered nginx config on tmpfs |
| Vault sidecar (nginx)   | No (unset before exec)      | In process memory                 |
| OpenClaw gateway        | Never                       | Never                             |
| Exec sandbox            | Never                       | Never                             |

## Quick start

### 1. Initialize the vault

```bash
openclaw vault init
```

This generates an age keypair, creates an empty `vault.age` file, and stores
the public key in `openclaw.json`. The secret key is printed once -- save it
in a password manager.

### 2. Add secrets

```bash
# Pipe value via stdin (recommended - avoids shell history exposure)
echo "sk-your-key-here" | AGE_SECRET_KEY=<your-key> openclaw vault add OPENAI_API_KEY --stdin
echo "ant-your-key" | AGE_SECRET_KEY=<your-key> openclaw vault add ANTHROPIC_API_KEY --stdin

# Or pass value as argument (visible in shell history and process list)
AGE_SECRET_KEY=<your-key> openclaw vault add OPENAI_API_KEY sk-your-key-here
```

For known providers (openai, anthropic, deepgram, openai-compat, google), the
CLI automatically configures the proxy URL mapping in `openclaw.json`.

### 3. Deploy with Docker

Add the vault sidecar to your `docker-compose.yml`:

```yaml
services:
  vault:
    build: ./vault
    env_file: .env # Contains AGE_SECRET_KEY
    volumes:
      - ./vault.age:/etc/vault.age:ro
    tmpfs:
      - /run/secrets:size=1m
    networks:
      - internal
      - external
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://localhost:5335/live"]
      interval: 10s
      timeout: 3s

  openclaw:
    # ... your existing config ...
    networks:
      - internal
    depends_on:
      vault:
        condition: service_healthy
```

### 4. Create the `.env` file on the Docker host

```bash
echo "AGE_SECRET_KEY=AGE-SECRET-KEY-1YOUR_KEY_HERE" > .env
chmod 600 .env
```

## Secret lifecycle

### Add or update a secret

```bash
# Value as argument (visible in process listing and shell history)
AGE_SECRET_KEY=<key> openclaw vault add <NAME> <VALUE>

# Value from stdin (recommended — avoids shell history exposure)
echo "<VALUE>" | AGE_SECRET_KEY=<key> openclaw vault add <NAME> --stdin

# Interactive prompt (when running in a terminal)
AGE_SECRET_KEY=<key> openclaw vault add <NAME>
```

If the name matches a known provider, the proxy mapping is added automatically.
Use `--no-proxy` to skip this. Use `--proxy-host <host>` to change the default
hostname from "vault".

### Remove a secret

```bash
AGE_SECRET_KEY=<key> openclaw vault remove <NAME>
```

Also removes the matching proxy entry from config.

### List secrets

```bash
AGE_SECRET_KEY=<key> openclaw vault list
AGE_SECRET_KEY=<key> openclaw vault list --reveal       # Show partially masked values
AGE_SECRET_KEY=<key> openclaw vault list --json          # Machine-readable output (masked)
AGE_SECRET_KEY=<key> openclaw vault list --json --reveal # Full plaintext values (use with care)
```

NOTE: `--json --reveal` outputs raw plaintext secret values. Avoid in CI logs or
shared terminals. Prefer piping directly to a file or tool.

### Rotate secrets

To change an individual key, use `vault add` with the new value. To rotate the
age keypair itself:

```bash
AGE_SECRET_KEY=<old-key> openclaw vault list --json > /tmp/secrets.json
openclaw vault init --force
AGE_SECRET_KEY=<new-key> openclaw vault add ...  # Re-add each secret
```

Then update the `.env` file on the Docker host with the new `AGE_SECRET_KEY`
and restart the vault sidecar.

## Migration from plaintext config

If your `openclaw.json` has plaintext `apiKey` values in providers:

```bash
# Preview what will be migrated
openclaw vault migrate --dry-run

# Run the migration
AGE_SECRET_KEY=<key> openclaw vault migrate
```

The `migrate` command:

1. Scans providers for plaintext `apiKey` values
2. Initializes the vault if needed (prints the secret key)
3. Encrypts each key into `vault.age`
4. Removes plaintext keys from config
5. Configures proxy URL mappings for known providers

Before:

```json
{
  "models": {
    "providers": {
      "openai": { "apiKey": "sk-real-key" }
    }
  }
}
```

After:

```json
{
  "vault": {
    "enabled": true,
    "publicKey": "age1...",
    "proxies": { "openai": "http://vault:8081" }
  },
  "models": {
    "providers": {
      "openai": {}
    }
  }
}
```

## Docker deployment

### Two-network architecture

The `docker-compose.vault.yml` defines two networks:

- **internal** (no internet): Gateway and vault communicate here.
- **external** (internet access): Vault reaches upstream APIs.

The gateway has `internal` only, so it cannot reach the internet directly.
All API traffic goes through the vault proxy.

### Health checks

The vault sidecar exposes health endpoints on port 5335:

- `GET /live` -- liveness (nginx is running)
- `GET /ready` -- readiness (nginx is running)

### Supported providers

| Provider      | Port | Secret name             | Auth header                   |
| ------------- | ---- | ----------------------- | ----------------------------- |
| OpenAI        | 8081 | `OPENAI_API_KEY`        | `Authorization: Bearer <key>` |
| Anthropic     | 8082 | `ANTHROPIC_API_KEY`     | `x-api-key: <key>`            |
| Deepgram      | 8083 | `DEEPGRAM_API_KEY`      | `Authorization: Token <key>`  |
| OpenAI-compat | 8084 | `OPENAI_COMPAT_API_KEY` | `Authorization: Bearer <key>` |
| Google Gemini | 8085 | `GEMINI_API_KEY`        | `x-goog-api-key: <key>`       |

### Adding a new provider

1. Add a `server` block to `vault/nginx.conf.template` with a new port
2. Add the secret variable to the `envsubst` list in `vault/entrypoint.sh`
3. `openclaw vault add <SECRET_NAME> <value>`
4. Add the proxy mapping: set `vault.proxies.<provider>` in config

## Non-Docker usage

Without Docker, `vault.age` serves as an encrypted backup of your API keys.
You can use the CLI to manage secrets from any machine:

```bash
openclaw vault init
openclaw vault add OPENAI_API_KEY sk-...
openclaw vault list --reveal
```

The vault proxy (credential injection) requires Docker. Without it, you must
provide API keys through other means (environment variables, config).

## Configuration reference

### `openclaw.json` fields

| Field             | Type                     | Default                      | Description                        |
| ----------------- | ------------------------ | ---------------------------- | ---------------------------------- |
| `vault.enabled`   | boolean                  | `false`                      | Enable vault proxy mode            |
| `vault.proxies`   | `Record<string, string>` | `{}`                         | Provider name to proxy URL mapping |
| `vault.file`      | string                   | `vault.age` alongside config | Path to vault.age file             |
| `vault.publicKey` | string                   | --                           | Age public key for encryption      |

### Environment variables

| Variable              | Used by              | Description                   |
| --------------------- | -------------------- | ----------------------------- |
| `AGE_SECRET_KEY`      | CLI + Docker sidecar | Age secret key for decryption |
| `OPENCLAW_VAULT_PATH` | CLI                  | Override vault.age file path  |

## CLI reference

| Command                         | Needs secret key?  | Description                        |
| ------------------------------- | ------------------ | ---------------------------------- |
| `vault init`                    | No                 | Generate keypair, create vault.age |
| `vault init --force`            | No                 | Overwrite existing vault           |
| `vault status`                  | No                 | Show vault state                   |
| `vault add <name> [value]`      | Yes                | Add/update a secret                |
| `vault add --stdin`             | Yes                | Read value from stdin pipe         |
| `vault add --no-proxy`          | Yes                | Add without auto proxy config      |
| `vault add --proxy-host <host>` | Yes                | Override proxy hostname            |
| `vault remove <name>`           | Yes                | Remove a secret                    |
| `vault list`                    | Yes                | List secret names                  |
| `vault list --reveal`           | Yes                | Show partially masked values       |
| `vault list --json`             | Yes                | JSON output                        |
| `vault migrate`                 | Yes (or auto-init) | Migrate from plaintext config      |
| `vault migrate --dry-run`       | No                 | Preview migration                  |
| `vault migrate --proxy-host`    | Yes (or auto-init) | Override proxy hostname            |

## Troubleshooting

### "AGE_SECRET_KEY not available"

The command needs the decryption key. Provide it:

```bash
AGE_SECRET_KEY=<key> openclaw vault <command>
```

Or run in an interactive terminal for a stdin prompt.

### "No vault public key in config"

Run `openclaw vault init` first to generate a keypair and configure the vault.

### "Vault file not found"

The `vault.age` file doesn't exist at the expected path. Run `vault init` or
check `vault.file` / `OPENCLAW_VAULT_PATH`.

### Vault sidecar fails to start

Check that:

- `AGE_SECRET_KEY` is set correctly in `.env`
- `vault.age` is bind-mounted to `/etc/vault.age`
- The `/run/secrets` tmpfs mount exists
- Container logs: `docker logs <vault-container>`

### Gateway returns 401/403 errors

- Verify `vault.enabled: true` in config
- Verify `vault.proxies` maps the provider to the correct port
- Test the proxy directly: `curl -v http://vault:8081/v1/models`

## Related docs

- [Security](/gateway/security) - overall security model and threat boundaries
- [Sandboxing](/gateway/sandboxing) - exec sandbox isolation (complementary to vault)
- [Configuration](/gateway/configuration) - `openclaw.json` reference
