---
summary: "用於瀏覽器自動化 + X/Twitter 發文的手動登入"
read_when:
  - 您需要登入網站以進行瀏覽器自動化
  - 您想要在 X/Twitter 發布更新
title: "瀏覽器登入"
---

# 瀏覽器登入 + X/Twitter 發文

## 手動登入（推薦）

當網站要求登入時，請在 **主機 (host)** 瀏覽器設定檔（openclaw 瀏覽器）中 **手動登入**。

切勿將您的憑證提供給模型。自動登入通常會觸發反機器人防禦機制，並可能導致帳號被鎖定。

返回主瀏覽器文件：[Browser](/tools/browser)。

## 使用哪個 Chrome 設定檔？

OpenClaw 控制一個 **專用的 Chrome 設定檔**（名稱為 `openclaw`，具有橘色調的 UI）。這與您日常使用的瀏覽器設定檔是分開的。

有兩種簡單的存取方式：

1. **要求智慧代理開啟瀏覽器**，然後由您自己登入。
2. **透過 CLI 開啟**：

```bash
openclaw browser start
openclaw browser open https://x.com
```

如果您有多個設定檔，請傳遞 `--browser-profile <name>`（預設為 `openclaw`）。

## X/Twitter：推薦流程

- **閱讀/搜尋/討論串：** 使用 **主機 (host)** 瀏覽器（手動登入）。
- **發布更新：** 使用 **主機 (host)** 瀏覽器（手動登入）。

## 沙箱隔離 + 主機瀏覽器存取

沙箱隔離的瀏覽器工作階段 **更有可能** 觸發機器人偵測。對於 X/Twitter（或其他嚴格的網站），請優先使用 **主機 (host)** 瀏覽器。

如果智慧代理處於沙箱環境中，瀏覽器工具預設會使用沙箱。若要允許主機控制：

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

或者為負責發布更新的智慧代理停用沙箱隔離。
