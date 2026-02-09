---
summary: "Sanggunian ng CLI para sa `openclaw config` (get/set/unset ng mga value ng config)"
read_when:
  - Gusto mong basahin o i-edit ang config nang hindi interactive
title: "config"
---

# `openclaw config`

40. Mga config helper: kunin/itakda/i-unset ang mga value ayon sa path. 41. Patakbuhin nang walang subcommand upang buksan
    ang configure wizard (pareho sa `openclaw configure`).

## Mga halimbawa

```bash
openclaw config get browser.executablePath
openclaw config set browser.executablePath "/usr/bin/google-chrome"
openclaw config set agents.defaults.heartbeat.every "2h"
openclaw config set agents.list[0].tools.exec.node "node-id-or-name"
openclaw config unset tools.web.search.apiKey
```

## Mga path

Gumagamit ang mga path ng dot o bracket notation:

```bash
openclaw config get agents.defaults.workspace
openclaw config get agents.list[0].id
```

Gamitin ang index ng listahan ng agent para i-target ang isang partikular na agent:

```bash
openclaw config get agents.list
openclaw config set agents.list[1].tools.exec.node "node-id-or-name"
```

## Mga value

42. Ang mga value ay bina-parse bilang JSON5 kapag posible; kung hindi, itinuturing silang mga string.
43. Gamitin ang `--json` upang i-require ang JSON5 parsing.

```bash
openclaw config set agents.defaults.heartbeat.every "0m"
openclaw config set gateway.port 19001 --json
openclaw config set channels.whatsapp.groups '["*"]' --json
```

I-restart ang Gateway pagkatapos ng mga pag-edit.
