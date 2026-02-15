---
summary: "CLI reference for `openclaw dns` (wide-area discovery helpers)"
read_when:
  - You want wide-area discovery (DNS-SD) via Tailscale + CoreDNS
  - You’re setting up split DNS for a custom discovery domain (example: openclaw.internal)
title: "dns"
x-i18n:
  source_hash: d2011e41982ffb4b71ab98211574529bc1c8b7769ab1838abddd593f42b12380
---

# `openclaw dns`

광역 검색을 위한 DNS 도우미(Tailscale + CoreDNS). 현재는 macOS + Homebrew CoreDNS에 중점을 두고 있습니다.

관련 항목:

- 게이트웨이 검색: [검색](/gateway/discovery)
- 광역 검색 구성: [구성](/gateway/configuration)

## 설정

```bash
openclaw dns setup
openclaw dns setup --apply
```
