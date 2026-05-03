---
name: cua
description: "Delegates browser automation tasks to the local CUA (Computer User Agent). Use when the user asks you to navigate a website, approve requests, or do complex UI automation in the browser."
metadata: { "openclaw": { "emoji": "🤖", "requires": { "bins": ["python3"] } } }
---

# CUA Web Agent Skill

Use this skill to perform web automation using the CUA (Computer User Agent) WebSocket service.

## When to Use

- User asks to "approve my leave requests in JISR"
- User asks to "navigate to X website and do Y"
- The user provides answers to a previous `ask_user` prompt and you need to resume execution.

## Writing the `--task` String (Critical)

The task must be a **single short sentence** with only the high-level goal and the required info. Nothing else.

Rules:

- State only what needs to be done, not how
- Do not include UI steps, clicks, reasoning, or retries
- Do not use words like: complete, continue, fill, dismiss, click, navigate
- Do not include the user's own name unless a specific employee name was explicitly given

Valid examples:

- `check leave balance`
- `raise early leave request on 10/01/2026 for personal reasons`
- `approve all pending time-off requests`
- `submit sick leave request on 20 Dec 2025`

## Parameters needed

- `task`: what the user wants to accomplish in plain english

## Command Reference

Always run the command natively in the shell. Ensure you have `websockets` installed in your Python environment (`pip install websockets`).

### Starting a new task

```bash
python3 ~/.openclaw/workspace/skills/cua/cua_client.py \
  --task "Approve all pending leave requests"
```

### Resuming a paused task (Responding to ask_user)

If the output JSON contains `ask_user`, surface the `question` and `options` to the user and wait for their answer. Do NOT guess or invent an answer.

Once the user replies, resume with the same task, their answer as `user_reply`, and the returned `state_id` as `resume_state_id`:

```bash
python3 ~/.openclaw/workspace/skills/cua/cua_client.py \
  --task "Approve all pending leave requests" \
  --resume_state_id "1234abcd" \
  --user_reply '{"param_key": "user answer"}'
```

## Handling the Output JSON

| Field                         | Meaning                                                                                                            |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `success: true`               | Task completed. Tell the user what was done.                                                                       |
| `success: false` + `ask_user` | CUA needs input. Surface `ask_user.question` and `options` to the user. Wait for their reply before calling again. |
| `success: false` + `state_id` | Save the `state_id`. Pass it as `--resume_state_id` on the next call.                                              |
| `success: false` + `error`    | Task failed. Report what failed in plain language.                                                                 |

**Special case — `param_key == "confirmation"`:** The system is asking the user to confirm before taking action. You MUST stop, show the question to the user, and wait for an explicit yes/no. Never generate a confirmation answer yourself.
