---
summary: CLI reference for `openclaw security` (audit and fix common security footguns)
read_when:
  - You want to run a quick security audit on config/state
  - "You want to apply safe “fix” suggestions (chmod, tighten defaults)"
title: security
---

# `openclaw security`

安全工具（審計 + 可選修復）。

[[BLOCK_1]]

- 安全指南: [安全性](/gateway/security)

## Audit

```bash
openclaw security audit
openclaw security audit --deep
openclaw security audit --fix
openclaw security audit --json
```

審計警告當多個 DM 發送者共享主要會話時，並建議使用 **安全 DM 模式**：`session.dmScope="per-channel-peer"`（或 `per-account-channel-peer` 用於多帳戶頻道）來保護共享收件箱。這是為了加強合作/共享收件箱的安全性。由互不信任/對立的操作員共享的單一 Gateway 不是推薦的設置；應該使用分開的 Gateway（或分開的作業系統使用者/主機）來劃分信任邊界。

當設定建議可能的共享用戶進入時（例如開放的 DM/群組政策、設定的群組目標或通配符發送者規則），它也會發出 `security.trust_model.multi_user_heuristic`，並提醒您 OpenClaw 預設為個人助理信任模型。對於有意的共享用戶設置，審計指導建議將所有會話進行沙盒化，保持檔案系統訪問在工作區範圍內，並將個人/私密身份或憑證排除在該執行時之外。

當小型模型 (`<=300B`) 在未沙盒化且啟用網頁/瀏覽器工具的情況下使用時，它也會發出警告。對於 webhook 進入，當 `hooks.defaultSessionKey` 未設置時、請求 `sessionKey` 覆蓋啟用時，以及在未設置 `hooks.allowedSessionKeyPrefixes` 的情況下啟用覆蓋時，它也會發出警告。

當沙盒 Docker 設置在沙盒模式關閉時設定時，當 `gateway.nodes.denyCommands` 使用無效的模式類似/未知條目（僅精確的節點命令名稱匹配，而不是 shell 文本過濾），當 `gateway.nodes.allowCommands` 明確啟用危險的節點命令時，當全局 `tools.profile="minimal"` 被代理工具設定檔覆蓋時，當開放群組在沒有沙盒/工作區保護的情況下暴露執行時/檔案系統工具時，以及當已安裝的擴充插件工具可能在寬鬆的工具政策下可達時，它也會發出警告。

它還標記 `gateway.allowRealIpFallback=true`（如果代理設定錯誤則存在標頭欺騙風險）和 `discovery.mdns.mode="full"`（通過 mDNS TXT 記錄的元數據洩漏）。當沙盒瀏覽器使用 Docker `bridge` 網路而未設置 `sandbox.browser.cdpSourceRange` 時，它也會發出警告。它還標記危險的沙盒 Docker 網路模式（包括 `host` 和 `container:*` 命名空間聯接）。

當現有的沙盒瀏覽器 Docker 容器缺少/過時的哈希標籤（例如遷移前的容器缺少 `openclaw.browserConfigEpoch`）時，它也會發出警告，並建議 `openclaw sandbox recreate --browser --all`。當基於 npm 的插件/鉤子安裝記錄未固定、缺少完整性元數據或與當前安裝的包版本不一致時，它也會發出警告。

當頻道允許清單依賴於可變的名稱/電子郵件/標籤而不是穩定的 ID（Discord、Slack、Google Chat、MS Teams、Mattermost、IRC 範圍適用）時，它也會發出警告。當 `gateway.auth.mode="none"` 使 Gateway HTTP API 在沒有共享密鑰的情況下可達時（`/tools/invoke` 加上任何啟用的 `/v1/*` 端點），它也會發出警告。

以 `dangerous`/`dangerously` 為前綴的設置是明確的緊急操作員覆蓋；啟用其中一個本身並不是安全漏洞報告。欲了解完整的危險參數清單，請參見 [安全](/gateway/security) 中的「不安全或危險標誌摘要」部分。

## JSON 輸出

使用 `--json` 進行 CI/政策檢查：

```bash
openclaw security audit --json | jq '.summary'
openclaw security audit --deep --json | jq '.findings[] | select(.severity=="critical") | .checkId'
```

如果 `--fix` 和 `--json` 結合，輸出將包含修正行動和最終報告：

```bash
openclaw security audit --fix --json | jq '{fix: .fix.ok, summary: .report.summary}'
```

## What `--fix` changes

`--fix` 會應用安全且可預測的修復措施：

- 將常見的 `groupPolicy="open"` 轉換為 `groupPolicy="allowlist"`（包括支援通道中的帳戶變體）
- 將 `logging.redactSensitive` 從 `"off"` 設定為 `"tools"`
- 收緊狀態/設定和常見敏感文件的權限 (`credentials/*.json`, `auth-profiles.json`, `sessions.json`, 會話 `*.jsonl`)

`--fix` 不會：

- 旋轉 tokens/密碼/API 金鑰
- 停用工具 (`gateway`, `cron`, `exec`, 等等)
- 更改閘道綁定/認證/網路暴露選項
- 移除或重寫插件/技能
