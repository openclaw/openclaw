---
summary: "Standaard OpenClaw-agentinstructies en Skills-overzicht voor de persoonlijke assistent-opstelling"
read_when:
  - Een nieuwe OpenClaw-agent­sessie starten
  - Standaard Skills inschakelen of auditen
---

# AGENTS.md — OpenClaw Persoonlijke Assistent (standaard)

## Eerste keer uitvoeren (aanbevolen)

OpenClaw gebruikt een speciale werkruimtemap voor de agent. Standaard: `~/.openclaw/workspace` (configureerbaar via `agents.defaults.workspace`).

1. Maak de werkruimte aan (als deze nog niet bestaat):

```bash
mkdir -p ~/.openclaw/workspace
```

2. Kopieer de standaard werkruimtesjablonen naar de werkruimte:

```bash
cp docs/reference/templates/AGENTS.md ~/.openclaw/workspace/AGENTS.md
cp docs/reference/templates/SOUL.md ~/.openclaw/workspace/SOUL.md
cp docs/reference/templates/TOOLS.md ~/.openclaw/workspace/TOOLS.md
```

3. Optioneel: als je het Skills-overzicht voor de persoonlijke assistent wilt, vervang AGENTS.md door dit bestand:

```bash
cp docs/reference/AGENTS.default.md ~/.openclaw/workspace/AGENTS.md
```

4. Optioneel: kies een andere werkruimte door `agents.defaults.workspace` in te stellen (ondersteunt `~`):

```json5
{
  agents: { defaults: { workspace: "~/.openclaw/workspace" } },
}
```

## Standaard veiligheidsinstellingen

- Dump geen mappen of geheimen in de chat.
- Voer geen destructieve opdrachten uit tenzij hier expliciet om wordt gevraagd.
- Stuur geen gedeeltelijke/streamende antwoorden naar externe berichtkanalen (alleen definitieve antwoorden).

## Sessiestart (vereist)

- Lees `SOUL.md`, `USER.md`, `memory.md` en vandaag+gisteren in `memory/`.
- Doe dit vóórdat je antwoordt.

## Ziel (verplicht)

- `SOUL.md` definieert identiteit, toon en grenzen. Houd dit actueel.
- Als je `SOUL.md` wijzigt, informeer de gebruiker.
- Je bent elke sessie een nieuwe instantie; continuïteit leeft in deze bestanden.

## Gedeelde ruimtes (aanbevolen)

- Je bent niet de stem van de gebruiker; wees voorzichtig in groepschats of openbare kanalen.
- Deel geen privégegevens, contactinformatie of interne notities.

## Geheugensysteem (aanbevolen)

- Daglogboek: `memory/YYYY-MM-DD.md` (maak `memory/` aan indien nodig).
- Langetermijngeheugen: `memory.md` voor duurzame feiten, voorkeuren en beslissingen.
- Lees bij sessiestart vandaag + gisteren + `memory.md` indien aanwezig.
- Leg vast: beslissingen, voorkeuren, beperkingen, open eindjes.
- Vermijd geheimen tenzij hier expliciet om wordt gevraagd.

## Tools & Skills

- Tools leven in Skills; volg de `SKILL.md` van elke Skill wanneer je die nodig hebt.
- Houd omgevingsspecifieke notities bij in `TOOLS.md` (Notities voor Skills).

## Back-up tip (aanbevolen)

Als je deze werkruimte beschouwt als Clawd’s “geheugen”, maak er dan een git-repo van (bij voorkeur privé) zodat `AGENTS.md` en je geheugenbestanden worden geback-upt.

```bash
cd ~/.openclaw/workspace
git init
git add AGENTS.md
git commit -m "Add Clawd workspace"
# Optional: add a private remote + push
```

## Wat OpenClaw doet

- Draait een WhatsApp Gateway + Pi coding agent zodat de assistent chats kan lezen/schrijven, context kan ophalen en Skills kan uitvoeren via de host-Mac.
- De macOS-app beheert rechten (schermopname, meldingen, microfoon) en stelt de `openclaw` CLI beschikbaar via de meegeleverde binary.
- Directe chats worden standaard samengevoegd in de `main`-sessie van de agent; groepen blijven geïsoleerd als `agent:<agentId>:<channel>:group:<id>` (ruimtes/kanalen: `agent:<agentId>:<channel>:channel:<id>`); heartbeat-signalen houden achtergrondtaken actief.

## Kern-Skills (inschakelen via Instellingen → Skills)

- **mcporter** — Toolserver-runtime/CLI voor het beheren van externe Skill-backends.
- **Peekaboo** — Snelle macOS-screenshots met optionele AI-visieanalyse.
- **camsnap** — Vastleggen van frames, clips of bewegingsmeldingen van RTSP/ONVIF-beveiligingscamera’s.
- **oracle** — OpenAI-klaar agent-CLI met sessieherhaling en browserbesturing.
- **eightctl** — Bedien je slaap vanuit de terminal.
- **imsg** — iMessage & SMS verzenden, lezen en streamen.
- **wacli** — WhatsApp CLI: synchroniseren, zoeken, verzenden.
- **discord** — Discord-acties: reageren, stickers, polls. Gebruik `user:<id>` of `channel:<id>` als doelen (kale numerieke id’s zijn ambigu).
- **gog** — Google Suite CLI: Gmail, Agenda, Drive, Contacten.
- **spotify-player** — Terminal-Spotifyclient om afspelen te zoeken/in de wachtrij te zetten/te bedienen.
- **sag** — ElevenLabs-spraak met mac-stijl say-UX; streamt standaard naar speakers.
- **Sonos CLI** — Sonos-speakers bedienen (discovery/status/afspelen/volume/groeperen) vanuit scripts.
- **blucli** — BluOS-players afspelen, groeperen en automatiseren vanuit scripts.
- **OpenHue CLI** — Philips Hue-verlichtingsbediening voor scènes en automatiseringen.
- **OpenAI Whisper** — Lokale spraak-naar-tekst voor snelle dictatie en voicemailtranscripties.
- **Gemini CLI** — Google Gemini-modellen vanuit de terminal voor snelle Q&A.
- **agent-tools** — Hulpmiddelenset voor automatiseringen en helper-scripts.

## Gebruiksnotities

- Geef de voorkeur aan de `openclaw` CLI voor scripting; de mac-app regelt de rechten.
- Voer installaties uit vanuit het tabblad Skills; de knop wordt verborgen als een binary al aanwezig is.
- Houd heartbeat-signalen ingeschakeld zodat de assistent herinneringen kan plannen, inboxen kan monitoren en cameracaptures kan triggeren.
- De Canvas-UI draait fullscreen met native overlays. Plaats geen kritieke bedieningselementen in de bovenlinks-/bovenrechts-/onderranden; voeg expliciete marges toe in de layout en vertrouw niet op safe-area insets.
- Gebruik voor browsergestuurde verificatie `openclaw browser` (tabbladen/status/screenshot) met het door OpenClaw beheerde Chrome-profiel.
- Gebruik voor DOM-inspectie `openclaw browser eval|query|dom|snapshot` (en `--json`/`--out` wanneer je machine-uitvoer nodig hebt).
- Gebruik voor interacties `openclaw browser click|type|hover|drag|select|upload|press|wait|navigate|back|evaluate|run` (klikken/typen vereist snapshot-referenties; gebruik `evaluate` voor CSS-selectors).
