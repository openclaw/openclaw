# ANI Plugin Test Matrix

Last updated: 2026-03-29

This document defines the minimum validation set for the ANI OpenClaw plugin and its installer path.

## 1. Install And Runtime Load

### Case ANI-PLUGIN-001: Installer install works on a clean or existing OpenClaw home

Steps:

1. Run `npx -y openclaw-ani-installer install`
2. Inspect plugin state

Expected:

- `ani` is present under `~/.openclaw/extensions/ani`
- `openclaw plugins inspect ani` reports `Status: loaded`
- existing `channels.ani` config remains intact during upgrade

### Case ANI-PLUGIN-002: Installer update works in place

Steps:

1. Start from an existing ANI plugin install
2. Run `npx -y openclaw-ani-installer update`

Expected:

- plugin version is updated
- install metadata under `plugins.installs.ani` is refreshed
- no manual uninstall is required

### Case ANI-PLUGIN-003: Installer doctor reports healthy runtime

Steps:

1. Run `npx -y openclaw-ani-installer doctor`

Expected:

- plugin is detected
- ANI channel config is readable
- no plugin issues are reported for a healthy install

## 2. Connectivity And Identity

### Case ANI-PLUGIN-010: ANI channel authenticates with permanent API key

Expected:

- plugin can call `/api/v1/me`
- bot identity is resolved correctly
- gateway logs show ANI channel connected

### Case ANI-PLUGIN-011: Inbound message delivery works

Expected:

- incoming ANI chat message reaches OpenClaw
- conversation context is injected
- reply pipeline dispatches normally

### Case ANI-PLUGIN-012: Reply context is preserved

Expected:

- inbound `reply_to` metadata is resolved into visible parent-message context
- agent can tell what message the user is replying to

### Case ANI-PLUGIN-013: Final replies return through the standard outbound route

Steps:

1. Trigger an ANI conversation that causes OpenClaw to run a longer Codex or tool-backed task
2. Wait for the task to finish and the final assistant reply to be generated

Expected:

- intermediate ANI progress/status messages may appear during execution
- the final assistant reply is delivered back into the same ANI conversation
- the reply does not depend on a private fallback path or manual resend
- outbound routing uses the ANI conversation target consistently for follow-up sends

## 3. File And Attachment Flow

### Case ANI-PLUGIN-020: `ani_send_file` uploads with conversation binding

Steps:

1. Send a generated text file with `ani_send_file`
2. Send an existing local file with `ani_send_file`

Expected:

- upload succeeds
- file record is associated with the current ANI conversation
- recipients in the same conversation can download the attachment

### Case ANI-PLUGIN-021: Outbound media send binds uploaded attachment to conversation

Expected:

- media upload includes `conversation_id`
- subsequent message attachment is downloadable by other participants in the same conversation

### Case ANI-PLUGIN-022: Protected inbound attachments remain authenticated resources

Expected:

- plugin downloads protected ANI attachments with ANI auth
- binary files are handled via local media paths
- small text files may be inlined for the model

## 4. Task And Tooling Surface

### Case ANI-PLUGIN-030: Task tool suite is exposed and functional

Expected:

- `ani_list_conversation_tasks`
- `ani_get_task`
- `ani_create_task`
- `ani_update_task`
- `ani_delete_task`

All succeed when ANI permissions allow them.

### Case ANI-PLUGIN-031: Chat history tool returns ANI-native message context

Expected:

- history output includes message IDs
- history output includes reply relationships where available
- body extraction prefers full message body over truncated summary

## 5. Abort And Control Paths

### Case ANI-PLUGIN-040: Message revoke aborts in-flight handling

Expected:

- `message.revoked` is detected
- in-flight dispatch for that message is cancelled

### Case ANI-PLUGIN-041: Stream cancel aborts active response

Expected:

- `stream.cancel` or `task.cancel` aborts the active response cleanly

### Case ANI-PLUGIN-042: Slash control commands route through a native ANI command session

Steps:

1. Send a control command such as `/status`, `/exec ...`, or `/approve ...` from ANI
2. Inspect the resulting OpenClaw session behavior

Expected:

- the message is not debounced with surrounding chat text
- the command is routed through an `ani:slash:<sender>` session
- the command target still points at the underlying ANI conversation session
- control commands are handled as OpenClaw commands, not as normal model chat text

## 6. Local Validation Commands

From the OpenClaw repo root:

```bash
pnpm test:extension ani
pnpm run lint:plugins:no-monolithic-plugin-sdk-entry-imports
```

For packaging and install-path validation, also verify:

```bash
npx -y openclaw-ani-installer install --dry-run
npx -y openclaw-ani-installer doctor
```
