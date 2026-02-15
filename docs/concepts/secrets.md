---
summary: "External secrets management: store credentials in GCP Secret Manager instead of plaintext files"
read_when:
  - You want to stop storing API keys in plaintext config files
  - You want per-agent secret isolation in multi-agent setups
  - You want to set up GCP Secret Manager for OpenClaw
  - You want to migrate existing plaintext secrets to a secrets store
title: "Secrets"
---

# External Secrets Management

OpenClaw can resolve secret references in configuration files at runtime, fetching values from an external secrets store instead of storing them in plaintext on disk.

## Why

- **No plaintext secrets on disk** — API keys, tokens, and credentials live in an encrypted, access-controlled store
- **Per-agent isolation** — in multi-agent setups, each agent only accesses secrets it's authorized for (enforced by IAM, not application code)
- **Audit trail** — GCP Secret Manager logs all access
- **Safe version control** — config files contain references (`${gcp:name}`), not actual secrets
- **Rotation without restarts** — update the secret in the store; cached values expire automatically

## Supported Providers

| Provider            | Status       |
| ------------------- | ------------ |
| GCP Secret Manager  | ✅ Supported |
| AWS Secrets Manager | Planned      |
| HashiCorp Vault     | Planned      |
| Azure Key Vault     | Planned      |

## Quick Start

### 1. Prerequisites

- A GCP project with billing enabled
- `gcloud` CLI installed and authenticated
- VM or environment with `cloud-platform` OAuth scope (for Compute Engine VMs)
- The service account running OpenClaw needs the **Secret Manager Secret Accessor** role (`roles/secretmanager.secretAccessor`)

#### Compute Engine VM Setup

If running on a GCP Compute Engine VM, two things are required:

**OAuth Scopes** — the VM must have `cloud-platform` scope. To update:

```bash
gcloud compute instances stop <instance> --zone=<zone>
gcloud compute instances set-service-account <instance> --zone=<zone> --scopes=cloud-platform
gcloud compute instances start <instance> --zone=<zone>
```

**IAM Role** — grant the VM's service account permission to read secrets:

```bash
gcloud projects add-iam-policy-binding <project-id> \
  --member="serviceAccount:<service-account-email>" \
  --role="roles/secretmanager.secretAccessor"
```

Or via the GCP Console:

1. Go to **IAM & Admin → IAM**
2. Find the compute service account
3. Click **Edit** (pencil icon)
4. Add role: **Secret Manager Secret Accessor**
5. Save

**For per-agent isolation** (setting IAM policies on individual secrets), the compute service account also needs **Secret Manager Admin** (`roles/secretmanager.admin`):

```bash
gcloud projects add-iam-policy-binding <project-id> \
  --member="serviceAccount:<service-account-email>" \
  --role="roles/secretmanager.admin"
```

Or via the Console: same steps, add **Secret Manager Admin** role.

> **Note:** After per-agent IAM bindings are configured, you can optionally downgrade the compute SA back to just Secret Accessor if you don't need to manage bindings anymore.

### 2. Bootstrap

```bash
openclaw secrets setup --project my-gcp-project
```

This will:

- Enable the Secret Manager API
- Create per-agent service accounts (if multi-agent)
- Configure IAM bindings
- Update `openclaw.json` with the `secrets` config section

Pass `--yes` to skip confirmation prompts.

### 3. Store a Secret

```bash
openclaw secrets set --provider gcp --name openclaw-brave-api-key --value "your-key-here"
```

### 4. Reference in Config

Replace plaintext values with secret references:

```json5
{
  // Before
  "apiKey": "sk-real-key-here"

  // After
  "apiKey": "${gcp:openclaw-brave-api-key}"
}
```

### 5. Verify

```bash
openclaw secrets test
```

## Secret Reference Syntax

References follow the pattern `${provider:secret-name}`:

```
${gcp:my-secret}          → latest version
${gcp:my-secret#3}        → pinned to version 3
${gcp:path/to/secret}     → slashes allowed in names
```

### Escaping

Use `$${}` to produce a literal `${}` in config:

```json5
{
  literal: "$${gcp:not-a-ref}", // → "${gcp:not-a-ref}"
}
```

### Distinction from Environment Variables

| Syntax              | Resolved by                     | Example                |
| ------------------- | ------------------------------- | ---------------------- |
| `${UPPER_CASE}`     | Env var substitution (existing) | `${BRAVE_API_KEY}`     |
| `${lowercase:name}` | Secret resolution (new)         | `${gcp:brave-api-key}` |

The lowercase provider prefix naturally distinguishes secret refs from env var refs.

## Configuration

Add a `secrets` section to `openclaw.json`:

```json5
{
  secrets: {
    providers: {
      gcp: {
        // GCP project ID (required)
        project: "my-gcp-project",

        // Cache TTL in seconds (default: 300)
        cacheTtlSeconds: 300,

        // Optional: path to service account key file
        // If omitted, uses Application Default Credentials (ADC)
        credentialsFile: "/path/to/service-account.json",
      },
    },
  },
}
```

## Auth Profiles

Secret references also work in `auth-profiles.json`:

```json
{
  "profiles": {
    "openai:default": {
      "type": "token",
      "provider": "openai",
      "token": "${gcp:openclaw-openai-token}"
    }
  }
}
```

## Per-Agent Isolation

In multi-agent setups, secrets are namespaced by convention:

```
openclaw-main-anthropic-token    → main agent only
openclaw-chai-openai-token       → chai agent only
openclaw-shared-brave-api-key    → shared across agents
```

IAM bindings enforce access:

- Main agent's service account → `openclaw-main-*` + `openclaw-shared-*`
- Chai's service account → `openclaw-chai-*` + `openclaw-shared-*`

The `openclaw secrets setup` command creates these bindings automatically.

## Migration

To migrate existing plaintext secrets:

```bash
openclaw secrets migrate
```

This will:

1. Scan config files for sensitive values (API keys, tokens)
2. Upload each to GCP Secret Manager
3. Replace plaintext values with `${gcp:name}` references
4. Verify all references resolve
5. Prompt before purging plaintext originals

Pass `--yes` to skip confirmation prompts. Plaintext is **never** purged unless the upload and verification succeed.

## Caching

- Secrets are cached **in memory only** (never written to disk)
- Default TTL: 300 seconds (configurable per-provider)
- Cache is cleared on `SIGUSR1` restart
- **Stale-while-revalidate**: if the provider is unreachable and cached values exist (even expired), stale values are used and a warning is logged

## CLI Commands

| Command                    | Description                                                          |
| -------------------------- | -------------------------------------------------------------------- |
| `openclaw secrets setup`   | Bootstrap GCP Secret Manager (enable API, create SAs, configure IAM) |
| `openclaw secrets test`    | Verify all secret references resolve successfully                    |
| `openclaw secrets list`    | List configured providers and their status                           |
| `openclaw secrets set`     | Store a secret manually                                              |
| `openclaw secrets migrate` | Migrate plaintext secrets to the store                               |

## Error Handling

| Error                                        | Behavior                                                                |
| -------------------------------------------- | ----------------------------------------------------------------------- |
| Provider not configured                      | Feature using the secret fails; system continues                        |
| Secret not found                             | Clear error: "Secret 'name' not found in project 'project'"             |
| Permission denied                            | Clear error: "Permission denied for secret 'name'. Check IAM bindings." |
| Network timeout                              | Retry once; fall back to stale cache if available                       |
| `@google-cloud/secret-manager` not installed | Clear error with install instructions                                   |

## Backward Compatibility

- **Entirely opt-in**: no `secrets` config = no behavior change
- `@google-cloud/secret-manager` is an optional dependency
- Existing env var substitution (`${UPPER_CASE}`) is unaffected
- Config files without secret refs pass through unchanged
