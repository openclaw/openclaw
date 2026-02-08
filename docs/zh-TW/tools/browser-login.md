---
summary: "瀏覽器自動化與 X/Twitter 發佈的手動登入"
read_when:
  - 你需要為瀏覽器自動化登入網站
  - 你想要在 X/Twitter 發佈更新
title: "瀏覽器登入"
x-i18n:
  source_path: tools/browser-login.md
  source_hash: c30faa9da6c6ef70
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:29:27Z
---

# 瀏覽器登入 + X/Twitter 發佈

## 手動登入（建議）

當網站需要登入時，請在**主機**的瀏覽器設定檔（OpenClaw 瀏覽器）中**自行手動登入**。

**不要**將你的憑證提供給模型。自動化登入經常會觸發反機器人防護，並可能鎖定帳戶。

返回主要的瀏覽器文件：[Browser](/tools/browser)。

## 使用的是哪個 Chrome 設定檔？

OpenClaw 會控制一個**專用的 Chrome 設定檔**（名稱為 `openclaw`，介面帶有橘色調）。這與你日常使用的瀏覽器設定檔是分開的。

有兩種簡單的存取方式：

1. **請代理程式開啟瀏覽器**，然後由你自行登入。
2. **透過 CLI 開啟**：

```bash
openclaw browser start
openclaw browser open https://x.com
```

如果你有多個設定檔，請傳入 `--browser-profile <name>`（預設為 `openclaw`）。

## X/Twitter：建議流程

- **閱讀／搜尋／討論串：** 使用**主機**瀏覽器（手動登入）。
- **發佈更新：** 使用**主機**瀏覽器（手動登入）。

## 沙箱隔離 + 主機瀏覽器存取

沙箱隔離的瀏覽器工作階段**較容易**觸發機器人偵測。對於 X/Twitter（以及其他嚴格的網站），請優先使用**主機**瀏覽器。

如果代理程式在沙箱中，瀏覽器工具會預設使用沙箱。若要允許主機控制：

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

接著指定主機瀏覽器：

```bash
openclaw browser open https://x.com --browser-profile openclaw --target host
```

或為負責發佈更新的代理程式停用沙箱隔離。
