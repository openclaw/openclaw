---
summary: "`openclaw dns` (광역 검색 도우미) CLI 레퍼런스"
read_when:
  - Tailscale + CoreDNS를 통한 광역 검색 (DNS-SD)을 원할 때
  - 사용자 정의 검색 도메인 (예: openclaw.internal)을 위한 분할 DNS 설정 중일 때
title: "dns"
---

# `openclaw dns`

광역 검색을 위한 DNS 도우미 (Tailscale + CoreDNS). 현재 macOS + Homebrew CoreDNS에 중점을 두고 있습니다.

관련 항목:

- 게이트웨이 검색: [디바이스 검색](/gateway/discovery)
- 광역 검색 설정: [설정](/gateway/configuration)

## 설정

```bash
openclaw dns setup
openclaw dns setup --apply
```
