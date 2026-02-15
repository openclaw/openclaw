---
summary: "openclaw dns 的 CLI 參考 (廣域裝置探索輔助程式)"
read_when:
  - 當您想要透過 Tailscale + CoreDNS 進行廣域裝置探索 (DNS-SD)
  - 當您為自訂裝置探索網域 (例如: openclaw.internal) 設定分離式 DNS 時
title: "dns"
---

# `openclaw dns`

適用於廣域裝置探索 (Tailscale + CoreDNS) 的 DNS 輔助程式。目前主要支援 macOS + Homebrew CoreDNS。

相關內容：

- Gateway 裝置探索: [裝置探索](/gateway/discovery)
- 廣域裝置探索 設定: [設定](/gateway/configuration)

## 設定

```bash
openclaw dns setup
openclaw dns setup --apply
```
