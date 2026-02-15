---
summary: "Skills 設定綱要與範例"
read_when:
  - 新增或修改 Skills 設定
  - 調整綁定允許清單或安裝行為
title: "Skills 設定"
---

# Skills 設定

所有與 Skills 相關的設定都位於 `~/.openclaw/openclaw.json` 中的 `skills` 之下。

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
      nodeManager: "npm", // npm | pnpm | yarn | bun (Gateway runtime still Node; bun not recommended)
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

- `allowBundled`: 僅限用於**綁定** Skills 的選用允許清單。設定後，只有清單中的綁定 Skills 才符合資格（不影響受管理/工作區 Skills）。
- `load.extraDirs`: 額外要掃描的 Skills 目錄（優先級最低）。
- `load.watch`: 監看 Skills 資料夾並重新整理 Skills 快照（預設：true）。
- `load.watchDebounceMs`: Skills 監看事件的防抖延遲時間（毫秒）（預設：250）。
- `install.preferBrew`: 優先使用 brew 安裝程式（如果可用）（預設：true）。
- `install.nodeManager`: Node 安裝程式偏好設定 (`npm` | `pnpm` | `yarn` | `bun`，預設：npm）。這僅影響 **Skills 安裝**；Gateway 執行時仍應為 Node（不建議將 Bun 用於 WhatsApp/Telegram）。
- `entries.<skillKey>`: 每個 Skills 的覆寫設定。

每個 Skills 的欄位：

- `enabled`: 將 `false` 設定為停用某個 Skills，即使它是綁定/已安裝的。
- `env`: 為智慧代理執行注入的環境變數（僅在未設定時）。
- `apiKey`: 對於宣告主要環境變數的 Skills 而言是選用方便欄位。

## 注意事項

- `entries` 下方的鍵名預設對應到 Skills 名稱。如果 Skills 定義了 `metadata.openclaw.skillKey`，則改用該鍵名。
- 當監看器啟用時，Skills 的變更會在智慧代理的下一個回合中生效。

### 沙箱隔離 Skills + 環境變數

當一個工作階段是**沙箱隔離**時，Skills 程式會在 Docker 內部執行。沙箱**不會**繼承主機的 `process.env`。

請使用以下其中一種方式：

- `agents.defaults.sandbox.docker.env` (或每個智慧代理的 `agents.list[].sandbox.docker.env`)
- 將環境變數烘焙到您的自訂沙箱隔離映像檔中

全域的 `env` 和 `skills.entries.<skill>.env/apiKey` 僅適用於**主機**執行。
