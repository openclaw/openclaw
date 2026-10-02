# Lobster

Lobster executes multi-step workflows with approval checkpoints. Use it when:

- User wants a repeatable automation (triage, monitor, sync)
- Actions need human approval before executing (send, post, delete)
- Multiple tool calls should run as one deterministic operation

## When to use Lobster

| User intent                                            | Use Lobster?                                  |
| ------------------------------------------------------ | --------------------------------------------- |
| "Triage my email"                                      | Yes — multi-step, may send replies            |
| "Send a message"                                       | No — single action, use message tool directly |
| "Check my email every morning and ask before replying" | Yes — scheduled workflow with approval        |
| "What's the weather?"                                  | No — simple query                             |
| "Monitor this PR and notify me of changes"             | Yes — stateful, recurring                     |

## Basic usage

### Run a pipeline

```json
{
  "action": "run",
  "pipeline": "gog.gmail.search --query 'newer_than:1d' --max 20 | email.triage"
}
```

Returns structured result:

```json
{
  "protocolVersion": 1,
  "ok": true,
  "status": "ok",
  "output": [{ "summary": {...}, "items": [...] }],
  "requiresApproval": null
}
```

### Handle approval

Approval checkpoints go to the Gateway's operator approval UI while the tool
call waits. The agent cannot approve or resume an approval checkpoint. After the
operator allows the action once, the workflow continues in the same call; a
denial or timeout cancels it. Do not ask for an approval token in chat.

## Example workflows

### Email triage

```
gog.gmail.search --query 'newer_than:1d' --max 20 | email.triage
```

Fetches recent emails, classifies into buckets (needs_reply, needs_action, fyi).

### Email triage with approval gate

```
gog.gmail.search --query 'newer_than:1d' | email.triage | approve --prompt 'Process these?'
```

Same as above, but halts for approval before returning.

## Key behaviors

- **Deterministic**: Same input → same output (no LLM variance in pipeline execution)
- **Approval gates**: `approve` command pauses for an operator decision
- **Resumable input**: Use `resume` with the returned input token and `responseJson`
- **Structured output**: Always returns JSON envelope with `protocolVersion`

## Don't use Lobster for

- Simple single-action requests (just use the tool directly)
- Queries that need LLM interpretation mid-flow
- One-off tasks that won't be repeated
