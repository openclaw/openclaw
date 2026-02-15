---
summary: "用於瀏覽器自動化和 X/Twitter 發文的手動登入"
read_when:
  - 您需要登入網站以進行瀏覽器自動化
  - 您想將更新發佈到 X/Twitter
title: "瀏覽器登入"
---

# 瀏覽器登入 + X/Twitter 發文

## 手動登入（建議）

當網站需要登入時，請在**主機**瀏覽器設定檔（OpenClaw 瀏覽器）中**手動登入**。

**不要**將您的憑證提供給智慧代理。自動登入通常會觸發反機器人防禦並可能鎖定帳戶。

返回主瀏覽器文件：[Browser](/tools/browser)。

## 使用哪個 Chrome 設定檔？

OpenClaw 控制一個**專用的 Chrome 設定檔**（名為 `openclaw`，帶有橘色調的 UI）。這與您日常使用的瀏覽器設定檔是分開的。

兩種簡單的存取方式：

1. **要求智慧代理開啟瀏覽器**，然後您自行登入。
2. **透過 CLI 開啟**：

```bash
openclaw browser start
openclaw browser open https://x.com
```

如果您有多個設定檔，請傳遞 `--browser-profile <name>`（預設為 `openclaw`）。

## X/Twitter：建議流程

- **閱讀/搜尋/討論串**：使用**主機**瀏覽器（手動登入）。
- **發佈更新**：使用**主機**瀏覽器（手動登入）。

## 沙箱隔離 + 主機瀏覽器存取

沙箱隔離的瀏覽器工作階段**更有可能**觸發機器人偵測。對於 X/Twitter（和其他嚴格的網站），請優先使用**主機**瀏覽器。

如果智慧代理是沙箱隔離的，瀏覽器工具會預設為沙箱。若要允許主機控制：

```json5
{
  agents: {
    defaults: {
      sandbox: {
        mode: "non-main",
        browser: {
          allowHostControl: true,
        },
      },
    },
  },
}
```

然後指定主機瀏覽器：

```bash
openclaw browser open https://x.com --browser-profile openclaw --target host
```

或者停用發佈更新的智慧代理的沙箱隔離。
