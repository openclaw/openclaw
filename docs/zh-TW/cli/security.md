---
summary: CLI reference for `openclaw security` (audit and fix common security footguns)
read_when:
  - You want to run a quick security audit on config/state
  - "You want to apply safe “fix” suggestions (chmod, tighten defaults)"
title: security
---

# `openclaw security`

安全工具（稽核 + 選用修正）。

相關：

- 安全指南：[Security](/gateway/security)

## 稽核

```bash
openclaw security audit
openclaw security audit --deep
openclaw security audit --fix
openclaw security audit --json
```

當多個 DM 寄件者共用主會話時，稽核會發出警告，並建議對共用收件匣使用**安全 DM 模式**：`session.dmScope="per-channel-peer"`（多帳號頻道則使用 `per-account-channel-peer`）。
此為合作/共用收件匣的強化措施。不建議由相互不信任或對立的操作員共用單一 Gateway；應透過分割信任邊界，使用獨立 Gateway（或獨立作業系統使用者/主機）。
當設定暗示可能有共用使用者的入口（例如開放 DM/群組政策、設定的群組目標，或萬用字元寄件者規則）時，也會發出 `security.trust_model.multi_user_heuristic` 警告，並提醒 OpenClaw 預設為個人助理信任模型。
對於刻意的共用使用者設定，稽核建議將所有會話沙箱化，將檔案系統存取限制在工作區範圍，並避免在該執行環境中使用個人/私密身份或憑證。
當使用小型模型（`<=300B`）且未啟用沙箱，且開啟網頁/瀏覽器工具時，也會發出警告。
對於 webhook 入口，若未設定 `hooks.defaultSessionKey`，或啟用請求 `sessionKey` 覆寫，且未啟用 `hooks.allowedSessionKeyPrefixes`，也會警告。
當沙箱 Docker 設定已設定但沙箱模式未開啟、`gateway.nodes.denyCommands` 使用無效的類似模式或未知條目（僅精確節點命令名稱匹配，不支援 shell 文字過濾）、`gateway.nodes.allowCommands` 明確啟用危險的節點命令、全域 `tools.profile="minimal"` 被代理工具設定覆寫、開放群組暴露執行時/檔案系統工具且無沙箱/工作區防護、已安裝的擴充插件工具可能在寬鬆工具政策下可被存取時，也會發出警告。
此外，還會標記 `gateway.allowRealIpFallback=true`（代理設定錯誤時的標頭偽造風險）和 `discovery.mdns.mode="full"`（透過 mDNS TXT 紀錄的元資料外洩）。
當沙箱瀏覽器使用 Docker `bridge` 網路但未啟用 `sandbox.browser.cdpSourceRange` 時，也會警告。
危險的沙箱 Docker 網路模式（包含 `host` 和 `container:*` 命名空間連接）也會被標記。
當現有沙箱瀏覽器 Docker 容器缺少或使用過期的雜湊標籤（例如遷移前容器缺少 `openclaw.browserConfigEpoch`）時，會警告並建議 `openclaw sandbox recreate --browser --all`。
當基於 npm 的插件/掛勾安裝紀錄未鎖定版本、缺少完整性元資料，或與目前安裝的套件版本不符時，也會警告。
當頻道允許清單依賴可變的名稱/電子郵件/標籤，而非穩定 ID（適用於 Discord、Slack、Google Chat、MS Teams、Mattermost、IRC 範圍）時，也會警告。
當 `gateway.auth.mode="none"` 使 Gateway HTTP API 在無共用密鑰（`/tools/invoke` 加上任何啟用的 `/v1/*` 端點）情況下可被存取時，也會警告。
以 `dangerous`/`dangerously` 為前綴的設定為明確的緊急操作員覆寫；啟用其中一項本身不構成安全漏洞報告。
完整的危險參數清單，請參閱 [Security](/gateway/security) 中的「不安全或危險旗標摘要」章節。

## JSON 輸出

用 `--json` 進行 CI/政策檢查：

```bash
openclaw security audit --json | jq '.summary'
openclaw security audit --deep --json | jq '.findings[] | select(.severity=="critical") | .checkId'
```

若結合 `--fix` 和 `--json`，輸出將包含修正動作與最終報告：

```bash
openclaw security audit --fix --json | jq '{fix: .fix.ok, summary: .report.summary}'
```

## `--fix` 變更內容

`--fix` 採用安全且確定性的修正措施：

- 將常見 `groupPolicy="open"` 反轉為 `groupPolicy="allowlist"`（包含支援頻道中的帳號變體）
- 將 `logging.redactSensitive` 從 `"off"` 設定為 `"tools"`
- 收緊狀態/設定與常見敏感檔案的權限（`credentials/*.json`、`auth-profiles.json`、`sessions.json`、會話 `*.jsonl`）

`--fix` **不會**：

- 旋轉 token／密碼／API 金鑰
- 停用工具（`gateway`、`cron`、`exec` 等）
- 更改閘道綁定／認證／網路暴露設定
- 移除或重寫外掛／技能
