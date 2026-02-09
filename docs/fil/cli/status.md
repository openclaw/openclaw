---
summary: "Reference ng CLI para sa `openclaw status` (diagnostics, probes, mga snapshot ng paggamit)"
read_when:
  - Gusto mo ng mabilis na diagnosis ng kalusugan ng channel + mga kamakailang recipient ng session
  - Gusto mo ng isang pasteable na “all” status para sa debugging
title: "status"
---

# `openclaw status`

Diagnostics para sa mga channel + session.

```bash
openclaw status
openclaw status --all
openclaw status --deep
openclaw status --usage
```

Mga tala:

- Ang `--deep` ay nagpapatakbo ng mga live probe (WhatsApp Web + Telegram + Discord + Google Chat + Slack + Signal).
- Kasama sa output ang mga per-agent na session store kapag maraming agent ang naka-configure.
- Kasama sa Overview ang Gateway + status ng pag-install/pagpapatakbo ng serbisyo ng host ng node kapag available.
- Kasama sa Overview ang update channel + git SHA (para sa mga source checkout).
- Lumalabas ang impormasyon ng update sa Overview; kung may available na update, magpi-print ang status ng pahiwatig para patakbuhin ang `openclaw update` (tingnan ang [Updating](/install/updating)).
