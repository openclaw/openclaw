---
summary: "`openclaw dns`에 대한 CLI 레퍼런스 (광역 디스커버리 도우미)"
read_when:
  - Tailscale + CoreDNS를 통한 광역 디스커버리 (DNS-SD)가 필요할 때
  - You’re setting up split DNS for a custom discovery domain (example: openclaw.internal)
title: "dns"
---

# `openclaw dns`

광역 디스커버리 (Tailscale + CoreDNS)를 위한 DNS 도우미입니다. 현재는 macOS + Homebrew CoreDNS에 중점을 둡니다.

관련 항목:

- Gateway 디스커버리: [디바이스 검색](/gateway/discovery)
- 광역 디스커버리 설정: [구성](/gateway/configuration)

## 설정

```bash
openclaw dns setup
openclaw dns setup --apply
```
