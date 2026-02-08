---
summary: "Sanggunian ng CLI para sa `openclaw health` (health endpoint ng Gateway sa pamamagitan ng RPC)"
read_when:
  - Gusto mong mabilis na suriin ang kalusugan ng tumatakbong Gateway
title: "kalusugan"
x-i18n:
  source_path: cli/health.md
  source_hash: 82a78a5a97123f7a
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:45:13Z
---

# `openclaw health`

Kunin ang kalusugan mula sa tumatakbong Gateway.

```bash
openclaw health
openclaw health --json
openclaw health --verbose
```

Mga tala:

- `--verbose` nagpapatakbo ng mga live probe at nagpi-print ng mga timing kada account kapag maraming account ang naka-configure.
- Kasama sa output ang mga session store kada agent kapag maraming agent ang naka-configure.
