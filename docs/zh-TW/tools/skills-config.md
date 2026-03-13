---
summary: Skills config schema and examples
read_when:
  - Adding or modifying skills config
  - Adjusting bundled allowlist or install behavior
title: Skills Config
---

# 技能設定

所有與技能相關的設定都位於 `skills` 中的 `~/.openclaw/openclaw.json`。

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
        apiKey: { source: "env", provider: "default", id: "GEMINI_API_KEY" }, // or plaintext string
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

- `allowBundled`：僅限 **內建** 技能的選擇性允許清單。設定後，只有清單中的內建技能才有資格（管理/工作區技能不受影響）。
- `load.extraDirs`：額外要掃描的技能目錄（優先權最低）。
- `load.watch`：監控技能資料夾並刷新技能快照（預設：true）。
- `load.watchDebounceMs`：技能監控事件的防彈跳時間，單位為毫秒（預設：250）。
- `install.preferBrew`：有可用時優先使用 brew 安裝器（預設：true）。
- `install.nodeManager`：Node 安裝器偏好 (`npm` | `pnpm` | `yarn` | `bun`，預設：npm）。
  此設定僅影響 **技能安裝**；Gateway 執行環境仍應使用 Node（不建議 WhatsApp/Telegram 使用 Bun）。
- `entries.<skillKey>`：每個技能的覆寫設定。

每個技能的欄位：

- `enabled`：設定 `false` 以禁用該技能，即使它是內建或已安裝。
- `env`：注入代理執行時的環境變數（僅在尚未設定時）。
- `apiKey`：為宣告主要環境變數的技能提供的選用便利功能。
  支援純文字字串或 SecretRef 物件 (`{ source, provider, id }`)。

## 備註

- `entries` 下的鍵預設對應技能名稱。若技能定義了 `metadata.openclaw.skillKey`，則改用該鍵。
- 啟用監控器時，技能的變更會在下一個代理回合被偵測。

### 沙盒技能 + 環境變數

當會話為 **沙盒** 模式時，技能程序會在 Docker 內執行。沙盒不會繼承主機的 `process.env`。

請使用以下其中一種方式：

- `agents.defaults.sandbox.docker.env`（或每個代理的 `agents.list[].sandbox.docker.env`）
- 將環境變數烘焙進自訂沙盒映像檔

全域 `env` 和 `skills.entries.<skill>.env/apiKey` 僅適用於 **主機** 執行。
