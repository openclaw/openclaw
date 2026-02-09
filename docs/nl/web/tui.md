---
summary: "Terminal-UI (TUI): maak verbinding met de Gateway vanaf elke machine"
read_when:
  - Je wilt een beginnersvriendelijke walkthrough van de TUI
  - Je hebt de volledige lijst met TUI-functies, -opdrachten en -sneltoetsen nodig
title: "TUI"
---

# TUI (Terminal UI)

## Snelle start

1. Start de Gateway.

```bash
openclaw gateway
```

2. Open de TUI.

```bash
openclaw tui
```

3. Typ een bericht en druk op Enter.

Gateway op afstand:

```bash
openclaw tui --url ws://<host>:<port> --token <gateway-token>
```

Gebruik `--password` als je Gateway wachtwoordauthenticatie gebruikt.

## Wat je ziet

- Header: verbindings-URL, huidige agent, huidige sessie.
- Chatlog: gebruikersberichten, assistentantwoorden, systeemmeldingen, toolkaarten.
- Statusregel: verbindings-/runstatus (verbinden, actief, streamen, inactief, fout).
- Footer: verbindingsstatus + agent + sessie + model + denken/uitgebreid/redeneren + tokentellingen + deliver.
- Invoer: teksteditor met autocomplete.

## Mentaal model: agents + sessies

- Agents zijn unieke slugs (bijv. `main`, `research`). De Gateway stelt de lijst beschikbaar.
- Sessies horen bij de huidige agent.
- Sessiesleutels worden opgeslagen als `agent:<agentId>:<sessionKey>`.
  - Als je `/session main` typt, breidt de TUI dit uit naar `agent:<currentAgent>:main`.
  - Als je `/session agent:other:main` typt, schakel je expliciet naar die agentsessie.
- Sessie bereik:
  - `per-sender` (standaard): elke agent heeft meerdere sessies.
  - `global`: de TUI gebruikt altijd de `global`-sessie (de picker kan leeg zijn).
- De huidige agent + sessie zijn altijd zichtbaar in de footer.

## Verzenden + delivery

- Berichten worden naar de Gateway gestuurd; delivery naar providers staat standaard uit.
- Zet delivery aan:
  - `/deliver on`
  - of via het instellingenpaneel
  - of start met `openclaw tui --deliver`

## Pickers + overlays

- Modelpicker: lijst met beschikbare modellen en stel de sessie-override in.
- Agentpicker: kies een andere agent.
- Sessiepikker: toont alleen sessies voor de huidige agent.
- Instellingen: schakel deliver, uitbreiding van tooluitvoer en zichtbaarheid van denken in/uit.

## Sneltoetsen

- Enter: bericht verzenden
- Esc: actieve run afbreken
- Ctrl+C: invoer wissen (twee keer drukken om af te sluiten)
- Ctrl+D: afsluiten
- Ctrl+L: modelpicker
- Ctrl+G: agentpicker
- Ctrl+P: sessiepikker
- Ctrl+O: uitbreiding van tooluitvoer in/uit
- Ctrl+T: zichtbaarheid van denken in/uit (laadt geschiedenis opnieuw)

## Slash-opdrachten

Kern:

- `/help`
- `/status`
- `/agent <id>` (of `/agents`)
- `/session <key>` (of `/sessions`)
- `/model <provider/model>` (of `/models`)

Sessiebesturing:

- `/think <off|minimal|low|medium|high>`
- `/verbose <on|full|off>`
- `/reasoning <on|off|stream>`
- `/usage <off|tokens|full>`
- `/elevated <on|off|ask|full>` (alias: `/elev`)
- `/activation <mention|always>`
- `/deliver <on|off>`

Sessielevenclus:

- `/new` of `/reset` (reset de sessie)
- `/abort` (breek de actieve run af)
- `/settings`
- `/exit`

Andere Gateway slash-opdrachten (bijvoorbeeld `/context`) worden doorgestuurd naar de Gateway en als systeemuitvoer getoond. Zie [Slash-opdrachten](/tools/slash-commands).

## Lokale shell-opdrachten

- Prefix een regel met `!` om een lokale shell-opdracht uit te voeren op de TUI-host.
- De TUI vraagt per sessie één keer om lokale uitvoering toe te staan; weigeren houdt `!` voor de sessie uitgeschakeld.
- Opdrachten draaien in een frisse, niet-interactieve shell in de TUI-werkmap (geen persistente `cd`/env).
- Een losse `!` wordt als een normaal bericht verzonden; leidende spaties activeren geen lokale uitvoering.

## Tooluitvoer

- Toolaanroepen verschijnen als kaarten met args + resultaten.
- Ctrl+O schakelt tussen ingeklapte/uitgeklapte weergaven.
- Terwijl tools draaien, streamen gedeeltelijke updates in dezelfde kaart.

## Geschiedenis + streaming

- Bij verbinden laadt de TUI de meest recente geschiedenis (standaard 200 berichten).
- Streamingantwoorden werken ter plekke bij tot ze definitief zijn.
- De TUI luistert ook naar agent tool-events voor rijkere toolkaarten.

## Verbindingsdetails

- De TUI registreert zich bij de Gateway als `mode: "tui"`.
- Herverbindingen tonen een systeembericht; eventhiaten worden zichtbaar gemaakt in de log.

## Opties

- `--url <url>`: Gateway WebSocket-URL (standaard via config of `ws://127.0.0.1:<port>`)
- `--token <token>`: Gateway-token (indien vereist)
- `--password <password>`: Gateway-wachtwoord (indien vereist)
- `--session <key>`: Sessiesleutel (standaard: `main`, of `global` wanneer het bereik globaal is)
- `--deliver`: Lever assistentantwoorden af aan de provider (standaard uit)
- `--thinking <level>`: Denk-niveau voor verzendingen overschrijven
- `--timeout-ms <ms>`: Agent-time-out in ms (standaard `agents.defaults.timeoutSeconds`)

Let op: wanneer je `--url` instelt, valt de TUI niet terug op config- of omgevingscredentials.
Geef `--token` of `--password` expliciet door. Ontbrekende expliciete credentials is een fout.

## Problemen oplossen

Geen uitvoer na het verzenden van een bericht:

- Voer `/status` uit in de TUI om te bevestigen dat de Gateway verbonden en inactief/bezig is.
- Controleer de Gateway-logs: `openclaw logs --follow`.
- Bevestig dat de agent kan draaien: `openclaw status` en `openclaw models status`.
- Als je berichten in een chatkanaal verwacht, schakel delivery in (`/deliver on` of `--deliver`).
- `--history-limit <n>`: Aantal geschiedenisitems om te laden (standaard 200)

## Verbindingsproblemen oplossen

- `disconnected`: zorg dat de Gateway draait en je `--url/--token/--password` correct zijn.
- Geen agents in de picker: controleer `openclaw agents list` en je routeringsconfiguratie.
- Lege sessiepikker: je bevindt je mogelijk in globaal bereik of hebt nog geen sessies.
