---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
read_when:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - 你想从脚本运行一个智能体回合（可选发送回复）（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: "`openclaw agent` 的 CLI 参考（通过 Gateway 网关发送一个智能体回合）"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: agent（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
x-i18n:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  generated_at: "2026-02-03T07:44:38Z"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  model: claude-opus-4-5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  provider: pi（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  source_hash: dcf12fb94e207c68645f58235792596d65afecf8216b8f9ab3acb01e03b50a33（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  source_path: cli/agent.md（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  workflow: 15（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# `openclaw agent`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
通过 Gateway 网关运行智能体回合（使用 `--local` 进行嵌入式运行）。使用 `--agent <id>` 直接指定已配置的智能体。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
相关内容：（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- 智能体发送工具：[Agent send](/tools/agent-send)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## 示例（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw agent --to +15555550123 --message "status update" --deliver（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw agent --agent ops --message "Summarize logs"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw agent --session-id 1234 --message "Summarize inbox" --thinking medium（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw agent --agent ops --message "Generate report" --deliver --reply-channel slack --reply-to "#reports"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
