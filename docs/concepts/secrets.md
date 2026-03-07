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
- **Per-agent isolation** — in multi-agent setups, each agent only accesses secrets it's authorized for (enforced by GCP IAM, not application code)
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
- `gcloud` CLI installed and authenticated (for setup only; not needed at runtime)
- VM or environment with `cloud-platform` OAuth scope (for Compute Engine VMs)

#### Compute Engine VM Setup

If running on a GCP Compute Engine VM:

**OAuth Scopes** — the VM must have `cloud-platform` scope. To update (requires VM restart):

```bash
gcloud compute instances stop <instance> --zone=<zone>
gcloud compute instances set-service-account <instance> --zone=<zone> --scopes=cloud-platform
gcloud compute instances start <instance> --zone=<zone>
```

**IAM Roles** — the compute service account needs these roles:

| Role                                 | Purpose                                     | Required                        |
| ------------------------------------ | ------------------------------------------- | ------------------------------- |
| `roles/secretmanager.secretAccessor` | Read secret values at runtime               | Always                          |
| `roles/secretmanager.admin`          | Create secrets, set per-secret IAM bindings | For setup & per-agent isolation |

Grant via CLI:

```bash
gcloud projects add-iam-policy-binding <project-id> \
  --member="serviceAccount:<service-account-email>" \
  --role="roles/secretmanager.secretAccessor"

gcloud projects add-iam-policy-binding <project-id> \
  --member="serviceAccount:<service-account-email>" \
  --role="roles/secretmanager.admin"
```

Or via the GCP Console:

1. Go to **IAM & Admin → IAM**
2. Find the compute service account
3. Click **Edit** (pencil icon)
4. Add both roles
5. Save

> **Tip:** After setup is complete and per-agent isolation is configured, you can optionally remove `secretmanager.admin` from the compute SA — agents authenticate with their own service accounts at runtime.

### 2. Bootstrap

```bash
openclaw secrets setup --project my-gcp-project --agents main,chai
```

This will:

- Enable the Secret Manager API
- Create per-agent service accounts (`openclaw-main@`, `openclaw-chai@`)
- Generate service account key files
- Set per-secret IAM bindings
- Update `openclaw.json` with the `secrets` config section

Pass `--yes` to skip confirmation prompts.

### 3. Store a Secret

```bash
openclaw secrets set --provider gcp --name openclaw-main-brave-api-key --value "your-key-here"
```

### 4. Reference in Config

Replace plaintext values with secret references:

```json5
{
  // Before
  "apiKey": "sk-real-key-here"

  // After
  "apiKey": "${gcp:openclaw-main-brave-api-key}"
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

        // Path to service account key file (required for per-agent isolation)
        // If omitted, uses Application Default Credentials (ADC)
        credentialsFile: "/path/to/openclaw-main-sa.json",
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
      "token": "${gcp:openclaw-main-openai-token}"
    }
  }
}
```

## Per-Agent Isolation

Per-agent isolation ensures each agent can **only** read its own secrets, enforced at the GCP IAM level. This is not application-level filtering — GCP itself blocks unauthorized access.

### How It Works

Each agent gets:

1. **Its own GCP service account** (e.g., `openclaw-main@project.iam.gserviceaccount.com`)
2. **A service account key file** stored locally (e.g., `~/.config/gcp/openclaw-main-sa.json`)
3. **Per-secret IAM bindings** granting only that SA access to its secrets

### Naming Convention

Secrets are namespaced by agent name:

```
openclaw-main-*     → only the main agent can read
openclaw-chai-*     → only the chai agent can read
openclaw-shared-*   → multiple agents can read (both SAs get access)
```

### Setup Steps

**1. Create per-agent service accounts:**

```bash
gcloud iam service-accounts create openclaw-main \
  --display-name="OpenClaw Main Agent"
gcloud iam service-accounts create openclaw-chai \
  --display-name="OpenClaw Chai Agent"
```

**2. Generate key files:**

```bash
gcloud iam service-accounts keys create ~/.config/gcp/openclaw-main-sa.json \
  --iam-account=openclaw-main@<project>.iam.gserviceaccount.com
gcloud iam service-accounts keys create ~/.config/gcp/openclaw-chai-sa.json \
  --iam-account=openclaw-chai@<project>.iam.gserviceaccount.com
chmod 600 ~/.config/gcp/*.json
```

**3. Set per-secret IAM bindings:**

```bash
# Main agent's secrets → only main SA
gcloud secrets add-iam-policy-binding openclaw-main-openai-key \
  --member="serviceAccount:openclaw-main@<project>.iam.gserviceaccount.com" \
  --role="roles/secretmanager.secretAccessor"

# Chai agent's secrets → only chai SA
gcloud secrets add-iam-policy-binding openclaw-chai-alpaca-key \
  --member="serviceAccount:openclaw-chai@<project>.iam.gserviceaccount.com" \
  --role="roles/secretmanager.secretAccessor"

# Shared secrets → both SAs
gcloud secrets add-iam-policy-binding openclaw-shared-brave-key \
  --member="serviceAccount:openclaw-main@<project>.iam.gserviceaccount.com" \
  --role="roles/secretmanager.secretAccessor"
gcloud secrets add-iam-policy-binding openclaw-shared-brave-key \
  --member="serviceAccount:openclaw-chai@<project>.iam.gserviceaccount.com" \
  --role="roles/secretmanager.secretAccessor"
```

**4. Configure each agent to use its own SA:**

Main agent's `openclaw.json`:

```json5
{
  secrets: {
    providers: {
      gcp: {
        project: "my-project",
        credentialsFile: "/home/user/.config/gcp/openclaw-main-sa.json",
      },
    },
  },
}
```

Chai agent's `openclaw.json`:

```json5
{
  secrets: {
    providers: {
      gcp: {
        project: "my-project",
        credentialsFile: "/home/user/.config/gcp/openclaw-chai-sa.json",
      },
    },
  },
}
```

### Verification

After setup, verify isolation is enforced:

```
✅ main reads openclaw-main-openai-key     → access granted
🔒 main reads openclaw-chai-alpaca-key     → PERMISSION_DENIED
✅ chai reads openclaw-chai-alpaca-key     → access granted
🔒 chai reads openclaw-main-openai-key     → PERMISSION_DENIED
```

If an agent tries to read another agent's secret, GCP returns `PERMISSION_DENIED` — the request never reaches OpenClaw.

## Worked Example: Multi-Agent Migration

This example walks through migrating a two-agent setup (main + chai) from plaintext to GCP Secret Manager with full isolation.

### Before (plaintext)

```
~/.config/openai/credentials.env     → OPENAI_API_KEY=sk-proj-abc123...
~/.config/alpaca/sandbox.env         → ALPACA_KEY_ID=CKN... / ALPACA_SECRET_KEY=7TV...
~/.config/himalaya/.nine30-pass      → cbmc pxsf mlzr puea
openclaw.json                        → "apiKey": "BSAIGr...", "token": "83a1aa..."
```

All secrets in plaintext. Any agent or process on the machine can read everything.

### Step 1: Enable Secret Manager API

```bash
gcloud services enable secretmanager.googleapis.com --project=my-project
```

### Step 2: Store secrets with agent-namespaced names

```bash
# Main agent secrets
openclaw secrets set --provider gcp --name openclaw-main-openai-api-key --value "sk-proj-abc123..."
openclaw secrets set --provider gcp --name openclaw-main-brave-api-key --value "BSAIGr..."
openclaw secrets set --provider gcp --name openclaw-main-gateway-token --value "83a1aa..."
openclaw secrets set --provider gcp --name openclaw-main-email-password --value "cbmc pxsf mlzr puea"

# Chai agent secrets
openclaw secrets set --provider gcp --name openclaw-chai-alpaca-key-id --value "CKN..."
openclaw secrets set --provider gcp --name openclaw-chai-alpaca-secret-key --value "7TV..."
```

### Step 3: Create service accounts and keys

```bash
gcloud iam service-accounts create openclaw-main --display-name="OpenClaw Main Agent"
gcloud iam service-accounts create openclaw-chai --display-name="OpenClaw Chai Agent"

gcloud iam service-accounts keys create ~/.config/gcp/openclaw-main-sa.json \
  --iam-account=openclaw-main@my-project.iam.gserviceaccount.com
gcloud iam service-accounts keys create ~/.config/gcp/openclaw-chai-sa.json \
  --iam-account=openclaw-chai@my-project.iam.gserviceaccount.com

chmod 600 ~/.config/gcp/*.json
```

### Step 4: Set per-secret IAM bindings

```bash
# Main-only secrets
for SECRET in openclaw-main-openai-api-key openclaw-main-brave-api-key \
              openclaw-main-gateway-token openclaw-main-email-password; do
  gcloud secrets add-iam-policy-binding $SECRET \
    --member="serviceAccount:openclaw-main@my-project.iam.gserviceaccount.com" \
    --role="roles/secretmanager.secretAccessor"
done

# Chai-only secrets
for SECRET in openclaw-chai-alpaca-key-id openclaw-chai-alpaca-secret-key; do
  gcloud secrets add-iam-policy-binding $SECRET \
    --member="serviceAccount:openclaw-chai@my-project.iam.gserviceaccount.com" \
    --role="roles/secretmanager.secretAccessor"
done
```

### Step 5: Update config files with references

Main agent's `openclaw.json`:

```json5
{
  secrets: {
    providers: {
      gcp: {
        project: "my-project",
        credentialsFile: "/home/user/.config/gcp/openclaw-main-sa.json",
      },
    },
  },
  tools: {
    web: {
      search: {
        apiKey: "${gcp:openclaw-main-brave-api-key}",
      },
    },
  },
  gateway: {
    auth: {
      token: "${gcp:openclaw-main-gateway-token}",
    },
  },
}
```

### Step 6: Purge plaintext files

Only after verifying all references resolve (`openclaw secrets test`):

```bash
# Replace file contents with migration notes
echo "# Migrated to GCP Secret Manager" > ~/.config/openai/credentials.env
echo "# Migrated to GCP Secret Manager" > ~/.config/alpaca/sandbox.env
echo "# Migrated to GCP Secret Manager" > ~/.config/himalaya/.nine30-pass
```

### After

```
GCP Secret Manager (encrypted, access-controlled):
  openclaw-main-openai-api-key      → only main SA can read
  openclaw-main-brave-api-key       → only main SA can read
  openclaw-main-gateway-token       → only main SA can read
  openclaw-main-email-password      → only main SA can read
  openclaw-chai-alpaca-key-id       → only chai SA can read
  openclaw-chai-alpaca-secret-key   → only chai SA can read

Local disk:
  ~/.config/gcp/openclaw-main-sa.json  (SA key — the only secret on disk)
  ~/.config/gcp/openclaw-chai-sa.json  (SA key — the only secret on disk)
  openclaw.json                        (contains ${gcp:...} refs, safe to commit)
```

> **Note:** The SA key files are the one remaining secret on disk. Protect them with `chmod 600` and restrict filesystem access. On GKE or Cloud Run, use Workload Identity to eliminate even these files.

### External scripts

Scripts that need secrets (e.g., monitoring scripts, cron jobs) can also use per-agent SA keys:

```python
from google.cloud import secretmanager

# Use Chai's SA key — can only access openclaw-chai-* secrets
client = secretmanager.SecretManagerServiceClient.from_service_account_json(
    "/home/user/.config/gcp/openclaw-chai-sa.json"
)
response = client.access_secret_version(
    request={"name": "projects/my-project/secrets/openclaw-chai-alpaca-key-id/versions/latest"}
)
api_key = response.payload.data.decode("utf-8")
```

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
