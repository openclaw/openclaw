---
name: monday
description: Monday.com task management via GraphQL API — view boards, tasks assigned to you, update status, and create new items.
homepage: https://developer.monday.com/api-reference
metadata:
  {
    "openclaw":
      {
        "emoji": "📋",
        "primaryEnv": "MONDAY_API_KEY",
        "requires": { "env": ["MONDAY_API_KEY"] },
        "install": [],
      },
  }
---

# monday

Manage Monday.com boards and tasks via the GraphQL API.

## API key setup

Set the key via the OpenClaw dashboard ("API key" field for this skill — recommended), or:

```bash
# CLI:
openclaw config set skills.entries.monday.apiKey YOUR_TOKEN_HERE

# Or state-dir dotenv (survives gateway restarts):
echo 'MONDAY_API_KEY=YOUR_TOKEN_HERE' >> ~/.openclaw/.env
openclaw gateway restart
```

Generate a token: Monday.com → Profile picture → Developers → My Access Tokens → Copy.

---

## IMPORTANT — token resolution

`$MONDAY_API_KEY` is injected by OpenClaw before skill execution. Every shell command runs in a **separate subprocess** — bash functions defined in one command are NOT available in the next. Each command block below is self-contained and resolves the token inline.

**Token resolution snippet** (include at the top of every command block):

```bash
MONDAY_API_KEY="${MONDAY_API_KEY:-}"
if [ -z "$MONDAY_API_KEY" ]; then
  MONDAY_API_KEY=$(jq -r '.skills.entries["monday"].apiKey // empty' "${OPENCLAW_CONFIG_PATH:-$HOME/.openclaw/openclaw.json}" 2>/dev/null)
fi
if [ -z "$MONDAY_API_KEY" ]; then
  echo "Error: MONDAY_API_KEY not set. Run: openclaw config set skills.entries.monday.apiKey YOUR_TOKEN" >&2
  exit 1
fi
```

---

## View boards

List all boards (id, name, state, item count):

```bash
MONDAY_API_KEY="${MONDAY_API_KEY:-}"
if [ -z "$MONDAY_API_KEY" ]; then
  MONDAY_API_KEY=$(jq -r '.skills.entries["monday"].apiKey // empty' "${OPENCLAW_CONFIG_PATH:-$HOME/.openclaw/openclaw.json}" 2>/dev/null)
fi

curl -s -X POST https://api.monday.com/v2 \
  -H "Content-Type: application/json" \
  -H "Authorization: $MONDAY_API_KEY" \
  -H "API-Version: 2024-01" \
  -d '{"query":"{ boards(limit:50) { id name description board_kind state items_count } }"}' \
  | jq '.data.boards[]'
```

Get columns of a specific board (needed before updating status — reveals column IDs):

```bash
MONDAY_API_KEY="${MONDAY_API_KEY:-}"
if [ -z "$MONDAY_API_KEY" ]; then
  MONDAY_API_KEY=$(jq -r '.skills.entries["monday"].apiKey // empty' "${OPENCLAW_CONFIG_PATH:-$HOME/.openclaw/openclaw.json}" 2>/dev/null)
fi
BOARD_ID=1234567890

curl -s -X POST https://api.monday.com/v2 \
  -H "Content-Type: application/json" \
  -H "Authorization: $MONDAY_API_KEY" \
  -H "API-Version: 2024-01" \
  -d "{\"query\":\"{ boards(ids: $BOARD_ID) { columns { id title type } } }\"}" \
  | jq '.data.boards[0].columns[]'
```

List groups on a board:

```bash
MONDAY_API_KEY="${MONDAY_API_KEY:-}"
if [ -z "$MONDAY_API_KEY" ]; then
  MONDAY_API_KEY=$(jq -r '.skills.entries["monday"].apiKey // empty' "${OPENCLAW_CONFIG_PATH:-$HOME/.openclaw/openclaw.json}" 2>/dev/null)
fi
BOARD_ID=1234567890

curl -s -X POST https://api.monday.com/v2 \
  -H "Content-Type: application/json" \
  -H "Authorization: $MONDAY_API_KEY" \
  -H "API-Version: 2024-01" \
  -d "{\"query\":\"{ boards(ids: $BOARD_ID) { groups { id title } } }\"}" \
  | jq '.data.boards[0].groups[]'
```

---

## View tasks assigned to me

Get your user ID first:

```bash
MONDAY_API_KEY="${MONDAY_API_KEY:-}"
if [ -z "$MONDAY_API_KEY" ]; then
  MONDAY_API_KEY=$(jq -r '.skills.entries["monday"].apiKey // empty' "${OPENCLAW_CONFIG_PATH:-$HOME/.openclaw/openclaw.json}" 2>/dev/null)
fi

curl -s -X POST https://api.monday.com/v2 \
  -H "Content-Type: application/json" \
  -H "Authorization: $MONDAY_API_KEY" \
  -H "API-Version: 2024-01" \
  -d '{"query":"{ me { id name email } }"}' \
  | jq '.data.me'
```

Get items assigned to you on a specific board (replace ME_ID with your numeric user id):

```bash
MONDAY_API_KEY="${MONDAY_API_KEY:-}"
if [ -z "$MONDAY_API_KEY" ]; then
  MONDAY_API_KEY=$(jq -r '.skills.entries["monday"].apiKey // empty' "${OPENCLAW_CONFIG_PATH:-$HOME/.openclaw/openclaw.json}" 2>/dev/null)
fi
BOARD_ID=1234567890
ME_ID=12345678

curl -s -X POST https://api.monday.com/v2 \
  -H "Content-Type: application/json" \
  -H "Authorization: $MONDAY_API_KEY" \
  -H "API-Version: 2024-01" \
  -d "{\"query\":\"{ boards(ids: $BOARD_ID) { items_page(limit: 100, query_params: {rules: [{column_id: \\\"person\\\", compare_value: [\\\"$ME_ID\\\"]}]}) { items { id name state column_values { id title text } } } } }\"}" \
  | jq '.data.boards[0].items_page.items[]'
```

Get a single item by ID:

```bash
MONDAY_API_KEY="${MONDAY_API_KEY:-}"
if [ -z "$MONDAY_API_KEY" ]; then
  MONDAY_API_KEY=$(jq -r '.skills.entries["monday"].apiKey // empty' "${OPENCLAW_CONFIG_PATH:-$HOME/.openclaw/openclaw.json}" 2>/dev/null)
fi
ITEM_ID=9876543210

curl -s -X POST https://api.monday.com/v2 \
  -H "Content-Type: application/json" \
  -H "Authorization: $MONDAY_API_KEY" \
  -H "API-Version: 2024-01" \
  -d "{\"query\":\"{ items(ids: [$ITEM_ID]) { id name state board { name } column_values { id title text } } }\"}" \
  | jq '.data.items[0]'
```

---

## Update task status

First check what status labels the board uses (so you can pass the exact label string):

```bash
MONDAY_API_KEY="${MONDAY_API_KEY:-}"
if [ -z "$MONDAY_API_KEY" ]; then
  MONDAY_API_KEY=$(jq -r '.skills.entries["monday"].apiKey // empty' "${OPENCLAW_CONFIG_PATH:-$HOME/.openclaw/openclaw.json}" 2>/dev/null)
fi
BOARD_ID=1234567890

curl -s -X POST https://api.monday.com/v2 \
  -H "Content-Type: application/json" \
  -H "Authorization: $MONDAY_API_KEY" \
  -H "API-Version: 2024-01" \
  -d "{\"query\":\"{ boards(ids: $BOARD_ID) { columns { id title type settings_str } } }\"}" \
  | jq '.data.boards[0].columns[] | select(.type=="color") | {id, title, labels: (.settings_str | fromjson | .labels)}'
```

Update an item's status (COLUMN_ID is the `id` field from the columns query, usually `"status"`):

```bash
MONDAY_API_KEY="${MONDAY_API_KEY:-}"
if [ -z "$MONDAY_API_KEY" ]; then
  MONDAY_API_KEY=$(jq -r '.skills.entries["monday"].apiKey // empty' "${OPENCLAW_CONFIG_PATH:-$HOME/.openclaw/openclaw.json}" 2>/dev/null)
fi
ITEM_ID=9876543210
BOARD_ID=1234567890
COLUMN_ID="status"
LABEL="Done"

curl -s -X POST https://api.monday.com/v2 \
  -H "Content-Type: application/json" \
  -H "Authorization: $MONDAY_API_KEY" \
  -H "API-Version: 2024-01" \
  -d "{\"query\":\"mutation { change_column_value(item_id: $ITEM_ID, board_id: $BOARD_ID, column_id: \\\"$COLUMN_ID\\\", value: \\\"{\\\\\\\"label\\\\\\\": \\\\\\\"$LABEL\\\\\\\"}\\\") { id name } }\"}" \
  | jq '.data.change_column_value'
```

---

## Create a new task

Basic item on a board:

```bash
MONDAY_API_KEY="${MONDAY_API_KEY:-}"
if [ -z "$MONDAY_API_KEY" ]; then
  MONDAY_API_KEY=$(jq -r '.skills.entries["monday"].apiKey // empty' "${OPENCLAW_CONFIG_PATH:-$HOME/.openclaw/openclaw.json}" 2>/dev/null)
fi
BOARD_ID=1234567890
ITEM_NAME="New task name"

curl -s -X POST https://api.monday.com/v2 \
  -H "Content-Type: application/json" \
  -H "Authorization: $MONDAY_API_KEY" \
  -H "API-Version: 2024-01" \
  -d "{\"query\":\"mutation { create_item(board_id: $BOARD_ID, item_name: \\\"$ITEM_NAME\\\") { id name } }\"}" \
  | jq '.data.create_item'
```

Item in a specific group (use groups query to find GROUP_ID):

```bash
MONDAY_API_KEY="${MONDAY_API_KEY:-}"
if [ -z "$MONDAY_API_KEY" ]; then
  MONDAY_API_KEY=$(jq -r '.skills.entries["monday"].apiKey // empty' "${OPENCLAW_CONFIG_PATH:-$HOME/.openclaw/openclaw.json}" 2>/dev/null)
fi
BOARD_ID=1234567890
GROUP_ID="topics"
ITEM_NAME="New task name"

curl -s -X POST https://api.monday.com/v2 \
  -H "Content-Type: application/json" \
  -H "Authorization: $MONDAY_API_KEY" \
  -H "API-Version: 2024-01" \
  -d "{\"query\":\"mutation { create_item(board_id: $BOARD_ID, group_id: \\\"$GROUP_ID\\\", item_name: \\\"$ITEM_NAME\\\") { id name } }\"}" \
  | jq '.data.create_item'
```

---

## Other operations

Search items by name on a board:

```bash
MONDAY_API_KEY="${MONDAY_API_KEY:-}"
if [ -z "$MONDAY_API_KEY" ]; then
  MONDAY_API_KEY=$(jq -r '.skills.entries["monday"].apiKey // empty' "${OPENCLAW_CONFIG_PATH:-$HOME/.openclaw/openclaw.json}" 2>/dev/null)
fi
BOARD_ID=1234567890
TERM="deploy"

curl -s -X POST https://api.monday.com/v2 \
  -H "Content-Type: application/json" \
  -H "Authorization: $MONDAY_API_KEY" \
  -H "API-Version: 2024-01" \
  -d "{\"query\":\"{ boards(ids: $BOARD_ID) { items_page(limit: 50, query_params: {rules: [{column_id: \\\"name\\\", compare_value: [\\\"$TERM\\\"], operator: contains_text}]}) { items { id name column_values { id text } } } } }\"}" \
  | jq '.data.boards[0].items_page.items[]'
```

Add a comment to an item:

```bash
MONDAY_API_KEY="${MONDAY_API_KEY:-}"
if [ -z "$MONDAY_API_KEY" ]; then
  MONDAY_API_KEY=$(jq -r '.skills.entries["monday"].apiKey // empty' "${OPENCLAW_CONFIG_PATH:-$HOME/.openclaw/openclaw.json}" 2>/dev/null)
fi
ITEM_ID=9876543210
BODY="Comment text here"

curl -s -X POST https://api.monday.com/v2 \
  -H "Content-Type: application/json" \
  -H "Authorization: $MONDAY_API_KEY" \
  -H "API-Version: 2024-01" \
  -d "{\"query\":\"mutation { create_update(item_id: $ITEM_ID, body: \\\"$BODY\\\") { id } }\"}" \
  | jq '.data.create_update'
```

---

## Diagnostics

Verify token and connectivity:

```bash
MONDAY_API_KEY="${MONDAY_API_KEY:-}"
if [ -z "$MONDAY_API_KEY" ]; then
  MONDAY_API_KEY=$(jq -r '.skills.entries["monday"].apiKey // empty' "${OPENCLAW_CONFIG_PATH:-$HOME/.openclaw/openclaw.json}" 2>/dev/null)
fi

echo "Token present: $([ -n "$MONDAY_API_KEY" ] && echo YES || echo NO)"
echo "Token prefix:  ${MONDAY_API_KEY:0:10}..."

curl -s -X POST https://api.monday.com/v2 \
  -H "Content-Type: application/json" \
  -H "Authorization: $MONDAY_API_KEY" \
  -H "API-Version: 2024-01" \
  -d '{"query":"{ me { id name } }"}' \
  | jq '.'
```

If token is missing, set it:

```bash
openclaw config set skills.entries.monday.apiKey YOUR_TOKEN_HERE
```

---

## Notes

- Each command resolves `$MONDAY_API_KEY` inline — bash functions do not persist across shell subprocesses.
- Authorization header format: `Authorization: <token>` (no `Bearer` prefix) — Monday.com personal API tokens are JWTs sent as-is.
- Confirm before mutating (status changes, creates) — Monday.com has no undo via API.
- Board IDs and item IDs are numeric integers — do not quote them in GraphQL fields.
- Status column labels must match exactly (case-sensitive) labels defined on the board.
- Column IDs are snake_case strings from the `id` field of the columns query, not the display title.
- Monday.com API rate limit: 60 requests/minute per token.
