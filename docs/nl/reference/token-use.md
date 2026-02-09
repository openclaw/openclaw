---
summary: "Hoe OpenClaw promptcontext opbouwt en tokengebruik + kosten rapporteert"
read_when:
  - Uitleggen van tokengebruik, kosten of contextvensters
  - Debuggen van contextgroei of compactiegedrag
title: "Tokengebruik en kosten"
---

# Tokengebruik & kosten

OpenClaw houdt **tokens** bij, geen tekens. Tokens zijn modelspecifiek, maar de meeste
OpenAI-achtige modellen komen gemiddeld uit op ~4 tekens per token voor Engelse tekst.

## Hoe de system prompt wordt opgebouwd

OpenClaw stelt bij elke run zijn eigen system prompt samen. Deze bevat:

- Toollijst + korte beschrijvingen
- Skills-lijst (alleen metadata; instructies worden on demand geladen met `read`)
- Zelfupdate-instructies
- Werkruimte + bootstrapbestanden (`AGENTS.md`, `SOUL.md`, `TOOLS.md`, `IDENTITY.md`, `USER.md`, `HEARTBEAT.md`, `BOOTSTRAP.md` wanneer nieuw). Grote bestanden worden afgekapt door `agents.defaults.bootstrapMaxChars` (standaard: 20000).
- Tijd (UTC + tijdzone van de gebruiker)
- Antwoordtags + heartbeat-gedrag
- Runtime-metadata (host/OS/model/thinking)

Bekijk de volledige uitsplitsing in [System Prompt](/concepts/system-prompt).

## Wat meetelt in het contextvenster

Alles wat het model ontvangt telt mee voor de contextlimiet:

- System prompt (alle hierboven vermelde secties)
- Gespreksgeschiedenis (berichten van gebruiker + assistent)
- Tool-aanroepen en toolresultaten
- Bijlagen/transcripten (afbeeldingen, audio, bestanden)
- Compactiesamenvattingen en pruning-artefacten
- Provider-wrappers of veiligheidsheaders (niet zichtbaar, maar wel meegeteld)

Voor een praktische uitsplitsing (per geïnjecteerd bestand, tools, skills en grootte van de system prompt) gebruik je `/context list` of `/context detail`. Zie [Context](/concepts/context).

## Hoe je het huidige tokengebruik ziet

Gebruik deze in de chat:

- `/status` → **emoji‑rijke statuskaart** met het sessiemodel, contextgebruik,
  input-/outputtokens van het laatste antwoord en **geschatte kosten** (alleen API-sleutel).
- `/usage off|tokens|full` → voegt een **per-antwoord gebruiksfooter** toe aan elk antwoord.
  - Blijft per sessie behouden (opgeslagen als `responseUsage`).
  - OAuth-authenticatie **verbergt kosten** (alleen tokens).
- `/usage cost` → toont een lokaal kostenoverzicht uit OpenClaw-sessielogs.

Andere oppervlakken:

- **TUI/Web TUI:** `/status` + `/usage` worden ondersteund.
- **CLI:** `openclaw status --usage` en `openclaw channels list` tonen
  provider-quotavensters (geen kosten per antwoord).

## Kostenraming (wanneer getoond)

Kosten worden geschat op basis van je modelprijsconfiguratie:

```
models.providers.<provider>.models[].cost
```

Dit zijn **USD per 1M tokens** voor `input`, `output`, `cacheRead` en
`cacheWrite`. Als prijzen ontbreken, toont OpenClaw alleen tokens. OAuth-tokens
tonen nooit dollarkosten.

## Cache-TTL en impact van pruning

Provider-promptcaching is alleen van toepassing binnen het cache-TTL-venster. OpenClaw kan
optioneel **cache-ttl-pruning** uitvoeren: het prunt de sessie zodra de cache-TTL
is verlopen en reset daarna het cachevenster zodat volgende verzoeken de
vers gecachte context opnieuw kunnen gebruiken in plaats van de volledige
geschiedenis opnieuw te cachen. Dit houdt cache-schrijvingskosten lager wanneer
een sessie langer dan de TTL inactief is.

Configureer dit in [Gateway configuration](/gateway/configuration) en bekijk de
gedragsdetails in [Session pruning](/concepts/session-pruning).

Heartbeat kan de cache **warm** houden over inactieve perioden heen. Als de cache-TTL
van je model `1h` is, kan het instellen van het heartbeat-interval net
daaronder (bijv. `55m`) voorkomen dat de volledige prompt opnieuw moet
worden gecachet, wat cache-schrijvingskosten vermindert.

Voor Anthropic API-prijzen zijn cachereads aanzienlijk goedkoper dan inputtokens,
terwijl cachewrites tegen een hogere vermenigvuldiger worden gefactureerd. Zie
Anthropic’s promptcaching-prijzen voor de nieuwste tarieven en TTL-vermenigvuldigers:
[https://docs.anthropic.com/docs/build-with-claude/prompt-caching](https://docs.anthropic.com/docs/build-with-claude/prompt-caching)

### Voorbeeld: 1u cache warm houden met heartbeat

```yaml
agents:
  defaults:
    model:
      primary: "anthropic/claude-opus-4-6"
    models:
      "anthropic/claude-opus-4-6":
        params:
          cacheRetention: "long"
    heartbeat:
      every: "55m"
```

## Tips om tokendruk te verminderen

- Gebruik `/compact` om lange sessies samen te vatten.
- Trim grote tooluitvoer in je workflows.
- Houd skillbeschrijvingen kort (de skills-lijst wordt in de prompt geïnjecteerd).
- Geef de voorkeur aan kleinere modellen voor uitgebreide, verkennende werkzaamheden.

Zie [Skills](/tools/skills) voor de exacte formule van de skilllijst-overhead.
