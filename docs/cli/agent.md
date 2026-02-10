---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: "CLI reference for `openclaw agent` (send one agent turn via the Gateway)"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
read_when:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - You want to run one agent turn from scripts (optionally deliver reply)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: "agent"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# `openclaw agent`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Run an agent turn via the Gateway (use `--local` for embedded).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Use `--agent <id>` to target a configured agent directly.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Related:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Agent send tool: [Agent send](/tools/agent-send)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Examples（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw agent --to +15555550123 --message "status update" --deliver（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw agent --agent ops --message "Summarize logs"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw agent --session-id 1234 --message "Summarize inbox" --thinking medium（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw agent --agent ops --message "Generate report" --deliver --reply-channel slack --reply-to "#reports"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
