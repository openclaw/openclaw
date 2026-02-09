---
summary: "Ontwerp van een opdrachtwachtrij die inkomende auto-reply-runs serialiseert"
read_when:
  - Bij het wijzigen van auto-reply-uitvoering of gelijktijdigheid
title: "Opdracht wachtrij"
---

# Opdrachtwachtrij (2026-01-16)

We serialiseren inkomende auto-reply-runs (alle kanalen) via een kleine in-process wachtrij om te voorkomen dat meerdere agent-runs met elkaar botsen, terwijl veilige paralleliteit over sessies heen mogelijk blijft.

## Waarom

- Auto-reply-runs kunnen duur zijn (LLM-aanroepen) en kunnen botsen wanneer meerdere inkomende berichten kort na elkaar binnenkomen.
- Serialiseren voorkomt concurrentie om gedeelde resources (sessiebestanden, logs, CLI stdin) en verkleint de kans op upstream rate limits.

## Hoe het werkt

- Een lane-bewuste FIFO-wachtrij verwerkt elke lane met een configureerbare gelijktijdigheidslimiet (standaard 1 voor niet-geconfigureerde lanes; main standaard 4, subagent 8).
- `runEmbeddedPiAgent` plaatst in de wachtrij op **sessiesleutel** (lane `session:<key>`) om te garanderen dat er slechts één actieve run per sessie is.
- Elke sessierun wordt vervolgens in een **globale lane** geplaatst (`main` standaard), zodat de totale paralleliteit wordt begrensd door `agents.defaults.maxConcurrent`.
- Wanneer uitgebreide logging is ingeschakeld, geven runs in de wachtrij een korte melding als ze langer dan ~2s hebben gewacht voordat ze starten.
- Typindicatoren worden nog steeds direct geactiveerd bij het enqueuen (wanneer ondersteund door het kanaal), zodat de gebruikerservaring ongewijzigd blijft terwijl we wachten.

## Wachtrijmodi (per kanaal)

Inkomende berichten kunnen de huidige run sturen, wachten op een vervolgrond, of beide:

- `steer`: injecteer direct in de huidige run (annuleert lopende tool-aanroepen na de volgende toolgrens). Valt terug op followup als er niet wordt gestreamd.
- `followup`: plaats in de wachtrij voor de volgende agentbeurt nadat de huidige run eindigt.
- `collect`: voeg alle berichten in de wachtrij samen tot **één** vervolgrond (standaard). Als berichten verschillende kanalen/threads targeten, worden ze afzonderlijk verwerkt om routering te behouden.
- `steer-backlog` (ook bekend als `steer+backlog`): stuur nu **en** behoud het bericht voor een vervolgrond.
- `interrupt` (legacy): breek de actieve run voor die sessie af en voer vervolgens het nieuwste bericht uit.
- `queue` (legacy-alias): hetzelfde als `steer`.

Steer-backlog betekent dat je na de gestuurde run een vervolgrespons kunt krijgen, waardoor
streaming-oppervlakken er als duplicaten uit kunnen zien. Geef de voorkeur aan `collect`/`steer` als je
één respons per inkomend bericht wilt.
Verstuur `/queue collect` als een zelfstandige opdracht (per sessie) of stel `messages.queue.byChannel.discord: "collect"` in.

Standaarden (wanneer niet ingesteld in de config):

- Alle surfaces → `collect`

Configureer globaal of per kanaal via `messages.queue`:

```json5
{
  messages: {
    queue: {
      mode: "collect",
      debounceMs: 1000,
      cap: 20,
      drop: "summarize",
      byChannel: { discord: "collect" },
    },
  },
}
```

## Wachtrij-opties

Opties zijn van toepassing op `followup`, `collect` en `steer-backlog` (en op `steer` wanneer deze terugvalt op followup):

- `debounceMs`: wacht op stilte voordat een vervolgrond start (voorkomt “ga door, ga door”).
- `cap`: maximaal aantal berichten in de wachtrij per sessie.
- `drop`: overflowbeleid (`old`, `new`, `summarize`).

Samenvatten bewaart een korte opsomming van gedropte berichten en injecteert deze als een synthetische followup-prompt.
Standaarden: `debounceMs: 1000`, `cap: 20`, `drop: summarize`.

## Per-sessie overrides

- Verstuur `/queue <mode>` als een zelfstandige opdracht om de modus voor de huidige sessie op te slaan.
- Opties kunnen worden gecombineerd: `/queue collect debounce:2s cap:25 drop:summarize`
- `/queue default` of `/queue reset` wist de sessie-override.

## Reikwijdte en garanties

- Van toepassing op auto-reply agent-runs over alle inkomende kanalen die de gateway reply-pipeline gebruiken (WhatsApp web, Telegram, Slack, Discord, Signal, iMessage, webchat, enz.).
- De standaardlane (`main`) is procesbreed voor inbound + main heartbeats; stel `agents.defaults.maxConcurrent` in om meerdere sessies parallel toe te staan.
- Extra lanes kunnen bestaan (bijv. `cron`, `subagent`) zodat achtergrondtaken parallel kunnen draaien zonder inkomende replies te blokkeren.
- Per-sessielanes garanderen dat slechts één agent-run tegelijk een bepaalde sessie aanraakt.
- Geen externe afhankelijkheden of achtergrond-workerthreads; pure TypeScript + promises.

## Problemen oplossen

- Als opdrachten vast lijken te zitten, schakel uitgebreide logs in en zoek naar regels “queued for …ms” om te bevestigen dat de wachtrij wordt verwerkt.
- Als je wachtrijdiepte nodig hebt, schakel uitgebreide logs in en let op wachtrijtijdregels.
