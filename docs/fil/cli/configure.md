---
summary: "Sanggunian ng CLI para sa `openclaw configure` (mga interactive na prompt sa configuration)"
read_when:
  - Gusto mong ayusin ang mga kredensyal, device, o mga default ng agent nang interactive
title: "configure"
x-i18n:
  source_path: cli/configure.md
  source_hash: 9cb2bb5237b02b3a
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:45:16Z
---

# `openclaw configure`

Interactive na prompt para mag-set up ng mga kredensyal, device, at mga default ng agent.

Tandaan: Ang seksyong **Model** ay may kasama na ngayong multi-select para sa
allowlist na `agents.defaults.models` (kung ano ang lumalabas sa `/model` at sa model picker).

Tip: Ang `openclaw config` na walang subcommand ay nagbubukas ng parehong wizard. Gamitin ang
`openclaw config get|set|unset` para sa mga non-interactive na pag-edit.

Kaugnay:

- Sanggunian sa configuration ng Gateway: [Configuration](/gateway/configuration)
- Config CLI: [Config](/cli/config)

Mga tala:

- Ang pagpili kung saan tatakbo ang Gateway ay palaging nag-a-update ng `gateway.mode`. Maaari mong piliin ang "Continue" nang walang ibang seksyon kung iyon lang ang kailangan mo.
- Ang mga channel-oriented na serbisyo (Slack/Discord/Matrix/Microsoft Teams) ay hihingi ng mga allowlist ng channel/room habang nagse-setup. Maaari kang maglagay ng mga pangalan o ID; nireresolba ng wizard ang mga pangalan tungo sa mga ID kapag posible.

## Mga halimbawa

```bash
openclaw configure
openclaw configure --section models --section channels
```
