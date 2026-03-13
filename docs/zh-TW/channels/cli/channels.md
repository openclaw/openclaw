---
summary: "CLI reference for `openclaw channels` (accounts, status, login/logout, logs)"
read_when:
  - >-
    You want to add/remove channel accounts (WhatsApp/Telegram/Discord/Google
    Chat/Slack/Mattermost (plugin)/Signal/iMessage)
  - You want to check channel status or tail channel logs
title: channels
---

# `openclaw channels`

管理 Gateway 上的聊天頻道帳戶及其執行狀態。

相關文件：

- 頻道指南: [Channels](/channels/index)
- 閘道設定: [Configuration](/gateway/configuration)

## 常用指令

```bash
openclaw channels list
openclaw channels status
openclaw channels capabilities
openclaw channels capabilities --channel discord --target channel:123
openclaw channels resolve --channel slack "#general" "@jane"
openclaw channels logs --channel all
```

## 新增 / 移除帳戶

```bash
openclaw channels add --channel telegram --token <bot-token>
openclaw channels remove --channel telegram --delete
```

提示：`openclaw channels add --help` 顯示每個通道的標誌（token、應用程式 token、signal-cli 路徑等）。

當你在沒有標誌的情況下執行 `openclaw channels add` 時，互動式精靈可以提示：

- 每個選定頻道的帳戶 ID
- 這些帳戶的可選顯示名稱
- `Bind configured channel accounts to agents now?`

如果您現在確認綁定，精靈會詢問每個已設定的通道帳戶應由哪個代理擁有，並寫入帳戶範圍的路由綁定。

您也可以稍後使用 `openclaw agents bindings`、`openclaw agents bind` 和 `openclaw agents unbind` 來管理相同的路由規則（請參見 [agents](/cli/agents)）。

當您將一個非預設帳戶添加到仍在使用單帳戶頂層設定的頻道（尚未有 `channels.<channel>.accounts` 條目）時，OpenClaw 會將帳戶範圍的單帳戶頂層值移動到 `channels.<channel>.accounts.default`，然後寫入新的帳戶。這樣可以在轉換為多帳戶形狀的同時保留原始帳戶的行為。

路由行為保持一致：

- 現有的僅通道綁定（無 `accountId`）繼續匹配預設帳戶。
- `channels add` 在非互動模式下不會自動創建或重寫綁定。
- 互動設置可以選擇性地添加帳戶範圍的綁定。

如果您的設定已經處於混合狀態（存在命名帳戶、缺少 `default`，並且頂層的單一帳戶值仍然設置），請執行 `openclaw doctor --fix` 將帳戶範圍的值移動到 `accounts.default`。

## 登入 / 登出 (互動式)

```bash
openclaw channels login --channel whatsapp
openclaw channels logout --channel whatsapp
```

## 故障排除

- 執行 `openclaw status --deep` 以進行廣泛探測。
- 使用 `openclaw doctor` 進行指導修正。
- `openclaw channels list` 列印 `Claude: HTTP 403 ... user:profile` → 使用快照需要 `user:profile` 範圍。使用 `--no-usage`，或提供 claude.ai 會話金鑰 (`CLAUDE_WEB_SESSION_KEY` / `CLAUDE_WEB_COOKIE`), 或透過 Claude Code CLI 重新驗證。
- `openclaw channels status` 在無法連接到網關時會回退到僅設定的摘要。如果透過 SecretRef 設定了受支援的通道憑證，但在當前命令路徑中不可用，則會將該帳戶報告為已設定，並附上降級註解，而不是顯示為未設定。

## 能力探測

獲取提供者能力提示（可用的意圖/範圍）以及靜態功能支援：

```bash
openclaw channels capabilities
openclaw channels capabilities --channel discord --target channel:123
```

[[BLOCK_1]]

- `--channel` 是可選的；省略它將列出所有頻道（包括擴充）。
- `--target` 接受 `channel:<id>` 或原始數字頻道 ID，並且僅適用於 Discord。
- 探測器是特定於提供者的：Discord 意圖 + 可選的頻道權限；Slack 機器人 + 使用者範圍；Telegram 機器人標誌 + 網頁鉤子；Signal 守護進程版本；MS Teams 應用程式 token + Graph 角色/範圍（已知的地方已註明）。沒有探測器的頻道報告 `Probe: unavailable`。

## 將名稱解析為 ID

使用提供者目錄解析頻道/用戶名稱為 ID：

```bash
openclaw channels resolve --channel slack "#general" "@jane"
openclaw channels resolve --channel discord "My Server/#support" "@someone"
openclaw channels resolve --channel matrix "Project Room"
```

[[BLOCK_1]]

- 使用 `--kind user|group|auto` 來強制目標類型。
- 當多個條目共享相同名稱時，解析會優先考慮活動匹配。
- `channels resolve` 是唯讀的。如果所選帳戶是通過 SecretRef 設定的，但該憑證在當前命令路徑中不可用，則該命令會返回降級的未解析結果，並附上說明，而不是中止整個執行。
