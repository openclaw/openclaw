---
summary: "CLI-referens för `openclaw configure` (interaktiva konfigurationsfrågor)"
read_when:
  - Du vill justera autentiseringsuppgifter, enheter eller agentstandarder interaktivt
title: "konfigurera"
---

# `openclaw configure`

Interaktiv prompt för att konfigurera autentiseringsuppgifter, enheter och agentstandarder.

Obs: Avsnittet **Model** innehåller nu ett flerval för
`agents.defaults.models`-tillåtelselistan (vad som visas i `/model` och i modellväljaren).

Tips: `openclaw config` utan ett underkommando öppnar samma trollkarl. Använd
`openclaw config get<unk> set<unk> unset` för icke-interaktiva redigeringar.

Relaterat:

- Referens för Gateway-konfiguration: [Configuration](/gateway/configuration)
- Konfig-CLI: [Config](/cli/config)

Noteringar:

- Välja var Gateway körs uppdaterar alltid `gateway.mode`. Du kan välja "Fortsätt" utan andra sektioner om det är allt du behöver.
- Kanalorienterade tjänster (Slut/Discord/Matrix/Microsoft Teams) prompt för kanal/rum allowlists under installationen. Du kan ange namn eller ID; guiden löser namn till ID när det är möjligt.

## Exempel

```bash
openclaw configure
openclaw configure --section models --section channels
```
