# OpenClaw Automation Gateway Extension

Telegram/WeChat → Claude CLI + Codex CLI 智能路由與自動化工作流。

## 功能

- **智能意圖分類** — 自動判斷訊息該走 Claude CLI（分析/對話）還是 Codex CLI（寫碼）
- **Codex 調度** — 透過 tool 調用 Codex CLI 執行程式碼操作
- **多步工作流** — 預定義和自訂 workflow（auto-pr, code-review, refactor）
- **確認閘門** — 高危操作推送 Telegram inline button 等待確認
- **系統狀態** — 即時查看 provider 狀態和任務進度

## 安裝

此 extension 為 bundled plugin，在 `extensions/automation/` 目錄即自動載入。

確保以下已就緒：
```bash
# Claude CLI 已登入
claude --version

# Codex CLI 已登入
codex --version

# OpenClaw gateway 已啟動
openclaw gateway
```

## 配置

在 `openclaw.json` 中設定 agent 使用 CLI harness：

```json
{
  "agents": [
    {
      "id": "main",
      "default": true,
      "runtime": "claude-cli",
      "model": { "primary": "anthropic/claude-sonnet-4-6" }
    },
    {
      "id": "coder",
      "runtime": "codex",
      "model": { "primary": "codex/codex-mini" }
    }
  ]
}
```

## 使用方式

### 直接對話（自然語言）

```
你: 幫我把 user service 的 console.log 換成 structured logger
Bot: [Intent: coding → Codex CLI]
     掃描中... 找到 23 處 → 執行替換 → 完成
```

### 斜線命令

```
/code refactor src/auth — 提取重複邏輯
/workflow auto-pr
/workflow code-review PR#123
/status
```

### 工作流

```
/workflow auto-pr src/new-feature
→ Step 1/5: Claude 分析需求
→ Step 2/5: Codex 實作
→ Step 3/5: Codex 跑測試
→ Step 4/5: Claude 自我審查
→ Step 5/5: ⚠️ 確認推送？ [✅ 批准] [❌ 拒絕]
```

## 工具清單

| Tool | 用途 |
|------|------|
| `automation_classify_intent` | 訊息意圖分類 + provider 路由 |
| `automation_codex_execute` | 調度 Codex CLI 執行程式碼任務 |
| `automation_workflow` | 多步工作流引擎 |
| `automation_confirm_gate` | 高危操作確認閘門 |
| `automation_status` | 系統狀態總覽 |

## 架構

```
Telegram/WeChat Message
    ↓
OpenClaw Gateway → Route Resolver → Agent Runtime
    ↓
Claude CLI (主 agent, runtime="claude-cli")
    ├── automation_classify_intent → 判斷意圖
    ├── automation_codex_execute → 調用 Codex CLI
    ├── automation_workflow → 執行多步流程
    └── automation_confirm_gate → 高危確認
```

Claude CLI 作為「大腦」，Codex CLI 作為「手」。
Claude 負責理解、規劃、審查；Codex 負責寫碼、執行、修改。
