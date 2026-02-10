---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
read_when:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - 添加或修改投票支持（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - 调试从 CLI 或 Gateway 网关发送的投票（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: 通过 Gateway 网关 + CLI 发送投票（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: 投票（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
x-i18n:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  generated_at: "2026-02-03T07:43:12Z"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  model: claude-opus-4-5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  provider: pi（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  source_hash: 760339865d27ec40def7996cac1d294d58ab580748ad6b32cc34d285d0314eaf（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  source_path: automation/poll.md（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  workflow: 15（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# 投票（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## 支持的渠道（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- WhatsApp（Web 渠道）（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Discord（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- MS Teams（Adaptive Cards）（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## CLI（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# WhatsApp（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw message poll --target +15555550123 \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  --poll-question "Lunch today?" --poll-option "Yes" --poll-option "No" --poll-option "Maybe"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw message poll --target 123456789@g.us \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  --poll-question "Meeting time?" --poll-option "10am" --poll-option "2pm" --poll-option "4pm" --poll-multi（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Discord（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw message poll --channel discord --target channel:123456789 \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  --poll-question "Snack?" --poll-option "Pizza" --poll-option "Sushi"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw message poll --channel discord --target channel:123456789 \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  --poll-question "Plan?" --poll-option "A" --poll-option "B" --poll-duration-hours 48（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# MS Teams（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw message poll --channel msteams --target conversation:19:abc@thread.tacv2 \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  --poll-question "Lunch?" --poll-option "Pizza" --poll-option "Sushi"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
选项：（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--channel`：`whatsapp`（默认）、`discord` 或 `msteams`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--poll-multi`：允许选择多个选项（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--poll-duration-hours`：仅限 Discord（省略时默认为 24）（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Gateway 网关 RPC（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
方法：`poll`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
参数：（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `to`（字符串，必需）（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `question`（字符串，必需）（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `options`（字符串数组，必需）（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `maxSelections`（数字，可选）（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `durationHours`（数字，可选）（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `channel`（字符串，可选，默认：`whatsapp`）（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `idempotencyKey`（字符串，必需）（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## 渠道差异（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- WhatsApp：2-12 个选项，`maxSelections` 必须在选项数量范围内，忽略 `durationHours`。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Discord：2-10 个选项，`durationHours` 限制在 1-768 小时之间（默认 24）。`maxSelections > 1` 启用多选；Discord 不支持严格的选择数量限制。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- MS Teams：Adaptive Card 投票（由 OpenClaw 管理）。无原生投票 API；`durationHours` 被忽略。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## 智能体工具（Message）（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
使用 `message` 工具的 `poll` 操作（`to`、`pollQuestion`、`pollOption`，可选 `pollMulti`、`pollDurationHours`、`channel`）。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
注意：Discord 没有"恰好选择 N 个"模式；`pollMulti` 映射为多选。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Teams 投票以 Adaptive Cards 形式渲染，需要 Gateway 网关保持在线（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
以将投票记录到 `~/.openclaw/msteams-polls.json`。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
