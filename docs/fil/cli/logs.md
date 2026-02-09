---
summary: "Sanggunian ng CLI para sa `openclaw logs` (pag-tail ng mga log ng Gateway sa pamamagitan ng RPC)"
read_when:
  - Kailangan mong i-tail ang mga log ng Gateway nang remote (nang walang SSH)
  - Gusto mo ng mga linya ng log na JSON para sa tooling
title: "mga log"
---

# `openclaw logs`

I-tail ang mga file log ng Gateway sa pamamagitan ng RPC (gumagana sa remote mode).

Kaugnay:

- Pangkalahatang-ideya ng Logging: [Logging](/logging)

## Mga halimbawa

```bash
openclaw logs
openclaw logs --follow
openclaw logs --json
openclaw logs --limit 500
```
