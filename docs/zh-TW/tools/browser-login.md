---
summary: Manual logins for browser automation + X/Twitter posting
read_when:
  - You need to log into sites for browser automation
  - You want to post updates to X/Twitter
title: Browser Login
---

# 瀏覽器登入 + X/Twitter 發文

## 手動登入（推薦）

當網站需要登入時，請在 **host** 瀏覽器設定檔（openclaw 瀏覽器）中**手動登入**。

請**勿**將您的帳號密碼提供給模型。自動登入常會觸發反機器人防護，可能導致帳號被鎖。

回到主瀏覽器文件：[Browser](/tools/browser)。

## 使用哪個 Chrome 設定檔？

OpenClaw 控制一個**專用的 Chrome 設定檔**（名稱為 `openclaw`，介面帶橘色調）。這與您日常使用的瀏覽器設定檔是分開的。

兩種簡單的存取方式：

1. **請代理程式開啟瀏覽器**，然後自行登入。
2. **透過 CLI 開啟**：

```bash
openclaw browser start
openclaw browser open https://x.com
```

如果您有多個設定檔，請傳入 `--browser-profile <name>`（預設為 `openclaw`）。

## X/Twitter：推薦流程

- **閱讀/搜尋/串流：** 使用 **host** 瀏覽器（手動登入）。
- **發佈更新：** 使用 **host** 瀏覽器（手動登入）。

## 沙盒環境 + host 瀏覽器存取

沙盒瀏覽器工作階段**較容易**觸發機器人偵測。對於 X/Twitter（及其他嚴格網站），建議使用 **host** 瀏覽器。

如果代理是沙盒環境，瀏覽器工具預設會使用沙盒。若要允許主機控制：

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

接著鎖定主機瀏覽器：

```bash
openclaw browser open https://x.com --browser-profile openclaw --target host
```

或者關閉發佈更新代理的沙盒限制。
