# Response Verifier Plugin

Verifies agent completion claims against the audit log **before responses are delivered**.

## The Problem

When an AI agent says "Done! I sent the message" — how do you know it actually did? The agent could:

- Claim completion without taking action
- Forget to actually execute a tool
- Have a tool call fail silently

## The Solution

This plugin intercepts responses before delivery and:

1. **Detects completion claims** — "done", "sent", "created", "finished", etc.
2. **Extracts claimed actions** — what the agent says it did
3. **Verifies against audit log** — checks if those actions actually occurred
4. **Blocks or warns** — depending on configuration

## Requirements

This plugin requires the **audit-logger** plugin to be enabled. The audit logger creates the trail that this plugin verifies against.

## Installation

```json
{
  "plugins": {
    "audit-logger": { "enabled": true },
    "response-verifier": { "enabled": true }
  }
}
```

## Modes

### Warning Mode (default)

When verification fails, the response is delivered with a warning prepended:

```
⚠️ VERIFICATION WARNING: Unverified claims: message. These actions were not found in the audit log.

Done! I sent the message to the team.
```

### Strict Mode

When verification fails, the response is **blocked entirely**:

```json
{
  "plugins": {
    "response-verifier": {
      "enabled": true,
      "strictMode": true
    }
  }
}
```

The agent will need to actually perform the action before claiming completion.

## What Gets Verified

| Claimed Action           | Audit Log Check                             |
| ------------------------ | ------------------------------------------- |
| "sent the message"       | `message_sent` event or `message` tool call |
| "created/wrote the file" | `write` tool call                           |
| "ran the command"        | `exec` tool call                            |
| "pushed/committed"       | `exec` tool call with git                   |
| Generic "done/complete"  | Any successful tool call                    |

## Configuration

```json
{
  "plugins": {
    "response-verifier": {
      "enabled": true,
      "strictMode": false,
      "completionPatterns": ["deployed", "shipped"]
    }
  }
}
```

### Options

- **strictMode** (boolean, default: false) — Block unverified responses instead of warning
- **completionPatterns** (string[]) — Additional regex patterns that indicate completion claims

## Verification Window

The plugin checks audit log entries from the **last 5 minutes** to verify claims. This prevents false positives from old audit entries and keeps verification relevant to the current conversation.

## Limitations

1. **Pattern-based detection** — Uses regex patterns to detect claims; may miss some phrasing
2. **Action mapping** — Maps claimed actions to tool names; custom tools may need additional patterns
3. **Requires audit-logger** — Won't work without audit trail being generated

## Example Scenarios

### ✅ Verified Response

```
Agent: "I'll send the message now."
[message tool called, success]
Agent: "Done! I sent the message."
→ Audit log shows message_sent event
→ Response delivered normally
```

### ⚠️ Unverified Response (Warning Mode)

```
Agent: "Done! I sent the message."
→ No message_sent event in audit log
→ Response delivered with warning prepended
```

### 🚫 Blocked Response (Strict Mode)

```
Agent: "Done! I sent the message."
→ No message_sent event in audit log
→ Response blocked, not delivered
→ Agent must actually send message first
```

## Related

- **audit-logger** plugin — Creates the audit trail this plugin verifies against
- **before_response** hook — The hook this plugin uses to intercept responses
- [GitHub Issue #13131](https://github.com/openclaw/openclaw/issues/13131) — Feature request for audit logging
