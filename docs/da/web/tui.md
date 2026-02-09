---
summary: "Terminal UI (TUI): forbind til Gateway fra enhver maskine"
read_when:
  - Du vil have en begyndervenlig gennemgang af TUI’en
  - Du har brug for den komplette liste over TUI-funktioner, kommandoer og genveje
title: "TUI"
---

# TUI (Terminal UI)

## Hurtig start

1. Start Gateway.

```bash
openclaw gateway
```

2. Åbn TUI’en.

```bash
openclaw tui
```

3. Skriv en besked, og tryk på Enter.

Fjern-Gateway:

```bash
openclaw tui --url ws://<host>:<port> --token <gateway-token>
```

Brug `--password`, hvis din Gateway bruger adgangskodegodkendelse.

## Det, du ser

- Header: forbindelses-URL, aktuel agent, aktuel session.
- Chatlog: brugerbeskeder, assistentsvar, systemmeddelelser, værktøjskort.
- Statuslinje: forbindelses-/kørselsstatus (forbinder, kører, streamer, inaktiv, fejl).
- Footer: forbindelsesstatus + agent + session + model + tænk/verbose/begrundelse + tokenantal + lever.
- Input: teksteditor med autocomplete.

## Mental model: agenter + sessioner

- Agenter er unikke snegle (fx `main`, `forskning`). Porten udsætter listen.
- Sessioner tilhører den aktuelle agent.
- Sessionsnøgler gemmes som `agent:<agentId>:<sessionKey>`.
  - Hvis du skriver `/session main`, udvider TUI’en det til `agent:<currentAgent>:main`.
  - Hvis du skriver `/session agent:other:main`, skifter du eksplicit til den agents session.
- Sessionsomfang:
  - `per-sender` (standard): hver agent har mange sessioner.
  - `global`: TUI’en bruger altid `global`-sessionen (vælgeren kan være tom).
- Den aktuelle agent + session er altid synlige i footeren.

## Afsendelse + levering

- Beskeder sendes til Gateway; levering til udbydere er slået fra som standard.
- Slå levering til:
  - `/deliver on`
  - eller Indstillingspanelet
  - eller start med `openclaw tui --deliver`

## Vælgere + overlays

- Modelvælger: vis tilgængelige modeller, og sæt sessionsoverride.
- Agentvælger: vælg en anden agent.
- Sessionsvælger: viser kun sessioner for den aktuelle agent.
- Indstillinger: slå levering til/fra, udvidelse af værktøjsoutput og synlighed af tænkning.

## Tastaturgenveje

- Enter: send besked
- Esc: afbryd aktiv kørsel
- Ctrl+C: ryd input (tryk to gange for at afslutte)
- Ctrl+D: afslut
- Ctrl+L: modelvælger
- Ctrl+G: agentvælger
- Ctrl+P: sessionsvælger
- Ctrl+O: slå udvidelse af værktøjsoutput til/fra
- Ctrl+T: slå synlighed af tænkning til/fra (genindlæser historik)

## Slash-kommandoer

Kerne:

- `/help`
- `/status`
- `/agent <id>` (eller `/agents`)
- `/session <key>` (eller `/sessions`)
- `/model <provider/model>` (eller `/models`)

Sessionskontroller:

- `/think <off|minimal|low|medium|high>`
- `/verbose <on|full|off>`
- `/reasoning <on|off|stream>`
- `/usage <off|tokens|full>`
- `/elevated <on|off|ask|full>` (alias: `/elev`)
- `/activation <mention|always>`
- `/deliver <on|off>`

Sessionslivscyklus:

- `/new` eller `/reset` (nulstil sessionen)
- `/abort` (afbryd den aktive kørsel)
- `/settings`
- `/exit`

Andre Gateway skråstregkommandoer (f.eks. `/context`) videresendes til Gateway og vises som systemoutput. Se [Slash kommandoer](/tools/slash-commands).

## Lokale shell-kommandoer

- Præfiksér en linje med `!` for at køre en lokal shell-kommando på TUI-værten.
- TUI’en spørger én gang pr. session om tilladelse til lokal eksekvering; afviser du, forbliver `!` deaktiveret for sessionen.
- Kommandoer køres i en frisk, ikke-interaktiv shell i TUI’ens arbejdsmappe (ingen vedvarende `cd`/env).
- Et enkelt `!` sendes som en normal besked; indledende mellemrum udløser ikke lokal eksekvering.

## Værktøjsoutput

- Værktøjskald vises som kort med argumenter + resultater.
- Ctrl+O skifter mellem sammenklappet/udvidet visning.
- Mens værktøjer kører, streames delvise opdateringer ind i det samme kort.

## Historik + streaming

- Ved forbindelse indlæser TUI’en den seneste historik (standard 200 beskeder).
- Streamede svar opdateres på stedet, indtil de færdiggøres.
- TUI’en lytter også til agentens værktøjshændelser for rigere værktøjskort.

## Forbindelsesdetaljer

- TUI’en registrerer sig hos Gateway som `mode: "tui"`.
- Genforbindelser viser en systemmeddelelse; hændelsesgab fremhæves i loggen.

## Indstillinger

- `--url <url>`: Gateway WebSocket-URL (standard er konfigurationen eller `ws://127.0.0.1:<port>`)
- `--token <token>`: Gateway-token (hvis påkrævet)
- `--password <password>`: Gateway-adgangskode (hvis påkrævet)
- `--session <key>`: Sessionsnøgle (standard: `main` eller `global`, når omfanget er globalt)
- `--deliver`: Lever assistentsvar til udbyderen (standard: fra)
- `--thinking <level>`: Tilsidesæt tænkeniveau for afsendelser
- `--timeout-ms <ms>`: Agent-timeout i ms (standard er `agents.defaults.timeoutSeconds`)

Bemærk: Når du angiver `--url`, falder TUI ikke tilbage til config eller miljø legitimationsoplysninger.
Pass `--token` eller `--password` eksplicitt. Manglende eksplicitte legitimationsoplysninger er en fejl.

## Fejlfinding

Intet output efter afsendelse af en besked:

- Kør `/status` i TUI’en for at bekræfte, at Gateway er forbundet og inaktiv/optaget.
- Tjek Gateway-loggene: `openclaw logs --follow`.
- Bekræft at agenten kan køre: `openclaw status` og `openclaw models status`.
- Hvis du forventer beskeder i en chatkanal, så aktivér levering (`/deliver on` eller `--deliver`).
- `--history-limit <n>`: Antal historikposter, der indlæses (standard 200)

## Forbindelsesfejlfinding

- `disconnected`: sørg for, at Gateway kører, og at dine `--url/--token/--password` er korrekte.
- Ingen agenter i vælgeren: tjek `openclaw agents list` og din routing-konfiguration.
- Tom sessionsvælger: du er muligvis i globalt omfang eller har endnu ingen sessioner.
