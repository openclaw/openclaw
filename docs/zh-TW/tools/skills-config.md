---
summary: "Skills 設定結構與範例"
read_when:
  - 新增或修改 Skills 設定時
  - 調整內建白名單或安裝行為時
title: "Skills 設定"
---

# Skills 設定

所有與 Skills 相關的設定都位於 `~/.openclaw/openclaw.json` 中的 `skills` 欄位下。

```json5
{
  skills: {
    allowBundled: ["gemini", "peekaboo"],
    load: {
      extraDirs: ["~/Projects/agent-scripts/skills", "~/Projects/oss/some-skill-pack/skills"],
      watch: true,
      watchDebounceMs: 250,
    },
    install: {
      preferBrew: true,
      nodeManager: "npm", // npm | pnpm | yarn | bun (Gateway 執行環境仍為 Node；不建議使用 bun)
    },
    entries: {
      "nano-banana-pro": {
        enabled: true,
        apiKey: "GEMINI_KEY_HERE",
        env: {
          GEMINI_API_KEY: "GEMINI_KEY_HERE",
        },
      },
      peekaboo: { enabled: true },
      sag: { enabled: false },
    },
  },
}
```

## 欄位

- `allowBundled`: 內建 **bundled** Skills 的選擇性白名單。設定後，僅清單中的內建 Skills 可供使用（受管理/工作區 Skills 不受影響）。
- `load.extraDirs`: 額外掃描的 Skills 目錄（優先級最低）。
- `load.watch`: 監控 Skills 資料夾並重新整理 Skills 快照（預設值：true）。
- `load.watchDebounceMs`: Skills 監控事件的防彈跳時間（毫秒，預設值：250）。
- `install.preferBrew`: 若可用，優先使用 brew 安裝程式（預設值：true）。
- `install.nodeManager`: Node 安裝程式偏好 (`npm` | `pnpm` | `yarn` | `bun`，預設值：npm)。這僅影響 **Skills 安裝**；Gateway 執行環境仍應為 Node（WhatsApp/Telegram 不建議使用 Bun）。
- `entries.<skillKey>`: 個別 Skill 的覆寫設定。

個別 Skill 欄位：

- `enabled`: 設為 `false` 可停用該 Skill，即使它是內建或已安裝的。
- `env`: 注入智慧代理執行的環境變數（僅在未設定時注入）。
- `apiKey`: 為宣告主要環境變數的 Skills 提供的選用便利設定。

## 注意事項

- `entries` 下的鍵名預設對應 Skill 名稱。如果 Skill 定義了 `metadata.openclaw.skillKey`，請改用該鍵名。
- 啟用監控器時，Skills 的變更將在智慧代理的下一次輪詢中生效。

### 沙箱隔離的 Skills + 環境變數

當工作階段被**沙箱隔離**時，Skill 程序會在 Docker 內部執行。沙箱**不會**繼承主機的 `process.env`。

請使用以下其中一種方式：

- `agents.defaults.sandbox.docker.env`（或個別智慧代理的 `agents.list[].sandbox.docker.env`）
- 將環境變數封裝到自定義沙箱映像檔中

全域 `env` 以及 `skills.entries.<skill>.env/apiKey` 僅適用於**主機**端執行。
