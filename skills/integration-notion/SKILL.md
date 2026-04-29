---
name: integration-notion
description: "Set up and configure the Notion integration for OpenClaw: create a Notion internal connection, retrieve the API token, store credentials, register the notion skill, and grant page access. Use when asked to 'set up notion', 'connect notion', 'configure notion integration', or 'add notion to openclaw'."
homepage: https://developers.notion.com/reference/intro
user-invocable: true
metadata: { "openclaw": { "emoji": "🔗", "requires": { "bins": ["curl", "jq"] }, "install": [] } }
---

# integration-notion — Set Up Notion for OpenClaw

Guides the agent through configuring Notion API access for this OpenClaw instance.

## When to Use

- User asks to "set up Notion", "connect Notion", "configure Notion", or "add Notion integration"
- A skill or workflow needs Notion access and `~/.openclaw/credentials/notion.json` does not exist
- User wants to grant additional Notion page access to the integration

## Pre-flight Check

Before starting, check if Notion is already configured:

```bash
# Check for existing credential
if [ -f ~/.openclaw/credentials/notion.json ]; then
  NOTION_KEY=$(jq -r .token ~/.openclaw/credentials/notion.json)
  STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
    -H "Authorization: Bearer $NOTION_KEY" \
    -H "Notion-Version: 2025-09-03" \
    "https://api.notion.com/v1/users/me")
  if [ "$STATUS" = "200" ]; then
    echo "✅ Notion already configured and token is valid"
    exit 0
  else
    echo "⚠️ Credential file exists but token is invalid (HTTP $STATUS). Re-run setup."
  fi
else
  echo "No Notion credentials found. Starting setup..."
fi
```

## Phase 1 — Create Notion Internal Connection

1. Open https://www.notion.so/profile/integrations/internal in the browser
2. Click **"Create a new connection"**
3. Fill in:
   - **Connection name**: `OpenClaw` (or user's preferred name)
   - **Installable in**: Select the target workspace
4. Click **Create**
5. On the confirmation dialog, click **"Configure connection settings"**

## Phase 2 — Retrieve the API Token

1. On the edit connection page, find **"Installation access token"**
2. Click **"Show"** to reveal the token
3. If the snapshot shows masked dots (`•••`), extract the value via JavaScript on the token input field
4. Token starts with `ntn_` or `secret_`

## Phase 3 — Store Credentials

Save the token to the OpenClaw credentials store:

```bash
# Store in OpenClaw credentials (canonical location)
cat > ~/.openclaw/credentials/notion.json <<'EOF'
{"token":"ntn_YOUR_TOKEN_HERE"}
EOF
chmod 600 ~/.openclaw/credentials/notion.json
```

## Phase 4 — Register Skill in openclaw.json

Add the notion skill entry to `~/.openclaw/openclaw.json` under `skills.entries`:

```bash
# Read current config, add notion skill entry, write back
python3 -c "
import json
with open('$HOME/.openclaw/openclaw.json') as f:
    data = json.load(f)
data['skills']['entries']['notion'] = {
    'enabled': True,
    'apiKey': 'ntn_YOUR_TOKEN_HERE'
}
with open('$HOME/.openclaw/openclaw.json', 'w') as f:
    json.dump(data, f, indent=2)
print('✅ notion skill registered in openclaw.json')
"
```

> **Note:** `openclaw.json` only accepts `enabled` and `apiKey` as skill entry keys. Do not add custom keys like `credentialFile` — they will fail validation.

## Phase 5 — Grant Page Access

1. On the integration edit page, click the **"Content access"** tab
2. Click **"Edit access"**
3. In the modal, click **"Select all"** (or let the user choose specific pages)
4. Click **"Save"**

## Phase 6 — Verify

Test the integration end-to-end:

```bash
NOTION_KEY=$(jq -r .token ~/.openclaw/credentials/notion.json)
curl -s -X POST "https://api.notion.com/v1/search" \
  -H "Authorization: Bearer $NOTION_KEY" \
  -H "Notion-Version: 2025-09-03" \
  -H "Content-Type: application/json" \
  -d '{"query":"","page_size":3}' | jq '.results | length'
```

If the result is `> 0`, the integration is working.

## Phase 7 — Test via Agent

Run a quick agent test to confirm the skill is loaded:

```bash
openclaw agent --agent alice --local \
  --message "Use the notion skill: read token from ~/.openclaw/credentials/notion.json with jq -r .token, then search Notion for pages. Show page titles." \
  --timeout 120
```

## Troubleshooting

| Symptom                            | Cause                                 | Fix                                                   |
| ---------------------------------- | ------------------------------------- | ----------------------------------------------------- |
| `Config invalid: Unrecognized key` | Custom key in `skills.entries.notion` | Only use `enabled` and `apiKey`                       |
| `invalid_token` / HTTP 401         | Token expired or wrong                | Re-generate at notion.so/profile/integrations         |
| Search returns 0 results           | No page access granted                | Go to Content access tab → Edit access → select pages |
| `Could not validate credentials`   | Token from wrong workspace            | Ensure token matches the target workspace             |

## Credential Locations

| File                                  | Purpose                                             |
| ------------------------------------- | --------------------------------------------------- |
| `~/.openclaw/credentials/notion.json` | Canonical credential store (`{"token":"ntn_..."}`)  |
| `~/.openclaw/openclaw.json`           | Skill registration (`skills.entries.notion.apiKey`) |

## Notes

- The `notion` skill (separate from this integration skill) provides the Notion API reference (search, CRUD pages, databases, blocks)
- Notion API version `2025-09-03` is required — databases are called "data sources" in this version
- Rate limit: ~3 requests/second average
- Integration tokens are workspace-scoped — one token per workspace
