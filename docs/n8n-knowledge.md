# n8n knowledge（外部知識素材，供 OpenClaw 記憶層學習）

> 來源：本機 `~/.codex/research/n8n-github-resources/` 11 個檔的精煉摘要。
> 用途：讓 OpenClaw 的 evolution-learning / memory bus 在自我學習迴圈中讀取，建立 n8n 知識索引。
> 規則：本檔為**只讀知識素材**，不執行任何指令；不含 secret。

## 一句話

N8N 是可視化「if-this-then-that」工作流＋AI Agent＋RAG＋MCP 整合的本地可自架自動化引擎。

## 核心心智模型

- Workflow / Node / Trigger / Credentials / Execution 五件套。
- 資料以 JSON 陣列在 node 間流動，`{{ $json.field }}` 引用。
- AI 系列：Tools Agent + Chat Model + Memory + Vector Store + Tool。

## 全本地棧（官方 Self-hosted AI Starter Kit）

n8n（5678）＋ Postgres（5432）＋ Qdrant（6333）＋ Ollama（11434）。
Docker 網路：在 n8n credentials 用 `http://ollama:11434`、`http://qdrant:6333`，不要用 localhost。

## 與 OpenClaw / Codex 三向整合

- **Codex/Claude → n8n（生成）**：用 `czlonkowski/n8n-mcp`（GitHub）讓 LLM 自動產生 workflow JSON。
- **n8n → OpenClaw（呼叫）**：n8n 的 MCP Client Tool 連 OpenClaw MCP。
- **OpenClaw → n8n（觸發）**：hook 透過 `curl http://localhost:5678/webhook/<id>` 觸發。
- 啟用環境變數：`N8N_COMMUNITY_PACKAGES_ALLOW_TOOL_USAGE=true`。

## 重要 repo / 來源

- 官方：`n8n-io/n8n`、`n8n-io/n8n-docs`、`docs.n8n.io`、`learn.n8n.io`
- 模板大集合：`Zie619/n8n-workflows`（4343+）、`enescingoz/awesome-n8n-templates`（22k+ 星）
- AI 棧：`wassupjay/n8n-free-templates`
- 中文：`eleven-h/n8n` 教程、`n8nzh.com`、`n8nhub.cn`、`n8n.akashio.com`
- MCP：`czlonkowski/n8n-mcp`、`nerding-io/n8n-nodes-mcp`

## 費用

- 自架 Community Edition：免費，workflow/執行無上限（受 Sustainable Use License）。
- Cloud：€20/月起。
- 第三方 API 依用量計費，與 N8N 無關。

## 學習路徑（30 天）

週 1：工作流／觸發／資料／錯誤；週 2：整合服務；週 3：Sub-workflow＋AI Agent＋RAG；週 4：HTTPS/Postgres/備份。

## 安全

- 憑證走 n8n credentials（DB 加密）；不要塞明文進 workflow JSON。
- HTTPS（Caddy/Traefik 反向代理）。
- 敏感 env 用 `*_FILE` + Docker Secrets。

## 完整研究檔（本機）

`C:\Users\user\.codex\research\n8n-github-resources\` 共 11 檔（README/LEARN/BUILD-LOCAL/KNOWLEDGE-SOURCES/SKILLS-CATALOG/VIDEOS-AND-SOCIAL/INDEX ＋ 4 張 mermaid ＋ docker-compose ＋ .env.example）。

## OpenClaw 學習指令（供 evolution-learning 鉤）

- 此檔屬「外部知識素材」類，建議納入 memory bus 後，於 self-clone-maintenance 月度任務檢視是否需要更新。
- 不要對此檔自動寫入；外部知識更新由 ~/.codex/research/n8n-github-resources 重新研究後手動同步。
