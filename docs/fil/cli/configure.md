---
summary: "Sanggunian ng CLI para sa `openclaw configure` (mga interactive na prompt sa configuration)"
read_when:
  - Gusto mong ayusin ang mga kredensyal, device, o mga default ng agent nang interactive
title: "configure"
---

# `openclaw configure`

Interactive na prompt para mag-set up ng mga kredensyal, device, at mga default ng agent.

Tandaan: Ang seksyong **Model** ay may kasama na ngayong multi-select para sa
allowlist na `agents.defaults.models` (kung ano ang lumalabas sa `/model` at sa model picker).

44. Tip: ang `openclaw config` nang walang subcommand ay nagbubukas ng parehong wizard. 45. Gamitin
    `openclaw config get|set|unset` para sa mga hindi interactive na pag-edit.

Kaugnay:

- Sanggunian sa configuration ng Gateway: [Configuration](/gateway/configuration)
- Config CLI: [Config](/cli/config)

Mga tala:

- 46. Ang pagpili kung saan tatakbo ang Gateway ay palaging nag-a-update ng `gateway.mode`. 47. Maaari mong piliin ang "Continue" nang walang ibang seksyon kung iyon lang ang kailangan mo.
- 48. Ang mga channel-oriented na serbisyo (Slack/Discord/Matrix/Microsoft Teams) ay humihingi ng mga channel/room allowlist habang nagse-setup. 49. Maaari kang maglagay ng mga pangalan o ID; nireresolba ng wizard ang mga pangalan patungo sa mga ID kapag posible.

## Mga halimbawa

```bash
openclaw configure
openclaw configure --section models --section channels
```
