---
summary: "CLI 參考：`openclaw dns`（廣域裝置探索輔助工具）"
read_when:
  - 您想透過 Tailscale + CoreDNS 進行廣域裝置探索 (DNS-SD)
  - 您正在為自訂裝置探索網域（例如：openclaw.internal）設定 Split DNS
title: "dns"
---

# `openclaw dns`

用於廣域裝置探索 (Tailscale + CoreDNS) 的 DNS 輔助工具。目前主要針對 macOS + Homebrew CoreDNS。

相關內容：

- Gateway 裝置探索：[裝置探索](/gateway/discovery)
- 廣域裝置探索設定：[設定](/gateway/configuration)

## 設定

```bash
openclaw dns setup
openclaw dns setup --apply
```
