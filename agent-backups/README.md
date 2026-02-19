# Agent Core Backups

This directory stores versioned snapshots of AI agent core files so they survive
project resets, fresh clones, or machine rebuilds.

## What Is Backed Up

| 來源路徑 | 說明 |
|---|---|
| `~/.openclaw/agents/<agentId>/SOUL.md` | Agent 靈魂／個性設定 |
| `~/.openclaw/agents/<agentId>/MEMORY.md` | 長期記憶（主 session 專用） |
| `~/.openclaw/agents/<agentId>/IDENTITY.md` | Agent 身分（名稱、暱稱、表情符號）|
| `~/.openclaw/agents/<agentId>/TOOLS.md` | 環境特定設定（設備名稱、SSH 別名等）|
| `~/.openclaw/agents/<agentId>/USER.md` | 使用者個人檔案 |
| `~/.openclaw/agents/<agentId>/AGENTS.md` | 工作區設定覆寫 |
| `~/.openclaw/agents/<agentId>/memory/*.md` | 每日記憶筆記（最近 30 天）|
| `.agents/skills/` | Maintainer PR workflow skills |
| `.pi/prompts/` | Pi 個人提示詞 |

## Directory Layout

```
agent-backups/
├── README.md              ← 本文件
├── .gitignore             ← 只允許 .md / .yaml 檔案入 git
├── <agentId>/             ← 每個 agent 一個子目錄
│   ├── SOUL.md
│   ├── MEMORY.md
│   ├── IDENTITY.md
│   ├── TOOLS.md
│   ├── USER.md
│   ├── AGENTS.md
│   └── memory/
│       └── YYYY-MM-DD.md
└── skills-snapshot/       ← .agents/skills/ 的快照
    ├── PR_WORKFLOW.md
    ├── prepare-pr/
    └── ...
```

## Usage

### 備份（Backup）

```bash
# 備份目前所有 agents
./scripts/backup-agent-cores.sh

# 備份並推送到 GitHub（建立 backup 分支或直接 push 到目前分支）
./scripts/backup-agent-cores.sh --push

# 只備份特定 agent
./scripts/backup-agent-cores.sh --agent <agentId>
```

### 還原（Restore）

```bash
# 列出所有可還原的備份
./scripts/restore-agent-cores.sh --list

# 還原最新備份到 ~/.openclaw/agents/
./scripts/restore-agent-cores.sh

# 還原特定 agent
./scripts/restore-agent-cores.sh --agent <agentId>

# 乾跑（只顯示哪些檔案會被複製，不實際執行）
./scripts/restore-agent-cores.sh --dry-run
```

### 自動備份（GitHub Actions）

在 GitHub repo 頁面：**Actions → Backup Agent Core Files → Run workflow**

或等待每週自動執行（每週日 03:00 UTC）。

## Security

- Session 對話記錄（`.jsonl`）**不會**備份（包含私人對話）
- 設定 JSON / credentials **不會**備份（包含 API 金鑰）
- 只備份 `.md` 和 `.yaml` 人類可讀文字檔
- 若 `MEMORY.md` 含敏感個資，請評估是否加入 `.gitignore`
