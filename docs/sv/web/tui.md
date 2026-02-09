---
summary: "Terminal-UI (TUI): anslut till Gateway från vilken maskin som helst"
read_when:
  - Du vill ha en nybörjarvänlig genomgång av TUI
  - Du behöver den kompletta listan över TUI-funktioner, kommandon och genvägar
title: "TUI"
---

# TUI (Terminal-UI)

## Snabbstart

1. Starta Gateway.

```bash
openclaw gateway
```

2. Öppna TUI.

```bash
openclaw tui
```

3. Skriv ett meddelande och tryck Enter.

Fjärr-Gateway:

```bash
openclaw tui --url ws://<host>:<port> --token <gateway-token>
```

Använd `--password` om din Gateway använder lösenordsautentisering.

## Vad du ser

- Sidhuvud: anslutnings-URL, aktuell agent, aktuell session.
- Chattlogg: användarmeddelanden, assistentsvar, systemmeddelanden, verktygskort.
- Statusrad: anslutnings-/körstatus (ansluter, kör, strömmar, inaktiv, fel).
- Sidfot: anslutningsstatus + agent + session + modell + think/verbose/reasoning + tokenantal + leverans.
- Inmatning: textredigerare med autokomplettering.

## Mental modell: agenter + sessioner

- Agenter är unika sniglar (t.ex. `main`, `research`). Gateway exponerar listan.
- Sessioner tillhör den aktuella agenten.
- Sessionsnycklar lagras som `agent:<agentId>:<sessionKey>`.
  - Om du skriver `/session main` expanderar TUI det till `agent:<currentAgent>:main`.
  - Om du skriver `/session agent:other:main` växlar du uttryckligen till den agentsessionen.
- Sessionsomfång:
  - `per-sender` (standard): varje agent har många sessioner.
  - `global`: TUI använder alltid sessionen `global` (väljaren kan vara tom).
- Aktuell agent + session visas alltid i sidfoten.

## Skicka + leverans

- Meddelanden skickas till Gateway; leverans till leverantörer är avstängd som standard.
- Slå på leverans:
  - `/deliver on`
  - eller panelen Inställningar
  - eller starta med `openclaw tui --deliver`

## Väljare + överlägg

- Modellväljare: listar tillgängliga modeller och sätter sessionsöverskrivning.
- Agentväljare: välj en annan agent.
- Sessionsväljare: visar endast sessioner för den aktuella agenten.
- Inställningar: växla leverans, expansion av verktygsutdata och synlighet för tänkande.

## Tangentbordsgenvägar

- Enter: skicka meddelande
- Esc: avbryt aktiv körning
- Ctrl+C: rensa inmatning (tryck två gånger för att avsluta)
- Ctrl+D: avsluta
- Ctrl+L: modellväljare
- Ctrl+G: agentväljare
- Ctrl+P: sessionsväljare
- Ctrl+O: växla expansion av verktygsutdata
- Ctrl+T: växla synlighet för tänkande (läser in historik igen)

## Slash-kommandon

Kärna:

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

Sessionslivscykel:

- `/new` eller `/reset` (återställ sessionen)
- `/abort` (avbryt den aktiva körningen)
- `/settings`
- `/exit`

Andra snedstreckskommandon (till exempel `/context`) vidarebefordras till Gateway och visas som systemutgång. Se [Slash kommandon](/tools/slash-commands).

## Lokala skal-kommandon

- Prefixa en rad med `!` för att köra ett lokalt skal-kommando på TUI-värden.
- TUI frågar en gång per session om att tillåta lokal exekvering; om du nekar hålls `!` inaktiverat för sessionen.
- Kommandon körs i ett nytt, icke-interaktivt skal i TUI:s arbetskatalog (ingen bestående `cd`/env).
- Ett ensamt `!` skickas som ett vanligt meddelande; inledande mellanslag triggar inte lokal exekvering.

## Verktygsutdata

- Verktygsanrop visas som kort med argument + resultat.
- Ctrl+O växlar mellan hopfällda/expanderade vyer.
- Medan verktyg körs strömmas partiella uppdateringar in i samma kort.

## Historik + strömning

- Vid anslutning läser TUI in den senaste historiken (standard 200 meddelanden).
- Strömmande svar uppdateras på plats tills de slutförs.
- TUI lyssnar även på agentens verktygshändelser för rikare verktygskort.

## Anslutningsdetaljer

- TUI registrerar sig hos Gateway som `mode: "tui"`.
- Återanslutningar visar ett systemmeddelande; händelseglapp exponeras i loggen.

## Alternativ

- `--url <url>`: Gateway WebSocket-URL (standard enligt konfig eller `ws://127.0.0.1:<port>`)
- `--token <token>`: Gateway-token (om krävs)
- `--password <password>`: Gateway-lösenord (om krävs)
- `--session <key>`: Sessionsnyckel (standard: `main`, eller `global` när omfånget är globalt)
- `--deliver`: Leverera assistentsvar till leverantören (standard av)
- `--thinking <level>`: Åsidosätt tänkenivå för sändningar
- `--timeout-ms <ms>`: Agent-timeout i ms (standard `agents.defaults.timeoutSeconds`)

Obs: När du anger `--url`, faller TUI inte tillbaka till config eller miljö uppgifter.
Passera `--token` eller` --lösenord` explicit. Saknar explicita referenser är ett fel.

## Felsökning

Ingen utdata efter att ha skickat ett meddelande:

- Kör `/status` i TUI för att bekräfta att Gateway är ansluten och inaktiv/upptagen.
- Kontrollera Gateway-loggarna: `openclaw logs --follow`.
- Bekräfta att agenten kan köra: `openclaw status` och `openclaw models status`.
- Om du förväntar dig meddelanden i en chattkanal, aktivera leverans (`/deliver on` eller `--deliver`).
- `--history-limit <n>`: Historikposter att läsa in (standard 200)

## Felsökning av anslutning

- `disconnected`: säkerställ att Gateway körs och att dina `--url/--token/--password` är korrekta.
- Inga agenter i väljaren: kontrollera `openclaw agents list` och din routningskonfig.
- Tom sessionsväljare: du kan vara i globalt omfång eller sakna sessioner ännu.
