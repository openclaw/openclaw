---
summary: "Tham chiếu CLI cho `openclaw dns` (các trợ giúp khám phá phạm vi rộng)"
read_when:
  - Bạn muốn khám phá phạm vi rộng (DNS-SD) qua Tailscale + CoreDNS
  - Bạn đang thiết lập split DNS cho một miền khám phá tùy chỉnh (ví dụ: openclaw.internal)
title: "dns"
x-i18n:
  source_path: cli/dns.md
  source_hash: d2011e41982ffb4b
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:38:14Z
---

# `openclaw dns`

Các trợ giúp DNS cho khám phá phạm vi rộng (Tailscale + CoreDNS). Hiện tập trung vào macOS + Homebrew CoreDNS.

Liên quan:

- Khám phá Gateway: [Discovery](/gateway/discovery)
- Cấu hình khám phá phạm vi rộng: [Configuration](/gateway/configuration)

## Thiết lập

```bash
openclaw dns setup
openclaw dns setup --apply
```
