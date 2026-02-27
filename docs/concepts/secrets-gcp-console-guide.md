# GCP Console Setup Guide

Step-by-step instructions for setting up GCP Secret Manager via the Google Cloud Console (no CLI required).

---

## 1. Enable Secret Manager API

1. Go to [APIs & Services → Library](https://console.cloud.google.com/apis/library)
2. Search for **"Secret Manager"**
3. Click **Secret Manager API**
4. Click **ENABLE**

Also enable these (needed for IAM and service accounts):

- **Identity and Access Management (IAM) API**
- **Cloud Resource Manager API**

## 2. Update VM OAuth Scopes

> ⚠️ This requires stopping the VM (brief downtime).

1. Go to [Compute Engine → VM instances](https://console.cloud.google.com/compute/instances)
2. **Stop** the VM (click the three dots → Stop)
3. Click the VM name to open details
4. Click **EDIT**
5. Scroll to **Identity and API access → Access scopes**
6. Select **"Allow full access to all Cloud APIs"**
7. Click **SAVE**
8. **Start** the VM

## 3. Grant IAM Roles to Compute Service Account

1. Go to [IAM & Admin → IAM](https://console.cloud.google.com/iam-admin/iam)
2. Find your compute service account (looks like `<project-number>-compute@developer.gserviceaccount.com`)
3. Click the **pencil icon** (Edit principal)
4. Click **+ ADD ANOTHER ROLE** and add:
   - **Secret Manager Secret Accessor** — allows reading secret values
   - **Secret Manager Admin** — allows creating secrets and setting IAM bindings
5. Click **SAVE**

## 4. Create Per-Agent Service Accounts

1. Go to [IAM & Admin → Service Accounts](https://console.cloud.google.com/iam-admin/serviceaccounts)
2. Click **+ CREATE SERVICE ACCOUNT**
3. Fill in:
   - **Name:** `openclaw-main`
   - **Description:** "OpenClaw main agent"
4. Click **CREATE AND CONTINUE**
5. Skip the role grants (we'll set per-secret bindings instead)
6. Click **DONE**
7. Repeat for each agent (e.g., `openclaw-chai`)

### Generate Key Files

1. Click on the service account you just created
2. Go to the **KEYS** tab
3. Click **ADD KEY → Create new key**
4. Select **JSON** format
5. Click **CREATE** — a `.json` file downloads
6. Upload it to your VM at `~/.config/gcp/openclaw-<agent>-sa.json`
7. Set permissions: `chmod 600 ~/.config/gcp/*.json`

## 5. Store Secrets

1. Go to [Security → Secret Manager](https://console.cloud.google.com/security/secret-manager)
2. Click **+ CREATE SECRET**
3. Fill in:
   - **Name:** Use the naming convention: `openclaw-<agent>-<purpose>`
     - Example: `openclaw-main-openai-api-key`
     - Example: `openclaw-chai-alpaca-key-id`
   - **Secret value:** Paste the actual key/token/password
4. Click **CREATE SECRET**
5. Repeat for each secret

### Naming Convention

| Pattern             | Who can read    | Example                         |
| ------------------- | --------------- | ------------------------------- |
| `openclaw-main-*`   | Main agent only | `openclaw-main-openai-api-key`  |
| `openclaw-chai-*`   | Chai agent only | `openclaw-chai-alpaca-key-id`   |
| `openclaw-shared-*` | All agents      | `openclaw-shared-brave-api-key` |

## 6. Set Per-Secret IAM Bindings

This is the key step that enforces isolation — each agent can **only** read secrets with its prefix.

1. Go to [Security → Secret Manager](https://console.cloud.google.com/security/secret-manager)
2. Click on a secret (e.g., `openclaw-main-openai-api-key`)
3. Go to the **PERMISSIONS** tab
4. Click **+ GRANT ACCESS**
5. Fill in:
   - **New principals:** `openclaw-main@<project>.iam.gserviceaccount.com`
   - **Role:** `Secret Manager Secret Accessor`
6. Click **SAVE**
7. Repeat for each secret, granting access only to the correct agent's SA

### Example Bindings

| Secret                            | Grant access to                                  |
| --------------------------------- | ------------------------------------------------ |
| `openclaw-main-openai-api-key`    | `openclaw-main@project.iam.gserviceaccount.com`  |
| `openclaw-main-gateway-token`     | `openclaw-main@project.iam.gserviceaccount.com`  |
| `openclaw-main-brave-api-key`     | `openclaw-main@project.iam.gserviceaccount.com`  |
| `openclaw-chai-alpaca-key-id`     | `openclaw-chai@project.iam.gserviceaccount.com`  |
| `openclaw-chai-alpaca-secret-key` | `openclaw-chai@project.iam.gserviceaccount.com`  |
| `openclaw-shared-some-key`        | Both `openclaw-main@...` AND `openclaw-chai@...` |

## 7. Update OpenClaw Config

Edit `openclaw.json` to add the secrets configuration:

```json5
{
  secrets: {
    providers: {
      gcp: {
        project: "your-project-id",
        credentialsFile: "/home/user/.config/gcp/openclaw-main-sa.json",
      },
    },
  },
}
```

Replace plaintext values with secret references:

```json5
{
  // Before
  "apiKey": "sk-real-key-here"

  // After
  "apiKey": "${gcp:openclaw-main-openai-api-key}"
}
```

## 8. Purge Plaintext Files

> ⚠️ Only do this AFTER verifying secrets resolve correctly!

Replace the contents of credential files with migration notes:

```bash
echo "# Migrated to GCP Secret Manager" > ~/.config/openai/credentials.env
echo "# Migrated to GCP Secret Manager" > ~/.config/google/gemini.env
echo "# Migrated to GCP Secret Manager" > ~/.config/himalaya/.nine30-pass
```

## Verification

After everything is set up, verify isolation:

1. Go to [Secret Manager](https://console.cloud.google.com/security/secret-manager)
2. Click a main-agent secret (e.g., `openclaw-main-openai-api-key`)
3. Go to **PERMISSIONS** tab
4. Confirm only `openclaw-main@...` has `Secret Manager Secret Accessor`
5. Click a chai-agent secret
6. Confirm only `openclaw-chai@...` has access

If an agent tries to read another agent's secret, GCP returns `PERMISSION_DENIED`.

---

## Troubleshooting

| Problem                                                | Solution                                                                                                                                    |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `ACCESS_TOKEN_SCOPE_INSUFFICIENT`                      | VM needs `cloud-platform` scope (Step 2)                                                                                                    |
| `PERMISSION_DENIED` on `secretmanager.secrets.create`  | Compute SA needs `Secret Manager Admin` role (Step 3)                                                                                       |
| `PERMISSION_DENIED` on `secretmanager.versions.access` | Agent SA needs `Secret Accessor` on that specific secret (Step 6)                                                                           |
| `PERMISSION_DENIED` on `setIamPolicy`                  | Compute SA needs `Secret Manager Admin` role (Step 3). Cannot be done from the VM itself — do it from Console or local gcloud.              |
| Secrets resolve but agent reads wrong agent's secret   | Per-secret bindings not set (Step 6). Project-level `secretAccessor` overrides per-secret bindings — remove it from compute SA after setup. |
