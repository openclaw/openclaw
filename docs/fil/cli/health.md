---
summary: "Sanggunian ng CLI para sa `openclaw health` (health endpoint ng Gateway sa pamamagitan ng RPC)"
read_when:
  - Gusto mong mabilis na suriin ang kalusugan ng tumatakbong Gateway
title: "kalusugan"
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
