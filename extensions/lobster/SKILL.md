# Lobster（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Lobster executes multi-step workflows with approval checkpoints. Use it when:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- User wants a repeatable automation (triage, monitor, sync)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Actions need human approval before executing (send, post, delete)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Multiple tool calls should run as one deterministic operation（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## When to use Lobster（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| User intent                                            | Use Lobster?                                  |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| ------------------------------------------------------ | --------------------------------------------- |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| "Triage my email"                                      | Yes — multi-step, may send replies            |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| "Send a message"                                       | No — single action, use message tool directly |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| "Check my email every morning and ask before replying" | Yes — scheduled workflow with approval        |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| "What's the weather?"                                  | No — simple query                             |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| "Monitor this PR and notify me of changes"             | Yes — stateful, recurring                     |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Basic usage（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Run a pipeline（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "action": "run",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "pipeline": "gog.gmail.search --query 'newer_than:1d' --max 20 | email.triage"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Returns structured result:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "protocolVersion": 1,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "ok": true,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "status": "ok",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "output": [{ "summary": {...}, "items": [...] }],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "requiresApproval": null（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Handle approval（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If the workflow needs approval:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "status": "needs_approval",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "output": [],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "requiresApproval": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "prompt": "Send 3 draft replies?",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "items": [...],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "resumeToken": "..."（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Present the prompt to the user. If they approve:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "action": "resume",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "token": "<resumeToken>",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "approve": true（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Example workflows（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Email triage（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
gog.gmail.search --query 'newer_than:1d' --max 20 | email.triage（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Fetches recent emails, classifies into buckets (needs_reply, needs_action, fyi).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Email triage with approval gate（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
gog.gmail.search --query 'newer_than:1d' | email.triage | approve --prompt 'Process these?'（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Same as above, but halts for approval before returning.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Key behaviors（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Deterministic**: Same input → same output (no LLM variance in pipeline execution)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Approval gates**: `approve` command halts execution, returns token（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Resumable**: Use `resume` action with token to continue（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Structured output**: Always returns JSON envelope with `protocolVersion`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Don't use Lobster for（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Simple single-action requests (just use the tool directly)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Queries that need LLM interpretation mid-flow（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- One-off tasks that won't be repeated（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
