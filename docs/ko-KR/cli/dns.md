---
summary: "`openclaw dns` CLI 레퍼런스 (광역 디스커버리 헬퍼)"
read_when:
  - Tailscale + CoreDNS를 통한 광역 디스커버리(DNS-SD)를 원할 때
  - 사용자 지정 디스커버리 도메인을 위한 스플릿 DNS를 설정할 때 (예: openclaw.internal)
title: "dns"
x-i18n:
  source_path: "docs/cli/dns.md"
---

# `openclaw dns`

광역 디스커버리를 위한 DNS 헬퍼입니다 (Tailscale + CoreDNS). 현재 macOS + Homebrew CoreDNS에 중점을 두고 있습니다.

관련 문서:

- Gateway 디스커버리: [Discovery](/gateway/discovery)
- 광역 디스커버리 설정: [Configuration](/gateway/configuration)

## 설정

```bash
openclaw dns setup
openclaw dns setup --apply
```
