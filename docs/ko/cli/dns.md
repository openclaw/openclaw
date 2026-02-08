---
read_when:
    - Tailscale + CoreDNS를 통한 광역 검색(DNS-SD)을 원합니다.
    - You’re setting up split DNS for a custom discovery domain (example: openclaw.internal)
summary: '`openclaw dns`에 대한 CLI 참조(광역 검색 도우미)'
title: DNS
x-i18n:
    generated_at: "2026-02-08T15:52:04Z"
    model: gtx
    provider: google-translate
    source_hash: d2011e41982ffb4b71ab98211574529bc1c8b7769ab1838abddd593f42b12380
    source_path: cli/dns.md
    workflow: 15
---

# `openclaw dns`

광역 검색을 위한 DNS 도우미(Tailscale + CoreDNS). 현재는 macOS + Homebrew CoreDNS에 중점을 두고 있습니다.

관련된:

- 게이트웨이 검색: [발견](/gateway/discovery)
- 광역 검색 구성: [구성](/gateway/configuration)

## 설정

```bash
openclaw dns setup
openclaw dns setup --apply
```
