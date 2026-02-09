---
summary: "Contextvenster + compaction: hoe OpenClaw sessies binnen modelgrenzen houdt"
read_when:
  - Je wilt auto-compaction en /compact begrijpen
  - Je debugt lange sessies die contextlimieten bereiken
title: "Compaction"
---

# Contextvenster & Compaction

Elk model heeft een **contextvenster** (maximaal aantal tokens dat het kan zien). Langlopende chats stapelen berichten en toolresultaten op; zodra het venster krap wordt, **compacteert** OpenClaw oudere geschiedenis om binnen de limieten te blijven.

## Wat compaction is

Compaction **vat oudere gesprekken samen** tot één compacte samenvattingsvermelding en laat recente berichten intact. De samenvatting wordt opgeslagen in de sessiegeschiedenis, zodat toekomstige verzoeken gebruiken:

- De compaction-samenvatting
- Recente berichten na het compaction-punt

Compaction **blijft behouden** in de JSONL-geschiedenis van de sessie.

## Configuratie

Zie [Compaction config & modes](/concepts/compaction) voor de `agents.defaults.compaction`-instellingen.

## Auto-compaction (standaard aan)

Wanneer een sessie het contextvenster van het model nadert of overschrijdt, activeert OpenClaw auto-compaction en kan het het oorspronkelijke verzoek opnieuw proberen met de gecompacteerde context.

Je ziet:

- `🧹 Auto-compaction complete` in verbose-modus
- `/status` met `🧹 Compactions: <count>`

Vóór compaction kan OpenClaw een **stille memory flush**-beurt uitvoeren om
duurzame notities naar schijf te schrijven. Zie [Memory](/concepts/memory) voor details en configuratie.

## Handmatige compaction

Gebruik `/compact` (optioneel met instructies) om een compaction-pass te forceren:

```
/compact Focus on decisions and open questions
```

## Bron van het contextvenster

Het contextvenster is modelspecifiek. OpenClaw gebruikt de modeldefinitie uit de geconfigureerde provider-catalogus om limieten te bepalen.

## Compaction vs. pruning

- **Compaction**: vat samen en **blijft behouden** in JSONL.
- **Session pruning**: snoeit alleen oude **toolresultaten**, **in-memory**, per verzoek.

Zie [/concepts/session-pruning](/concepts/session-pruning) voor details over pruning.

## Tips

- Gebruik `/compact` wanneer sessies muf aanvoelen of de context opgeblazen is.
- Grote tooluitvoer wordt al afgekapt; pruning kan de opstapeling van toolresultaten verder verminderen.
- Als je een schone lei nodig hebt, starten `/new` of `/reset` een nieuwe sessie-id.
