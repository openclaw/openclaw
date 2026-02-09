---
summary: "CLI-referentie voor `openclaw configure` (interactieve configuratieprompts)"
read_when:
  - Je wilt referenties, apparaten of agent-standaardwaarden interactief aanpassen
title: "configure"
---

# `openclaw configure`

Interactieve prompt om referenties, apparaten en agent-standaardwaarden in te stellen.

Let op: De sectie **Model** bevat nu een multi-select voor de
`agents.defaults.models`-toegestane lijst (wat verschijnt in `/model` en in de modelkiezer).

Tip: `openclaw config` zonder subopdracht opent dezelfde wizard. Gebruik
`openclaw config get|set|unset` voor niet-interactieve bewerkingen.

Gerelateerd:

- Gateway-configuratiereferentie: [Configuration](/gateway/configuration)
- Config CLI: [Config](/cli/config)

Notities:

- Het kiezen waar de Gateway draait werkt altijd `gateway.mode` bij. Je kunt "Continue" selecteren zonder andere secties als dat alles is wat je nodig hebt.
- Kanaalgerichte diensten (Slack/Discord/Matrix/Microsoft Teams) vragen tijdens de installatie om toegestane lijsten voor kanalen/ruimtes. Je kunt namen of ID's invoeren; de wizard zet namen waar mogelijk om naar ID's.

## Voorbeelden

```bash
openclaw configure
openclaw configure --section models --section channels
```
