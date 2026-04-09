# 📧 Email Triage Skill

该 Skill 基于 `email-ingest-integration` 项目，通过 AI 对多账号邮件进行抓取、分拣和待办管理。

## 🛠️ 配置说明
- **代码库**: `/home/node/.openclaw/workspace/email-ingest-integration`
- **凭证**: 优先读取 `/home/node/.openclaw/workspace/email-ingest-integration/.env`
- **状态维护**: `/home/node/.openclaw/workspace/memory/email_triage_state.json`

## 🕹️ Tools

### `email_sync`
同步最新邮件。
- **逻辑**: 如果是首次运行，自动使用前一天的日期作为 `init-start-date`。
- **自动化**: 建议在 OpenClaw Cron 中每 4 小时运行一次。

### `email_pending`
列出所有标记为 `High` 优先级且尚未处理的邮件。
- **输出**: 包含邮件主题、发件人、AI 摘要及待办状态。

### `email_dismiss` (id: number)
将指定的邮件从待办清单中移除（标记为已处理）。

## 🤖 Discord 交互 (Buttons)
当报告新邮件时，每封邮件摘要下方会附带一个 `Ack` 按钮。
- **Action**: 点击按钮后执行 `email_dismiss(id)`。
- **反馈**: 按钮点击后消息会更新为“已确认处理”。

## 📄 状态结构 (State)
```json
{
  "cursor": { "last_ingested_id": 123 },
  "pending_attention": [
    { "id": 124, "subject": "...", "status": "notified" }
  ]
}
```
