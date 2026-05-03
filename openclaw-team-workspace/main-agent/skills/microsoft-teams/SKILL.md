---
name: microsoft-teams
description: microsoft teams integration through composio v3 for listing teams, channels, chats, users, messages, and meetings. use when claude needs to work with microsoft teams via composio v3 SDK, especially to read teams data, send or reply to messages, create chats or meetings, or recover from microsoft teams authentication and connected-account issues in composio-based agents.
---

# Microsoft Teams (Composio v3 SDK)

Use the **current Composio v3 SDK** patterns exclusively. Do not use legacy `ComposioToolSet`, `App`, `entity.initiate_connection(...)`, `Action.*` enums, or `toolset.execute_action(...)`.

## Required environment

- `COMPOSIO_API_KEY`
- Network access
- Teams **auth config ID** (starts with `ac_`) — create once in the Composio dashboard
- Python Venv: `~/.openclaw/composio-venv/bin/python3`

## v2 → v3 Breaking Changes (summary)

| Concern             | v2 (legacy — do NOT use)                                      | v3 (current)                                                                                                                 |
| ------------------- | ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Client init         | `ComposioToolSet(api_key=...)`                                | `Composio(api_key=...)`                                                                                                      |
| Tool execution      | `toolset.execute_action(action=Action.TEAMS_LIST_TEAMS, ...)` | `composio.tools.execute("MICROSOFT_TEAMS_TEAMS_LIST", user_id=..., arguments={...})`                                         |
| Action names        | Python Enum e.g. `Action.MICROSOFTTEAMS_SEND_MESSAGE`         | String slug e.g. `"MICROSOFT_TEAMS_TEAMS_POST_CHAT_MESSAGE"`                                                                 |
| Auth initiation     | `entity.initiate_connection(app=App.MICROSOFTTEAMS)`          | `composio.connected_accounts.link(user_id=..., auth_config_id=...)`                                                          |
| Connection check    | `entity.get_connections()`                                    | `composio.connected_accounts.list(user_ids=[user_id])`                                                                       |
| Version enforcement | not required                                                  | pass `toolkit_versions={"microsoft_teams": "latest"}` at init, or use `dangerously_skip_version_check=True` for ad-hoc calls |
| User concept        | "entity"                                                      | `user_id` (string, your own identifier)                                                                                      |

## Authentication model

- **auth config** (`ac_...`): the auth blueprint for a toolkit — created once, reused for all users
- **connected account** (`ca_...`): a specific user's authenticated account
- **user_id**: your own string identifier for a user (e.g. `"tala"`)

## Default authentication workflow

1. Check whether `user_id` already has an active Teams connected account.
2. If active account exists → reuse it; no new link needed.
3. If no active account → call `composio.connected_accounts.link(...)` to get a hosted redirect URL.
4. Send the user **one link** and wait for confirmation.
5. Call `connection_request.wait_for_connection()` or re-list accounts before continuing.

Do not repeatedly generate fresh links unless the previous one expired.

## User-facing auth message

```
Microsoft Teams is not connected in Composio yet.
Please open this link and authorize your Microsoft Teams account:
<URL>
Once done, tell me and I'll continue.
```

## Python snippets

### 1) Initialize client

```python
import os
from composio import Composio

composio = Composio(
 api_key=os.environ["COMPOSIO_API_KEY"],
 # toolkit_versions={"microsoft_teams": "latest"} # or pin to specific version
)
```

### 2) Check for existing active Teams connection

```python
user_id = "tala"

accounts = composio.connected_accounts.list(user_ids=[user_id])
teams_accounts = [
 a for a in accounts.items
 if getattr(a, "status", "") == "ACTIVE"
]
# Note: In v3, toolkit/app info may be nested or requires checking toolkits.get()
```

### 3) Generate hosted auth link (Connect Link — preferred)

```python
auth_config_id = "ac_OIgA6c7QPrwI" # verified for this environment

connection_request = composio.connected_accounts.initiate(
 user_id=user_id,
 auth_config_id=auth_config_id
)

print(f"Visit: {connection_request.redirect_url}")
```

### 4) Find or Create a Chat (v3 Pattern)

Note: V3 requires underscores for OData fields (e.g., `user_odata_bind`) and explicit `roles`.

```python
# Create chat requires specific field naming:
res = composio.tools.execute(
    'MICROSOFT_TEAMS_TEAMS_CREATE_CHAT',
    {
        'chatType': 'oneOnOne',
        'members': [
            {'user_odata_bind': f'https://graph.microsoft.com/v1.0/users/{my_id}', 'roles': ['owner']},
            {'user_odata_bind': f'https://graph.microsoft.com/v1.0/users/{target_id}', 'roles': ['owner']}
        ]
    },
    user_id='tala',
    connected_account_id='ca_ZkOiksT0I4-r',
    dangerously_skip_version_check=True
)
```

### 5) Execute a tool (direct execution)

All calls require: tool slug (string), `user_id`, and `arguments` dict.
**Crucial Parameter Names:**

- Use `content` for the message body (not `message`).
- Use `chat_id` for the target.
- For user searches, use the `filter` argument with OData syntax: `startswith(displayName,'Name')`.

```python
result = composio.tools.execute(
 "MICROSOFT_TEAMS_TEAMS_POST_CHAT_MESSAGE",
 user_id=user_id,
 arguments={"chat_id": "...", "content": "Hello World"},
 connected_account_id="ca_ZkOiksT0I4-r",
 dangerously_skip_version_check=True
)
```

## Key Tool Slugs (v3)

| Slug                                      | Description                                  |
| ----------------------------------------- | -------------------------------------------- |
| `MICROSOFT_TEAMS_CHATS_GET_ALL_CHATS`     | List recent chats                            |
| `MICROSOFT_TEAMS_CHATS_GET_ALL_MESSAGES`  | Fetch messages (requires `chat_id`)          |
| `MICROSOFT_TEAMS_TEAMS_POST_CHAT_MESSAGE` | Send message (requires `chat_id`, `content`) |
| `MICROSOFT_TEAMS_GET_MY_PROFILE`          | Verify current user                          |

**To discover slugs at runtime:**

```python
tools = composio.tools.get(user_id=user_id, toolkits=["microsoft_teams"])
for t in tools:
 print(t["function"]["name"])
```

## Read-only actions (no confirmation needed)

- `MICROSOFT_TEAMS_CHATS_GET_ALL_CHATS`
- `MICROSOFT_TEAMS_CHATS_GET_ALL_MESSAGES`
- `MICROSOFT_TEAMS_GET_MY_PROFILE`

## Destructive or user-visible actions (require confirmation)

Before executing any of the following, summarize the action and ask for explicit approval:

- `MICROSOFT_TEAMS_TEAMS_POST_CHAT_MESSAGE` — send chat message
- `MICROSOFT_TEAMS_TEAMS_POST_CHANNEL_MESSAGE` — post to channel
- `MICROSOFT_TEAMS_TEAMS_CREATE_CHAT` — create new chat

Confirmation format:

```
Before I proceed, please confirm:

Action: [what you are about to do]
To: [recipient / chat / channel / team]
Message: "[message content if applicable]"

Reply yes to confirm or no to cancel.
```

## Messaging workflow

1. Search for existing 1:1 chat via `MICROSOFT_TEAMS_CHATS_GET_ALL_CHATS`.
2. If the user name matches a known chat, reuse that `chat_id`.
3. Ask for confirmation with final message text.
4. Send only after explicit approval via `MICROSOFT_TEAMS_TEAMS_POST_CHAT_MESSAGE`.

## Failure handling

| Symptom                      | Cause                    | Fix                                                         |
| ---------------------------- | ------------------------ | ----------------------------------------------------------- |
| `COMPOSIO_API_KEY` missing   | env not set              | Set `COMPOSIO_API_KEY`                                      |
| No active account            | user not authenticated   | Generate connect link                                       |
| Tool call rejected — version | toolkit version mismatch | Pass `dangerously_skip_version_check=True`                  |
| Missing fields               | SDK parameter change     | Check tool schema; e.g., use `content` instead of `message` |

## Do not do these

- Do not use `Action.MICROSOFTTEAMS_*` enums.
- Do not use `toolset.execute_action(...)`.
- Do not open multiple auth links unnecessarily.
- Do not silently send anything without confirmation.
