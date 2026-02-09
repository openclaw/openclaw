---
summary: "Skills 設定結構與範例"
read_when:
  - 新增或修改 Skills 設定
  - 調整隨附允許清單或安裝行為
title: "Skills 設定"
---

# Skills 設定

所有與 Skills 相關的設定都位於 `skills` 之下，並存放於 `~/.openclaw/openclaw.json`。

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

- `allowBundled`：僅適用於 **隨附** Skills 的選用允許清單。設定後，只有清單中的
  隨附 Skills 會被納入（不影響受管理／工作區 Skills）。 設定後，只有
  清單中的隨附技能符合資格（受管/工作區技能不受影響）。
- `load.extraDirs`：要掃描的額外 Skills 目錄（最低優先順序）。
- `load.watch`：監看 Skills 資料夾並重新整理 Skills 快照（預設：true）。
- `load.watchDebounceMs`：Skills 監看事件的去彈跳時間（毫秒，預設：250）。
- `install.preferBrew`：可用時偏好使用 brew 安裝器（預設：true）。
- `install.nodeManager`：Node 安裝器偏好（`npm` | `pnpm` | `yarn` | `bun`，預設：npm）。
  此設定僅影響 **Skills 安裝**；Gateway 閘道器 執行階段仍應使用 Node
  （不建議 WhatsApp／Telegram 使用 Bun）。
  這只影響**技能安裝**；Gateway 執行階段仍應使用 Node
  （不建議在 WhatsApp/Telegram 使用 Bun）。
- `entries.<skillKey>`：逐一 Skill 的覆寫設定。

逐一 Skill 欄位：

- `enabled`：將 `false` 設為關閉，以停用該 Skill，即使它是隨附／已安裝。
- `env`：為代理程式執行時注入的環境變數（僅在尚未設定時）。
- `apiKey`：為宣告主要環境變數的 Skills 提供的選用便利設定。

## 注意事項

- Keys under `entries` map to the skill name by default. `entries` 之下的鍵預設會對應到 Skill 名稱。若某個 Skill 定義了
  `metadata.openclaw.skillKey`，則改用該鍵。
- 啟用監看時，對 Skills 的變更會在下一個代理程式回合被偵測並套用。

### Sandboxed skills + env vars

當工作階段為 **沙箱隔離** 時，Skill 程序會在 Docker 內執行。沙箱
**不會** 繼承主機的 `process.env`。 The sandbox
does **not** inherit the host `process.env`.

請使用以下其中一種方式：

- `agents.defaults.sandbox.docker.env`（或逐一代理程式的 `agents.list[].sandbox.docker.env`）
- 將環境變數烘焙進你的自訂沙箱映像

全域的 `env` 與 `skills.entries.<skill>.env/apiKey` 僅適用於 **主機** 執行。
