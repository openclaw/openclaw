---
summary: "광역 검색 도우미를 위한 CLI 참조"
read_when:
  - Tailscale + CoreDNS 를 통해 광역 검색 (DNS-SD) 을 원할 때
  - 사용자 정의 검색 도메인 (예: openclaw.internal) 에 대해 분할 DNS 를 설정할 때
title: "dns"
---

# `openclaw dns`

광역 검색 (Tailscale + CoreDNS) 을 위한 DNS 도우미입니다. 현재 macOS + Homebrew CoreDNS 에 초점을 맞추고 있습니다.

관련 사항:

- Gateway 검색: [Discovery](/gateway/discovery)
- 광역 검색 구성: [Configuration](/gateway/configuration)

## 설정

```bash
openclaw dns setup
openclaw dns setup --apply
```

---

x-i18n:
generated_at: "2026-03-02T00:00:00Z"
model: claude-opus-4-6
provider: pi
source_path: docs/cli/dns.md
workflow: 15
