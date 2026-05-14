---
name: microsoft-teams
description: microsoft teams integration through composio v3 for listing teams, channels, chats, users, messages, and meetings. use when claude needs to work with microsoft teams via composio v3 sdk, especially to read teams data, send or reply to messages, create chats or meetings, or recover from microsoft teams authentication and connected-account issues in composio-based agents.
---

# Microsoft Teams (Composio v3 SDK)

Use the **current Composio v3 SDK** patterns exclusively.

Do **not** use legacy `ComposioToolSet`, `App`, `entity.initiate_connection(...)`, `Action.*` enums, `toolset.execute_action(...)`, or `composio.actions.execute(...)`.

---

## Required Environment

| Variable                         | Description                        |
| -------------------------------- | ---------------------------------- |
| `COMPOSIO_API_KEY`               | Composio API key                   |
| `COMPOSIO_USER_ID`               | Stable app-side user identifier    |
| `MICROSOFT_TEAMS_AUTH_CONFIG_ID` | Auth config ID starting with `ac_` |

- Network access required
- Python venv: `/opt/skills-venv/bin/python3`
- Python package: `composio` — **not** `composio-core`

Use `/opt/skills-venv/bin/python3` for all Python commands.

> ❌ Do **not** create `./venv`.  
> ❌ Do **not** run `pip install` during normal task execution. If `from composio import Composio` fails, report that the Docker image is missing the `composio` package.

---

## Runtime Verification

Before first Teams use in a fresh container, run:

```bash
/opt/skills-venv/bin/python3 - <<'PY'
import os
from composio import Composio
import inspect

required = [
    "COMPOSIO_API_KEY",
    "COMPOSIO_USER_ID",
    "MICROSOFT_TEAMS_AUTH_CONFIG_ID",
]

missing = [name for name in required if not os.environ.get(name)]
if missing:
    raise RuntimeError(f"Missing required env vars: {', '.join(missing)}")

composio = Composio(api_key=os.environ["COMPOSIO_API_KEY"])

print("has_tools=", hasattr(composio, "tools"))
print("has_actions=", hasattr(composio, "actions"))
print("has_connected_accounts=", hasattr(composio, "connected_accounts"))

if not hasattr(composio, "tools"):
    raise RuntimeError("Installed Composio SDK does not expose composio.tools. Install the `composio` package, not deprecated `composio-core`.")

if not hasattr(composio, "connected_accounts"):
    raise RuntimeError("Installed Composio SDK does not expose connected_accounts.")

for name in ["initiate", "link", "list"]:
    if hasattr(composio.connected_accounts, name):
        print(f"connected_accounts.{name}:", inspect.signature(getattr(composio.connected_accounts, name)))
PY
```

Expected output:

```
has_tools= True
has_actions= False
has_connected_accounts= True
```

> If `has_actions=True` and `has_tools=False`, the container is using deprecated `composio-core`. Stop and report the image/package mismatch.

---

## Concepts

| Term                   | Description                                                          |
| ---------------------- | -------------------------------------------------------------------- |
| `auth_config_id`       | Composio auth blueprint for Microsoft Teams. Starts with `ac_`.      |
| `user_id`              | Stable app-side user identifier, from `COMPOSIO_USER_ID`.            |
| `connected_account_id` | Actual authenticated Teams connection. Starts with `ca_`.            |
| `chat_id`              | Microsoft Teams chat/conversation target used when sending messages. |

> Use the same `COMPOSIO_USER_ID` every time for the same human. Changing it will make Composio treat the user as a different account and may require re-authentication.

---

## Authentication Workflow

1. Check whether `COMPOSIO_USER_ID` already has an active Teams connected account.
2. If an active account exists, reuse its `connected_account_id`.
3. If no active account exists, call `composio.connected_accounts.initiate(user_id=..., auth_config_id=...)`.
4. Send the user **exactly one** redirect URL.
5. Wait for the user to confirm they completed auth, or use `wait_for_connection()` only when the process is expected to block.
6. Print the `connected_account_id`; do not try to persist it with `os.environ[...]` inside Python.

> ❌ Do not repeatedly generate fresh auth links unless the previous one expired.

### User-Facing Auth Message

```
Microsoft Teams is not connected in Composio yet.

Please open this link and authorize your Microsoft Teams account:
<URL>

Once done, tell me and I'll continue.
```

---

## Python Snippets

### 1. Initialize Client

```python
import os
from composio import Composio

composio = Composio(api_key=os.environ["COMPOSIO_API_KEY"])
user_id = os.environ["COMPOSIO_USER_ID"]
auth_config_id = os.environ["MICROSOFT_TEAMS_AUTH_CONFIG_ID"]
```

### 2. Check for Existing Active Teams Connection

```python
import os
from composio import Composio

composio = Composio(api_key=os.environ["COMPOSIO_API_KEY"])
user_id = os.environ["COMPOSIO_USER_ID"]
auth_config_id = os.environ["MICROSOFT_TEAMS_AUTH_CONFIG_ID"]

accounts = composio.connected_accounts.list(
    user_ids=[user_id],
    auth_config_ids=[auth_config_id],
    statuses=["ACTIVE"],
)

active_accounts = list(accounts.items)

if active_accounts:
    for account in active_accounts:
        print(f"CONNECTED_ACCOUNT_ID={account.id}")
        print(f"STATUS={account.status}")
else:
    print("NO_ACTIVE_TEAMS_CONNECTION")
```

### 3. Generate Hosted Auth Link

> Use this **only** if no active connected account exists.

```python
import os
from composio import Composio

composio = Composio(api_key=os.environ["COMPOSIO_API_KEY"])
user_id = os.environ["COMPOSIO_USER_ID"]
auth_config_id = os.environ["MICROSOFT_TEAMS_AUTH_CONFIG_ID"]

connection_request = composio.connected_accounts.initiate(
    user_id=user_id,
    auth_config_id=auth_config_id,
)

print(f"AUTH_URL={connection_request.redirect_url}")
```

Send the printed `AUTH_URL` to the user.

### 4. Wait for Connection (Blocking)

> Only use this if it is acceptable for the process to block while the user authorizes.

```python
import os
from composio import Composio

composio = Composio(api_key=os.environ["COMPOSIO_API_KEY"])
user_id = os.environ["COMPOSIO_USER_ID"]
auth_config_id = os.environ["MICROSOFT_TEAMS_AUTH_CONFIG_ID"]

connection_request = composio.connected_accounts.initiate(
    user_id=user_id,
    auth_config_id=auth_config_id,
)

print(f"AUTH_URL={connection_request.redirect_url}")

connected_account = connection_request.wait_for_connection()
connected_account_id = getattr(connected_account, "id", "")

if not connected_account_id:
    raise RuntimeError("Connection completed, but no connected account ID was returned.")

print(f"CONNECTED_ACCOUNT_ID={connected_account_id}")
```

### 5. Re-List Accounts After User Confirms Auth

> Use this when the user says they completed the auth link.

```python
import os
from composio import Composio

composio = Composio(api_key=os.environ["COMPOSIO_API_KEY"])
user_id = os.environ["COMPOSIO_USER_ID"]
auth_config_id = os.environ["MICROSOFT_TEAMS_AUTH_CONFIG_ID"]

accounts = composio.connected_accounts.list(
    user_ids=[user_id],
    auth_config_ids=[auth_config_id],
    statuses=["ACTIVE"],
)

for account in accounts.items:
    print(f"CONNECTED_ACCOUNT_ID={account.id}")
    print(f"STATUS={account.status}")
```

### 6. Execute a Tool

All tool calls use string slugs, `user_id`, `connected_account_id`, and `arguments`.

```python
import os
from composio import Composio

composio = Composio(api_key=os.environ["COMPOSIO_API_KEY"])

result = composio.tools.execute(
    "MICROSOFT_TEAMS_GET_MY_PROFILE",
    user_id=os.environ["COMPOSIO_USER_ID"],
    connected_account_id="ca_...",
    arguments={},
    dangerously_skip_version_check=True,
)

print(result)
```

---

## Key Tool Slugs

| Slug                                         | Description                                  |
| -------------------------------------------- | -------------------------------------------- |
| `MICROSOFT_TEAMS_GET_MY_PROFILE`             | Verify current Teams user                    |
| `MICROSOFT_TEAMS_CHATS_GET_ALL_CHATS`        | List recent chats                            |
| `MICROSOFT_TEAMS_CHATS_GET_ALL_MESSAGES`     | Fetch messages — requires `chat_id`          |
| `MICROSOFT_TEAMS_TEAMS_POST_CHAT_MESSAGE`    | Send message — requires `chat_id`, `content` |
| `MICROSOFT_TEAMS_TEAMS_CREATE_CHAT`          | Create chat                                  |
| `MICROSOFT_TEAMS_TEAMS_POST_CHANNEL_MESSAGE` | Post message to channel                      |

### Discover Tool Slugs at Runtime

```python
import os
from composio import Composio

composio = Composio(api_key=os.environ["COMPOSIO_API_KEY"])
user_id = os.environ["COMPOSIO_USER_ID"]

tools = composio.tools.get(
    user_id=user_id,
    toolkits=["microsoft_teams"],
)

for tool in tools:
    if isinstance(tool, dict):
        print(tool.get("function", {}).get("name", tool))
    else:
        print(tool)
```

If object fields differ, inspect safely with:

```python
print(type(tool))
print(tool)
print(dir(tool))
```

> ❌ Do not assume toolkit objects have an `.id` field.

---

## Read-Only Actions

No confirmation required:

- `MICROSOFT_TEAMS_GET_MY_PROFILE`
- `MICROSOFT_TEAMS_CHATS_GET_ALL_CHATS`
- `MICROSOFT_TEAMS_CHATS_GET_ALL_MESSAGES`

## User-Visible Actions

Require **explicit confirmation** before execution:

- `MICROSOFT_TEAMS_TEAMS_POST_CHAT_MESSAGE`
- `MICROSOFT_TEAMS_TEAMS_POST_CHANNEL_MESSAGE`
- `MICROSOFT_TEAMS_TEAMS_CREATE_CHAT`

### Confirmation Format

```
Before I proceed, please confirm:

Action: [what you are about to do]
To: [recipient / chat / channel / team]
Message: "[message content if applicable]"

Reply yes to confirm or no to cancel.
```

---

## Messaging Workflow

1. Check active connected account.
2. Get or confirm `connected_account_id`.
3. Search for existing 1:1 chat via `MICROSOFT_TEAMS_CHATS_GET_ALL_CHATS`.
4. If the user name matches a known chat, reuse that `chat_id`.
5. Ask for confirmation with the final message text.
6. Send only after explicit approval via `MICROSOFT_TEAMS_TEAMS_POST_CHAT_MESSAGE`.

### Send Chat Message

```python
import os
from composio import Composio

composio = Composio(api_key=os.environ["COMPOSIO_API_KEY"])

result = composio.tools.execute(
    "MICROSOFT_TEAMS_TEAMS_POST_CHAT_MESSAGE",
    user_id=os.environ["COMPOSIO_USER_ID"],
    connected_account_id="ca_...",
    arguments={
        "chat_id": "...",
        "content": "Hello World",
    },
    dangerously_skip_version_check=True,
)

print(result)
```

### Find an Existing Chat

> Prefer reusing existing chats before creating a new one.

```python
import os
from composio import Composio

composio = Composio(api_key=os.environ["COMPOSIO_API_KEY"])

result = composio.tools.execute(
    "MICROSOFT_TEAMS_CHATS_GET_ALL_CHATS",
    user_id=os.environ["COMPOSIO_USER_ID"],
    connected_account_id="ca_...",
    arguments={},
    dangerously_skip_version_check=True,
)

print(result)
```

### Create a Chat

> Create a chat only after confirmation if no suitable chat exists.

```python
import os
from composio import Composio

composio = Composio(api_key=os.environ["COMPOSIO_API_KEY"])

result = composio.tools.execute(
    "MICROSOFT_TEAMS_TEAMS_CREATE_CHAT",
    user_id=os.environ["COMPOSIO_USER_ID"],
    connected_account_id="ca_...",
    arguments={
        "chatType": "oneOnOne",
        "members": [
            {
                "user_odata_bind": "https://graph.microsoft.com/v1.0/users/<my-user-id>",
                "roles": ["owner"],
            },
            {
                "user_odata_bind": "https://graph.microsoft.com/v1.0/users/<target-user-id>",
                "roles": ["owner"],
            },
        ],
    },
    dangerously_skip_version_check=True,
)

print(result)
```

---

## Failure Handling

| Symptom                                           | Cause                    | Fix                                                                                                                                                                                   |
| ------------------------------------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `COMPOSIO_API_KEY` missing                        | env not set              | Set `COMPOSIO_API_KEY`                                                                                                                                                                |
| `COMPOSIO_USER_ID` missing                        | env not set              | Set stable user ID, check USER.md or name included in telegram reply to create on (use first and last name if possiblt), eg: if name is "UZAIR MOHAMMED BAIG" then id is `uzair_baig` |
| `MICROSOFT_TEAMS_AUTH_CONFIG_ID` missing          | env not set              | Set Teams auth config ID starting with `ac_`                                                                                                                                          |
| `ModuleNotFoundError: No module named 'composio'` | image missing package    | Install `composio` into `/opt/skills-venv`; do not install `composio-core`                                                                                                            |
| `has_tools=False`                                 | deprecated SDK installed | Replace `composio-core` with `composio`                                                                                                                                               |
| No active account                                 | user not authenticated   | Generate one auth link with `connected_accounts.initiate(...)`                                                                                                                        |
| Tool call rejected due to version                 | toolkit version mismatch | Pass `dangerously_skip_version_check=True`                                                                                                                                            |
| Missing fields                                    | SDK/tool schema changed  | Inspect object safely; use `content` for message body and `chat_id` for target                                                                                                        |

---

## Do Not Do These

- ❌ Do not use `Action.MICROSOFTTEAMS_*` enums
- ❌ Do not use `toolset.execute_action(...)`
- ❌ Do not use `composio.actions.execute(...)`
- ❌ Do not create `./venv`
- ❌ Do not run `pip install` during normal task execution
- ❌ Do not open multiple auth links unnecessarily
- ❌ Do not silently send messages or create chats without confirmation
- ❌ Do not assume SDK list items have `.id` — use `print(item)`, `dir(item)`, or `getattr(item, "id", None)` if inspection is needed
