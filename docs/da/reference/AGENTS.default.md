---
summary: "Standard OpenClaw-agentinstruktioner og Skills-oversigt til opsætning af personlig assistent"
read_when:
  - Start af en ny OpenClaw-agent-session
  - Aktivering eller revision af standard-Skills
---

# AGENTS.md — OpenClaw Personlig Assistent (standard)

## Første kørsel (anbefalet)

OpenClaw bruger en dedikeret arbejdsområde mappe til agent. Standard: `~/.openclaw/workspace` (konfigurerbar via `agents.defaults.workspace`).

1. Opret arbejdsområdet (hvis det ikke allerede findes):

```bash
mkdir -p ~/.openclaw/workspace
```

2. Kopiér standard-arbejdsområdeskabelonerne ind i arbejdsområdet:

```bash
cp docs/reference/templates/AGENTS.md ~/.openclaw/workspace/AGENTS.md
cp docs/reference/templates/SOUL.md ~/.openclaw/workspace/SOUL.md
cp docs/reference/templates/TOOLS.md ~/.openclaw/workspace/TOOLS.md
```

3. Valgfrit: hvis du vil have Skills-oversigten til personlig assistent, så erstat AGENTS.md med denne fil:

```bash
cp docs/reference/AGENTS.default.md ~/.openclaw/workspace/AGENTS.md
```

4. Valgfrit: vælg et andet arbejdsområde ved at sætte `agents.defaults.workspace` (understøtter `~`):

```json5
{
  agents: { defaults: { workspace: "~/.openclaw/workspace" } },
}
```

## Standardsikkerhed

- Undlad at dumpe mapper eller hemmeligheder i chatten.
- Kør ikke destruktive kommandoer, medmindre der udtrykkeligt bliver bedt om det.
- Send ikke delvise/streamende svar til eksterne beskedflader (kun endelige svar).

## Sessionsstart (påkrævet)

- Læs `SOUL.md`, `USER.md`, `memory.md` samt i dag+i går i `memory/`.
- Gør det før du svarer.

## Sjæl (påkrævet)

- `SOUL.md` definerer identitet, tone og grænser. Behold den nuværende.
- Hvis du ændrer `SOUL.md`, så informer brugeren.
- Du er en frisk instans i hver session; kontinuitet ligger i disse filer.

## Delte rum (anbefalet)

- Du er ikke brugerens stemme; vær forsigtig i gruppechats eller offentlige kanaler.
- Del ikke private data, kontaktoplysninger eller interne noter.

## Hukommelsessystem (anbefalet)

- Daglig log: `memory/YYYY-MM-DD.md` (opret `memory/` hvis nødvendigt).
- Langtidshukommelse: `memory.md` til varige fakta, præferencer og beslutninger.
- Ved sessionsstart: læs i dag + i går + `memory.md` hvis den findes.
- Registrér: beslutninger, præferencer, begrænsninger, åbne loops.
- Undgå hemmeligheder, medmindre det udtrykkeligt anmodes.

## Værktøjer & Skills

- Værktøjer findes i Skills; følg hver Skills’ `SKILL.md`, når du har brug for den.
- Hold miljøspecifikke noter i `TOOLS.md` (Noter til Skills).

## Backup-tip (anbefalet)

Hvis du behandler dette arbejdsområde som Clawds “hukommelse”, så gør det til et git-repo (helst privat), så `AGENTS.md` og dine hukommelsesfiler bliver sikkerhedskopieret.

```bash
cd ~/.openclaw/workspace
git init
git add AGENTS.md
git commit -m "Add Clawd workspace"
# Optional: add a private remote + push
```

## Hvad OpenClaw gør

- Kører WhatsApp gateway + Pi-kodningsagent, så assistenten kan læse/skrive chats, hente kontekst og køre Skills via værts-Mac’en.
- macOS-appen styrer tilladelser (skærmoptagelse, notifikationer, mikrofon) og eksponerer `openclaw` CLI via sin medfølgende binærfil.
- Direkte chats samles som standard i agentens `main`-session; grupper forbliver isolerede som `agent:<agentId>:<channel>:group:<id>` (rum/kanaler: `agent:<agentId>:<channel>:channel:<id>`); heartbeats holder baggrundsopgaver i live.

## Kerne-Skills (aktivér i Indstillinger → Skills)

- **mcporter** — Værktøjsserver-runtime/CLI til styring af eksterne Skills-backends.
- **Peekaboo** — Hurtige macOS-skærmbilleder med valgfri AI-visionsanalyse.
- **camsnap** — Fang frames, klip eller bevægelsesalarmer fra RTSP/ONVIF-sikkerhedskameraer.
- **oracle** — OpenAI-klar agent-CLI med sessionsreplay og browserkontrol.
- **eightctl** — Styr din søvn fra terminalen.
- **imsg** — Send, læs og stream iMessage & SMS.
- **wacli** — WhatsApp CLI: synkronisér, søg, send.
- **discord** — Discord handlinger: reagerer, klistermærker, afstemninger. Brug `user:<id>` eller `kanal:<id>` mål (bare numeriske id'er er tvetydige).
- **gog** — Google Suite CLI: Gmail, Kalender, Drive, Kontakter.
- **spotify-player** — Terminalbaseret Spotify-klient til søgning/kø/afspilningskontrol.
- **sag** — ElevenLabs-tale med mac-lignende say-UX; streamer som standard til højttalere.
- **Sonos CLI** — Styr Sonos-højttalere (discovery/status/afspilning/lydstyrke/gruppering) fra scripts.
- **blucli** — Afspil, gruppér og automatisér BluOS-afspillere fra scripts.
- **OpenHue CLI** — Philips Hue-lys-styring til scener og automatiseringer.
- **OpenAI Whisper** — Lokal tale-til-tekst til hurtig diktering og voicemail-udskrifter.
- **Gemini CLI** — Google Gemini-modeller fra terminalen til hurtig Q&A.
- **agent-tools** — Hjælpeværktøjssæt til automatiseringer og scripts.

## Brugsnoter

- Foretræk `openclaw` CLI til scripting; mac-appen håndterer tilladelser.
- Kør installationer fra fanen Skills; den skjuler knappen, hvis en binær allerede er til stede.
- Hold heartbeats aktiveret, så assistenten kan planlægge påmindelser, overvåge indbakker og udløse kamerafangster.
- Lærred UI kører i fuld skærm med indfødte overlejringer. Undgå at placere kritiske kontroller i top-venstre/top-højre/nederste kanter; tilføj eksplicitte tagrender i layoutet og ikke stole på et sikkert område-indsæt.
- Til browserbaseret verifikation: brug `openclaw browser` (faner/status/skærmbillede) med den OpenClaw-administrerede Chrome-profil.
- Til DOM-inspektion: brug `openclaw browser eval|query|dom|snapshot` (og `--json`/`--out` når du har brug for maskinoutput).
- Til interaktioner: brug `openclaw browser click|type|hover|drag|select|upload|press|wait|navigate|back|evaluate|run` (klik/indtastning kræver snapshot-referencer; brug `evaluate` til CSS-selektorer).
