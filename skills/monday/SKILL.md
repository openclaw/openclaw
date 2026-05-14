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

Set the key via the OpenClaw dashboard (recommended — the "API key" field for this skill), or:

```bash
# Option A: state-dir dotenv (persists across gateway restarts)
echo 'MONDAY_API_KEY=your_token_here' >> ~/.openclaw/.env
openclaw gateway restart

# Option B: skill config directly
openclaw config set skills.entries.monday.apiKey your_token_here
```

**Do not** add it manually to `~/.openclaw/service-env/*.env` or `~/.openclaw/openclaw.json env` — those paths are fragile without a full `openclaw gateway install` cycle.

Generate a token: Monday.com → Profile picture → Developers → My Access Tokens → Copy.

---

## Helper — resolve token

All commands use this helper. It reads from the injected env first, then falls back to the skill config in the openclaw.json:

```bash
monday_token() {
  local tok="${MONDAY_API_KEY:-}"
  if [ -z "$tok" ] && [ -n "${OPENCLAW_CONFIG_PATH:-}" ]; then
    tok=$(jq -r '.skills.entries["monday"].apiKey // empty' "$OPENCLAW_CONFIG_PATH" 2>/dev/null || true)
  fi
  if [ -z "$tok" ] && [ -f "${HOME}/.openclaw/openclaw.json" ]; then
    tok=$(jq -r '.skills.entries["monday"].apiKey // empty' "${HOME}/.openclaw/openclaw.json" 2>/dev/null || true)
  fi
  if [ -z "$tok" ]; then
    echo "Error: MONDAY_API_KEY is not set. Add it via the OpenClaw dashboard or set it in ~/.openclaw/.env" >&2
    return 1
  fi
  printf '%s' "$tok"
}

monday_gql() {
  local query="$1"
  local token
  token=$(monday_token) || return 1
  curl -s -X POST https://api.monday.com/v2 \
    -H "Content-Type: application/json" \
    -H "Authorization: $token" \
    -H "API-Version: 2024-01" \
    -d "$query"
}
```

---

## View boards

List all boards (id, name, state):

```bash
monday_gql '{"query":"{ boards(limit:50) { id name description board_kind state items_count } }"}' \
  | jq '.data.boards[]'
```

Get columns of a specific board (needed to know column IDs before updating status):

```bash
BOARD_ID=1234567890
monday_gql "{\"query\":\"{ boards(ids: $BOARD_ID) { columns { id title type } } }\"}" \
  | jq '.data.boards[0].columns[]'
```

List groups on a board:

```bash
BOARD_ID=1234567890
monday_gql "{\"query\":\"{ boards(ids: $BOARD_ID) { groups { id title } } }\"}" \
  | jq '.data.boards[0].groups[]'
```

---

## View tasks assigned to me

Get your user ID:

```bash
monday_gql '{"query":"{ me { id name email } }"}' | jq '.data.me'
```

Get all items where you are assigned (person column), on a specific board:

```bash
BOARD_ID=1234567890
ME_ID=12345678   # from the me query above

monday_gql "{\"query\":\"{ boards(ids: $BOARD_ID) { items_page(limit: 100, query_params: {rules: [{column_id: \\\"person\\\", compare_value: [\\\"$ME_ID\\\"]}]}) { items { id name state column_values { id title text } } } } }\"}" \
  | jq '.data.boards[0].items_page.items[]'
```

Get a single item by ID:

```bash
ITEM_ID=9876543210
monday_gql "{\"query\":\"{ items(ids: [$ITEM_ID]) { id name state board { name } column_values { id title text } } }\"}" \
  | jq '.data.items[0]'
```

---

## Update task status

First check what status labels exist on the board's status column:

```bash
BOARD_ID=1234567890
monday_gql "{\"query\":\"{ boards(ids: $BOARD_ID) { columns { id title type settings_str } } }\"}" \
  | jq '.data.boards[0].columns[] | select(.type=="color") | {id, title, settings: (.settings_str | fromjson | .labels)}'
```

Update status by label (must match exactly, case-sensitive):

```bash
ITEM_ID=9876543210
BOARD_ID=1234567890
COLUMN_ID="status"   # from columns query above
LABEL="Done"

monday_gql "{\"query\":\"mutation { change_column_value(item_id: $ITEM_ID, board_id: $BOARD_ID, column_id: \\\"$COLUMN_ID\\\", value: \\\"{\\\\\\\"label\\\\\\\": \\\\\\\"$LABEL\\\\\\\"}\\\") { id name } }\"}" \
  | jq '.data.change_column_value'
```

---

## Create a new task

Basic item on a board:

```bash
BOARD_ID=1234567890
ITEM_NAME="New task name"

monday_gql "{\"query\":\"mutation { create_item(board_id: $BOARD_ID, item_name: \\\"$ITEM_NAME\\\") { id name } }\"}" \
  | jq '.data.create_item'
```

Item in a specific group with status pre-set:

```bash
BOARD_ID=1234567890
GROUP_ID="topics"   # from groups query
ITEM_NAME="New task name"
COLUMN_JSON='{"status": {"label": "Working on it"}}'
ESCAPED_COL=$(printf '%s' "$COLUMN_JSON" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')

monday_gql "{\"query\":\"mutation { create_item(board_id: $BOARD_ID, group_id: \\\"$GROUP_ID\\\", item_name: \\\"$ITEM_NAME\\\", column_values: $ESCAPED_COL) { id name } }\"}" \
  | jq '.data.create_item'
```

---

## Other useful operations

Search items by name on a board:

```bash
BOARD_ID=1234567890
TERM="deploy"

monday_gql "{\"query\":\"{ boards(ids: $BOARD_ID) { items_page(limit: 50, query_params: {rules: [{column_id: \\\"name\\\", compare_value: [\\\"$TERM\\\"], operator: contains_text}]}) { items { id name column_values { id text } } } } }\"}" \
  | jq '.data.boards[0].items_page.items[]'
```

Add a comment to an item:

```bash
ITEM_ID=9876543210
BODY="Comment text here"

monday_gql "{\"query\":\"mutation { create_update(item_id: $ITEM_ID, body: \\\"$BODY\\\") { id } }\"}" \
  | jq '.data.create_update'
```

---

## Troubleshooting

If `$MONDAY_API_KEY` is empty in the shell even though you've set it:

1. Check skill config: `jq '.skills.entries["monday"]' ~/.openclaw/openclaw.json`
2. Set via CLI: `openclaw config set skills.entries.monday.apiKey YOUR_TOKEN`
3. Or add to state-dir dotenv and restart: `echo 'MONDAY_API_KEY=YOUR_TOKEN' >> ~/.openclaw/.env && openclaw gateway restart`

The `monday_token()` helper above reads from both `$MONDAY_API_KEY` env and the config file, so it works regardless of how the key was stored.

---

## Notes

- Confirm before mutating items (status changes, creates) — Monday.com has no undo via API.
- Board IDs and item IDs are numeric — do not quote them in GraphQL integer fields.
- Status column labels must match exactly (case-sensitive) the labels defined on the board.
- Column IDs are snake_case strings from the columns query (`id` field), not the display title.
- Monday.com API rate limit: 60 requests/minute per token.
- Use `API-Version: 2024-01` header for stable behavior.
