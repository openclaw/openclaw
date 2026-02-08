---
summary: "CLI-referens för `openclaw configure` (interaktiva konfigurationsfrågor)"
read_when:
  - Du vill justera autentiseringsuppgifter, enheter eller agentstandarder interaktivt
title: "konfigurera"
x-i18n:
  source_path: cli/configure.md
  source_hash: 9cb2bb5237b02b3a
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T08:16:37Z
---

# `openclaw configure`

Interaktiv prompt för att konfigurera autentiseringsuppgifter, enheter och agentstandarder.

Obs: Avsnittet **Model** innehåller nu ett flerval för
`agents.defaults.models`-tillåtelselistan (vad som visas i `/model` och i modellväljaren).

Tips: `openclaw config` utan underkommando öppnar samma guide. Använd
`openclaw config get|set|unset` för icke-interaktiva ändringar.

Relaterat:

- Referens för Gateway-konfiguration: [Configuration](/gateway/configuration)
- Konfig-CLI: [Config](/cli/config)

Noteringar:

- Att välja var Gateway körs uppdaterar alltid `gateway.mode`. Du kan välja ”Continue” utan andra avsnitt om det är allt du behöver.
- Kanalorienterade tjänster (Slack/Discord/Matrix/Microsoft Teams) frågar efter tillåtelselistor för kanaler/rum under konfigureringen. Du kan ange namn eller ID:n; guiden löser namn till ID:n när det är möjligt.

## Exempel

```bash
openclaw configure
openclaw configure --section models --section channels
```
