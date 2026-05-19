# OpenClaw 自動化智能閘道架構規劃

> Telegram / WeChat → OpenClaw → Claude + Codex 全鏈路自動化

---

## 1. 系統總覽

```
┌─────────────────────────────────────────────────────────────────┐
│                        使用者（你）                               │
└──────────┬──────────────────────────────────┬───────────────────┘
           │ Telegram                          │ WeChat
           ▼                                   ▼
┌──────────────────┐                ┌──────────────────┐
│  grammy Bot      │                │ @tencent-weixin  │
│  (extensions/    │                │  plugin          │
│   telegram/)     │                │                  │
└────────┬─────────┘                └────────┬─────────┘
         │                                    │
         ▼                                    ▼
┌─────────────────────────────────────────────────────────────────┐
│                    OpenClaw Gateway                               │
│  ┌─────────────┐  ┌──────────────┐  ┌───────────────────────┐  │
│  │ Route       │  │ Command      │  │ Permission & Auth     │  │
│  │ Resolver    │  │ Registry     │  │ Guard                 │  │
│  └──────┬──────┘  └──────┬───────┘  └───────────┬───────────┘  │
│         │                 │                       │              │
│         ▼                 ▼                       ▼              │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │              Agent Runtime (src/agents/)                  │    │
│  │  ┌─────────────┐  ┌─────────────┐  ┌────────────────┐  │    │
│  │  │ Session     │  │ Context     │  │ Tool           │  │    │
│  │  │ Manager     │  │ Engine      │  │ Dispatcher     │  │    │
│  │  └─────────────┘  └─────────────┘  └────────────────┘  │    │
│  └──────────┬────────────────┬─────────────────┬───────────┘    │
│             │                │                  │               │
└─────────────┼────────────────┼──────────────────┼───────────────┘
              │                │                  │
              ▼                ▼                  ▼
┌──────────────────┐ ┌──────────────┐ ┌───────────────────────┐
│  Claude API      │ │  Codex       │ │  MCP Tools            │
│  (Anthropic)     │ │  (OpenAI)    │ │  (檔案/Git/API/排程)   │
│                  │ │              │ │                       │
│  • 對話理解      │ │  • 程式碼生成 │ │  • filesystem         │
│  • 任務規劃      │ │  • 自動修復   │ │  • git operations     │
│  • 分析推理      │ │  • 重構       │ │  • web fetch          │
│  • 多輪對話      │ │  • 測試生成   │ │  • cron scheduling    │
└──────────────────┘ └──────────────┘ └───────────────────────┘
```

---

## 2. 現有基礎設施盤點

### 2.1 已就緒（可直接使用）

| 組件 | 位置 | 能力 |
|------|------|------|
| Telegram Bot | `extensions/telegram/` | grammy 框架，支援 webhook/polling，原生命令，群組 |
| WeChat Plugin | `@tencent-weixin/openclaw-weixin` | 外部插件，僅支援私聊 |
| Claude Provider | `extensions/anthropic/` | 串流回應，安全策略，payload logging |
| Codex Harness | `extensions/codex/` | AgentHarness 抽象，runAttempt/compact/reset |
| Route Resolver | `src/routing/resolve-route.ts` | 8 層 binding 匹配，session key 派生 |
| Command Registry | `src/auto-reply/commands-registry.shared.ts` | 斜線命令，原生命令，3 tier 揭露 |
| Cron System | `src/cron/` | 定時 agent 執行，isolated auth |
| MCP Channel Tools | `src/mcp/channel-tools.ts` | conversations, messages, events, permissions |
| Session Store | `src/sessions/` | 多輪對話狀態持久化 |
| Auto-Reply Runner | `src/auto-reply/reply/agent-runner.ts` | Agent 執行編排，followup 佇列 |

### 2.2 需要補建

| 組件 | 用途 | 優先級 |
|------|------|--------|
| 智能指令路由器 | 自然語言 → 結構化 action 分派 | P0 |
| 多步 Workflow Engine | 編排序列任務（分析→寫碼→測試→PR） | P1 |
| 操作確認閘門 | 高危操作推送確認訊息回 Telegram | P0 |
| 進度回報 Hook | 長任務結果推送回聊天 | P1 |
| Provider 路由策略 | 根據任務類型自動選 Claude vs Codex | P2 |
| 群組權限管理 | WeChat/Telegram 群組中的多用戶權限 | P2 |

---

## 3. 核心流程設計

### 3.1 訊息處理流程

```
用戶發送訊息 (Telegram/WeChat)
    │
    ▼
[1] Channel Plugin 接收 (grammy / weixin SDK)
    │
    ▼
[2] Route Resolver 匹配 Agent
    │  • 依據 binding tier 決定目標 agent
    │  • 建立 session key（per-peer / per-account）
    │
    ▼
[3] Command 解析
    │  ├─ 斜線命令 → 直接執行對應 handler
    │  └─ 自然語言 → Agent Runtime 處理
    │
    ▼
[4] Agent Runtime 執行
    │  ├─ Claude: 理解意圖、規劃步驟、生成回覆
    │  ├─ Codex: 程式碼操作（當任務涉及寫碼）
    │  └─ MCP Tools: 檔案/Git/API/排程操作
    │
    ▼
[5] 安全閘門 (Permission Guard)
    │  ├─ 低風險操作 → 自動執行
    │  └─ 高風險操作 → 推送確認訊息回 channel
    │
    ▼
[6] 結果回傳
    └─ 透過 ChannelMessageActionAdapter 回傳結果
```

### 3.2 指令模式設計

支援三種互動模式：

#### 模式 A：斜線命令（明確快速）

```
/code refactor src/routing/resolve-route.ts — 提取重複邏輯為函數
/ask 這段代碼為什麼用 8 層 binding？
/deploy staging
/status           — 查看所有進行中任務
/approve <task-id> — 批准高危操作
/cancel <task-id>  — 取消進行中任務
```

#### 模式 B：自然語言（彈性強大）

```
「幫我看看 PR #123 有什麼問題」
  → Claude 分析 PR diff，回報安全/效能/架構問題

「把 user service 的 API 從 REST 改成 GraphQL」
  → Claude 規劃 → Codex 生成代碼 → 測試 → 推送 PR

「每天早上 9 點跑一次程式碼品質掃描」
  → 建立 cron job，結果推送回 Telegram
```

#### 模式 C：混合模式（推薦）

```
「/workflow create」
  → 互動式建立多步工作流

「幫我建一個 workflow：先跑 lint，通過的話自動 commit」
  → 自然語言 → 結構化 workflow 存檔
```

---

## 4. 智能路由策略

### 4.1 Provider 選擇邏輯

```typescript
// 概念設計 — 根據任務類型自動路由
interface TaskClassification {
  type: 'conversation' | 'analysis' | 'coding' | 'review' | 'automation';
  complexity: 'simple' | 'moderate' | 'complex';
  requiresCodeExecution: boolean;
}

// 路由規則
const providerRouting = {
  conversation:  'claude',      // 對話理解
  analysis:      'claude',      // 程式碼/文件分析
  coding:        'codex',       // 程式碼生成/修改
  review:        'claude',      // Code review
  automation:    'claude+tools' // 複合任務（Claude 規劃 + MCP 執行）
};
```

### 4.2 多步任務編排

```typescript
// Workflow 定義範例
const workflow = {
  name: 'auto-pr',
  trigger: 'natural-language',  // 或 '/workflow auto-pr'
  steps: [
    { agent: 'claude',  action: 'analyze-request', output: 'plan' },
    { agent: 'codex',   action: 'implement',       input: 'plan', output: 'diff' },
    { agent: 'claude',  action: 'review-diff',     input: 'diff', output: 'feedback' },
    { gate: 'user-confirm', message: '確認要提交 PR？', channel: 'telegram' },
    { agent: 'codex',   action: 'create-pr',       input: 'diff' }
  ],
  onFailure: { notify: 'telegram', retry: false }
};
```

---

## 5. 安全與權限設計

### 5.1 操作風險分級

| 等級 | 操作類型 | 處理方式 |
|------|----------|----------|
| 🟢 低風險 | 讀取文件、查詢狀態、分析代碼 | 自動執行 |
| 🟡 中風險 | 修改文件、建立分支、跑測試 | 執行後通知 |
| 🔴 高風險 | git push、部署、刪除、付款 | 推送確認 → 等待 /approve |

### 5.2 權限控制

```yaml
# 概念配置
permissions:
  owner:
    telegram_user_id: "YOUR_TELEGRAM_ID"
    wechat_open_id: "YOUR_WECHAT_OPENID"
  
  auto_approve:
    - "read:*"
    - "analyze:*"
    - "edit:local-files"
    - "git:commit"
    - "git:branch"
  
  require_confirm:
    - "git:push"
    - "git:force-push"
    - "deploy:*"
    - "delete:*"
    - "cron:create"
    - "external-api:*"
  
  deny:
    - "system:rm-rf"
    - "deploy:production"  # 永遠不允許自動部署 prod
```

### 5.3 確認流程

```
OpenClaw: ⚠️ 高風險操作確認
  操作: git push origin feature/new-api
  分支: feature/new-api (3 commits ahead)
  
  /approve 7a3f — 批准執行
  /deny 7a3f   — 拒絕
  
  ⏰ 30 分鐘內未回覆將自動取消
```

---

## 6. 部署架構

### 6.1 推薦部署方式

```
┌─────────────────────────────────────────┐
│           你的伺服器 / VPS               │
│                                         │
│  ┌───────────────────────────────────┐  │
│  │  OpenClaw Gateway (Node.js)       │  │
│  │  • Telegram Bot (webhook mode)    │  │
│  │  • WeChat Plugin (sidecar)        │  │
│  │  • Agent Runtime                  │  │
│  │  • MCP Server                     │  │
│  │  • Cron Scheduler                 │  │
│  └───────────────┬───────────────────┘  │
│                  │                       │
│  ┌───────────────┴───────────────────┐  │
│  │  State Store                       │  │
│  │  • Sessions (SQLite/Postgres)     │  │
│  │  • Memory (LanceDB)              │  │
│  │  • Workflows (JSON/DB)           │  │
│  └───────────────────────────────────┘  │
└─────────────────────────────────────────┘
         │              │              │
         ▼              ▼              ▼
   Anthropic API    OpenAI API    GitHub API
   (Claude)         (Codex)       (PR/Issues)
```

### 6.2 環境配置

```bash
# .env 或 openclaw config
ANTHROPIC_API_KEY=sk-ant-...
OPENAI_API_KEY=sk-...
TELEGRAM_BOT_TOKEN=123456:ABC-...
GITHUB_TOKEN=ghp_...

# OpenClaw 設定
OPENCLAW_GATEWAY_PORT=3000
OPENCLAW_WEBHOOK_URL=https://your-domain.com/webhook/telegram
```

### 6.3 啟動流程

```bash
# 1. 安裝 OpenClaw
pnpm install

# 2. 設定 Telegram channel
openclaw channels login --channel telegram

# 3. （可選）安裝 WeChat plugin
openclaw plugins install "@tencent-weixin/openclaw-weixin"
openclaw channels login --channel openclaw-weixin

# 4. 配置 providers
openclaw config set providers.anthropic.apiKey $ANTHROPIC_API_KEY
openclaw config set providers.codex.apiKey $OPENAI_API_KEY

# 5. 啟動 gateway
openclaw start --daemon
```

---

## 7. 實作路線圖

### Phase 1：基礎串接（1-2 天）

- [x] Telegram Bot 啟動並接收訊息
- [ ] 確認 Claude provider 正常回應
- [ ] 確認 Codex harness 正常回應
- [ ] 設定 owner 權限（只有你可以操作）
- [ ] 測試：Telegram 發訊息 → Claude 回覆

### Phase 2：指令系統（2-3 天）

- [ ] 註冊自訂斜線命令：`/code`, `/ask`, `/status`
- [ ] 實作自然語言意圖分類（用 Claude 做 intent detection）
- [ ] 實作 provider 路由（coding → Codex, 其他 → Claude）
- [ ] 實作結果格式化（Markdown → Telegram 格式）

### Phase 3：安全閘門（1-2 天）

- [ ] 實作操作風險分級
- [ ] 高風險操作 → 推送確認訊息
- [ ] `/approve` / `/deny` 命令處理
- [ ] 超時自動取消

### Phase 4：自動化 Workflow（3-5 天）

- [ ] Workflow 定義格式設計
- [ ] 多步編排引擎
- [ ] 長任務進度回報
- [ ] Cron 整合（定時任務）
- [ ] 失敗重試與通知

### Phase 5：WeChat 擴展（1-2 天）

- [ ] WeChat plugin 安裝與登入
- [ ] 統一指令介面（Telegram/WeChat 共用邏輯）
- [ ] 跨 channel 同步（任務在 Telegram 發起，結果可在 WeChat 查看）

---

## 8. 使用範例

### 日常開發助手

```
你: 幫我看看今天有沒有新的 issue 需要處理
Bot: 📋 GitHub Issues 更新：
     • #142 [bug] Login timeout on mobile (P1, assigned to you)
     • #145 [feature] Add dark mode support (P2, unassigned)
     要我分析 #142 的代碼嗎？

你: 好，分析 142 並給修復建議
Bot: 🔍 分析中...
     根因：src/auth/session.ts:89 timeout 設為 5s，移動網路常超時
     建議：改為 15s + 指數退避重試
     要我直接修復並提 PR 嗎？

你: 修吧
Bot: ⚠️ 確認操作：
     • 建立分支 fix/issue-142-login-timeout
     • 修改 src/auth/session.ts
     • 跑測試
     • 推送並建立 PR
     /approve a1b2

你: /approve a1b2
Bot: ✅ PR #146 已建立: fix: increase mobile session timeout with exponential backoff
     https://github.com/your-repo/pull/146
```

### 定時自動化

```
你: 每天早上 8 點幫我：
    1. 檢查所有 PR 的 CI 狀態
    2. 有失敗的通知我
    3. 超過 3 天沒合的提醒我 review

Bot: ✅ 已建立定時任務 [daily-pr-check]
     排程：每日 08:00 UTC+8
     動作：PR 狀態掃描 + 通知
     下次執行：明天 08:00
```

### 程式碼操作

```
你: /code 把 user service 的所有 console.log 換成 structured logger

Bot: 🔍 掃描 src/services/user/...
     找到 23 處 console.log
     
     計劃：
     1. 引入 logger from '@/lib/logger'
     2. 替換 console.log → logger.info
     3. 替換 console.error → logger.error
     4. 加上 context metadata
     
     預計修改 8 個檔案，要執行嗎？

你: 執行

Bot: ✅ 完成！修改了 8 個檔案，23 處替換
     已 commit: refactor(user): replace console.log with structured logger
     要推送嗎？
```

---

## 9. 技術決策記錄

| 決策 | 選擇 | 原因 |
|------|------|------|
| Telegram 框架 | grammy（已內建） | 已整合，高效能，支援 webhook |
| WeChat 整合 | Tencent 官方 plugin | 官方支援，API 合規 |
| 意圖分類 | Claude 做 intent detection | 最強 NLU，免訓練，zero-shot |
| Workflow 存儲 | JSON 定義 + DB 狀態 | 靈活 + 可追蹤 |
| 部署方式 | 單機 Node.js + SQLite | 個人使用足夠，低維護 |
| 確認機制 | Inline keyboard (Telegram) | 原生 UX，一鍵操作 |

---

## 10. 風險與注意事項

1. **WeChat 限制**：微信官方 API 限制較多，群組不支援，需企業認證
2. **API 費用**：Claude + Codex 按 token 計費，長對話注意 compaction
3. **延遲**：複雜任務可能需數十秒，需要適當的「正在處理」提示
4. **安全**：Bot token 和 API key 必須妥善保管，不可寫入代碼
5. **並發**：多條訊息同時到達時的 session 鎖定策略

---

## 下一步

確認此架構方向後，建議從 **Phase 1** 開始：
1. 確認 Telegram bot 能正常收發訊息
2. 確認 Claude 和 Codex provider 都能被 agent runtime 調用
3. 發一條測試訊息，確認完整鏈路通暢
