---
summary: "Slash-commando’s: tekst vs native, configuratie en ondersteunde commando’s"
read_when:
  - Gebruik of configuratie van chatcommando’s
  - Debuggen van commandorouting of rechten
title: "Slash-commando’s"
---

# Slash-commando’s

Commando’s worden afgehandeld door de Gateway. De meeste commando’s moeten worden verzonden als een **zelfstandig** bericht dat begint met `/`.
Het bash-chatcommando voor alleen de host gebruikt `! <cmd>` (met `/bash <cmd>` als alias).

Er zijn twee verwante systemen:

- **Commando’s**: zelfstandige `/...`-berichten.
- **Richtlijnen**: `/think`, `/verbose`, `/reasoning`, `/elevated`, `/exec`, `/model`, `/queue`.
  - Richtlijnen worden uit het bericht verwijderd voordat het model het ziet.
  - In normale chatberichten (niet alleen richtlijnen) worden ze behandeld als “inline hints” en **blijven** ze geen sessie-instellingen behouden.
  - In berichten die alleen uit richtlijnen bestaan (het bericht bevat uitsluitend richtlijnen) blijven ze behouden in de sessie en volgt een bevestigingsantwoord.
  - Richtlijnen worden alleen toegepast voor **geautoriseerde afzenders** (kanaaltoegestane lijsten/pairing plus `commands.useAccessGroups`).
    Niet-geautoriseerde afzenders zien richtlijnen als gewone tekst.

Er zijn ook enkele **inline snelkoppelingen** (alleen toegestane/geautoriseerde afzenders): `/help`, `/commands`, `/status`, `/whoami` (`/id`).
Ze worden onmiddellijk uitgevoerd, verwijderd voordat het model het bericht ziet, en de resterende tekst gaat verder via de normale flow.

## Configuratie

```json5
{
  commands: {
    native: "auto",
    nativeSkills: "auto",
    text: true,
    bash: false,
    bashForegroundMs: 2000,
    config: false,
    debug: false,
    restart: false,
    useAccessGroups: true,
  },
}
```

- `commands.text` (standaard `true`) schakelt het parsen van `/...` in chatberichten in.
  - Op oppervlakken zonder native commando’s (WhatsApp/WebChat/Signal/iMessage/Google Chat/MS Teams) blijven tekstcommando’s werken, zelfs als je dit instelt op `false`.
- `commands.native` (standaard `"auto"`) registreert native commando’s.
  - Auto: aan voor Discord/Telegram; uit voor Slack (totdat je slash-commando’s toevoegt); genegeerd voor providers zonder native ondersteuning.
  - Stel `channels.discord.commands.native`, `channels.telegram.commands.native` of `channels.slack.commands.native` in om per provider te overschrijven (bool of `"auto"`).
  - `false` wist eerder geregistreerde commando’s op Discord/Telegram bij het opstarten. Slack-commando’s worden beheerd in de Slack-app en worden niet automatisch verwijderd.
- `commands.nativeSkills` (standaard `"auto"`) registreert **skill**-commando’s native wanneer ondersteund.
  - Auto: aan voor Discord/Telegram; uit voor Slack (Slack vereist het aanmaken van één slash-commando per skill).
  - Stel `channels.discord.commands.nativeSkills`, `channels.telegram.commands.nativeSkills` of `channels.slack.commands.nativeSkills` in om per provider te overschrijven (bool of `"auto"`).
- `commands.bash` (standaard `false`) schakelt `! <cmd>` in om host-shellcommando’s uit te voeren (`/bash <cmd>` is een alias; vereist `tools.elevated`-toegestane lijsten).
- `commands.bashForegroundMs` (standaard `2000`) bepaalt hoe lang bash wacht voordat wordt overgeschakeld naar de achtergrondmodus (`0` gaat direct naar de achtergrond).
- `commands.config` (standaard `false`) schakelt `/config` in (leest/schrijft `openclaw.json`).
- `commands.debug` (standaard `false`) schakelt `/debug` in (alleen runtime-overschrijvingen).
- `commands.useAccessGroups` (standaard `true`) handhaaft toegestane lijsten/beleidsregels voor commando’s.

## Commandolijst

Tekst + native (indien ingeschakeld):

- `/help`
- `/commands`
- `/skill <name> [input]` (een skill uitvoeren op naam)
- `/status` (toon huidige status; bevat providergebruik/-quotum voor de huidige modelprovider indien beschikbaar)
- `/allowlist` (toegestane-lijstvermeldingen weergeven/toevoegen/verwijderen)
- `/approve <id> allow-once|allow-always|deny` (uitvoeringsgoedkeuringsprompts oplossen)
- `/context [list|detail|json]` (leg “context” uit; `detail` toont per-bestand + per-tool + per-skill + systeempromptgrootte)
- `/whoami` (toon je afzender-id; alias: `/id`)
- `/subagents list|stop|log|info|send` (inspecteer, stop, log of bericht sub-agent-runs voor de huidige sessie)
- `/config show|get|set|unset` (config opslaan op schijf, alleen eigenaar; vereist `commands.config: true`)
- `/debug show|set|unset|reset` (runtime-overschrijvingen, alleen eigenaar; vereist `commands.debug: true`)
- `/usage off|tokens|full|cost` (gebruik-footer per antwoord of lokale kostensamenvatting)
- `/tts off|always|inbound|tagged|status|provider|limit|summary|audio` (TTS beheren; zie [/tts](/tts))
  - Discord: native commando is `/voice` (Discord reserveert `/tts`); tekst `/tts` werkt nog steeds.
- `/stop`
- `/restart`
- `/dock-telegram` (alias: `/dock_telegram`) (schakel antwoorden naar Telegram)
- `/dock-discord` (alias: `/dock_discord`) (schakel antwoorden naar Discord)
- `/dock-slack` (alias: `/dock_slack`) (schakel antwoorden naar Slack)
- `/activation mention|always` (alleen groepen)
- `/send on|off|inherit` (alleen eigenaar)
- `/reset` of `/new [model]` (optionele modelhint; rest wordt doorgegeven)
- `/think <off|minimal|low|medium|high|xhigh>` (dynamische keuzes per model/provider; aliassen: `/thinking`, `/t`)
- `/verbose on|full|off` (alias: `/v`)
- `/reasoning on|off|stream` (alias: `/reason`; indien aan, verzendt een apart bericht met prefix `Reasoning:`; `stream` = alleen Telegram-concept)
- `/elevated on|off|ask|full` (alias: `/elev`; `full` slaat uitvoeringsgoedkeuringen over)
- `/exec host=<sandbox|gateway|node> security=<deny|allowlist|full> ask=<off|on-miss|always> node=<id>` (stuur `/exec` om de huidige te tonen)
- `/model <name>` (alias: `/models`; of `/<alias>` vanaf `agents.defaults.models.*.alias`)
- `/queue <mode>` (plus opties zoals `debounce:2s cap:25 drop:summarize`; stuur `/queue` om de huidige instellingen te zien)
- `/bash <command>` (alleen host; alias voor `! <command>`; vereist `commands.bash: true` + `tools.elevated`-toegestane lijsten)

Alleen tekst:

- `/compact [instructions]` (zie [/concepts/compaction](/concepts/compaction))
- `! <command>` (alleen host; één tegelijk; gebruik `!poll` + `!stop` voor langlopende taken)
- `!poll` (controleer uitvoer/status; accepteert optioneel `sessionId`; `/bash poll` werkt ook)
- `!stop` (stop de draaiende bash-taak; accepteert optioneel `sessionId`; `/bash stop` werkt ook)

Notities:

- Commando’s accepteren een optionele `:` tussen het commando en de argumenten (bijv. `/think: high`, `/send: on`, `/help:`).
- `/new <model>` accepteert een modelalias, `provider/model` of een providernaam (fuzzy match); bij geen match wordt de tekst behandeld als de berichtinhoud.
- Voor een volledige uitsplitsing van providergebruik, gebruik `openclaw status --usage`.
- `/allowlist add|remove` vereist `commands.config=true` en respecteert kanaal-`configWrites`.
- `/usage` regelt de gebruik-footer per antwoord; `/usage cost` print een lokale kostensamenvatting uit OpenClaw-sessielogs.
- `/restart` is standaard uitgeschakeld; stel `commands.restart: true` in om het in te schakelen.
- `/verbose` is bedoeld voor debuggen en extra zichtbaarheid; houd het **uit** bij normaal gebruik.
- `/reasoning` (en `/verbose`) zijn riskant in groepsinstellingen: ze kunnen interne redenering of tooluitvoer onthullen die je niet wilde blootstellen. Laat ze bij voorkeur uit, vooral in groepschats.
- **Snelle route:** berichten met alleen commando’s van toegestane afzenders worden direct afgehandeld (omzeilen wachtrij + model).
- **Groepsmention-gating:** berichten met alleen commando’s van toegestane afzenders omzeilen mention-vereisten.
- **Inline snelkoppelingen (alleen toegestane afzenders):** bepaalde commando’s werken ook wanneer ze in een normaal bericht zijn ingebed en worden verwijderd voordat het model de resterende tekst ziet.
  - Voorbeeld: `hey /status` triggert een statusantwoord en de resterende tekst gaat verder via de normale flow.
- Momenteel: `/help`, `/commands`, `/status`, `/whoami` (`/id`).
- Niet-geautoriseerde berichten met alleen commando’s worden stilzwijgend genegeerd en inline `/...`-tokens worden als gewone tekst behandeld.
- **Skill-commando’s:** `user-invocable`-skills worden blootgesteld als slash-commando’s. Namen worden opgeschoond naar `a-z0-9_` (max. 32 tekens); botsingen krijgen numerieke suffixen (bijv. `_2`).
  - `/skill <name> [input]` voert een skill uit op naam (handig wanneer native commandolimieten per-skill-commando’s verhinderen).
  - Standaard worden skill-commando’s doorgestuurd naar het model als een normaal verzoek.
  - Skills kunnen optioneel `command-dispatch: tool` declareren om het commando direct naar een tool te routeren (deterministisch, zonder model).
  - Voorbeeld: `/prose` (OpenProse-plugin) — zie [OpenProse](/prose).
- **Argumenten voor native commando’s:** Discord gebruikt autocomplete voor dynamische opties (en knopmenu’s wanneer je vereiste argumenten weglaat). Telegram en Slack tonen een knopmenu wanneer een commando keuzes ondersteunt en je het argument weglaat.

## Gebruik op oppervlakken (wat waar verschijnt)

- **Providergebruik/-quotum** (voorbeeld: “Claude 80% over”) verschijnt in `/status` voor de huidige modelprovider wanneer gebruikstracking is ingeschakeld.
- **Tokens/kosten per antwoord** worden geregeld door `/usage off|tokens|full` (toegevoegd aan normale antwoorden).
- `/model status` gaat over **modellen/auth/eindpunten**, niet over gebruik.

## Modelselectie (`/model`)

`/model` is geïmplementeerd als een richtlijn.

Voorbeelden:

```
/model
/model list
/model 3
/model openai/gpt-5.2
/model opus@anthropic:default
/model status
```

Notities:

- `/model` en `/model list` tonen een compacte, genummerde kiezer (modelfamilie + beschikbare providers).
- `/model <#>` selecteert uit die kiezer (en geeft waar mogelijk de voorkeur aan de huidige provider).
- `/model status` toont de gedetailleerde weergave, inclusief het geconfigureerde provider-eindpunt (`baseUrl`) en API-modus (`api`) indien beschikbaar.

## Debug-overschrijvingen

`/debug` laat je **alleen-runtime** config-overschrijvingen instellen (geheugen, niet schijf). Alleen eigenaar. Standaard uitgeschakeld; inschakelen met `commands.debug: true`.

Voorbeelden:

```
/debug show
/debug set messages.responsePrefix="[openclaw]"
/debug set channels.whatsapp.allowFrom=["+1555","+4477"]
/debug unset messages.responsePrefix
/debug reset
```

Notities:

- Overschrijvingen worden direct toegepast op nieuwe config-lezingen, maar schrijven **niet** naar `openclaw.json`.
- Gebruik `/debug reset` om alle overschrijvingen te wissen en terug te keren naar de config op schijf.

## Config-updates

`/config` schrijft naar je config op schijf (`openclaw.json`). Alleen eigenaar. Standaard uitgeschakeld; inschakelen met `commands.config: true`.

Voorbeelden:

```
/config show
/config show messages.responsePrefix
/config get messages.responsePrefix
/config set messages.responsePrefix="[openclaw]"
/config unset messages.responsePrefix
```

Notities:

- De config wordt gevalideerd vóór het schrijven; ongeldige wijzigingen worden geweigerd.
- `/config`-updates blijven behouden na herstarts.

## Oppervlaktenotities

- **Tekstcommando’s** draaien in de normale chatsessie (DM’s delen `main`, groepen hebben hun eigen sessie).
- **Native commando’s** gebruiken geïsoleerde sessies:
  - Discord: `agent:<agentId>:discord:slash:<userId>`
  - Slack: `agent:<agentId>:slack:slash:<userId>` (prefix configureerbaar via `channels.slack.slashCommand.sessionPrefix`)
  - Telegram: `telegram:slash:<userId>` (richt zich op de chatsessie via `CommandTargetSessionKey`)
- **`/stop`** richt zich op de actieve chatsessie zodat het de huidige run kan afbreken.
- **Slack:** `channels.slack.slashCommand` wordt nog steeds ondersteund voor één enkel `/openclaw`-achtig commando. Als je `commands.native` inschakelt, moet je één Slack slash-commando per ingebouwd commando aanmaken (dezelfde namen als `/help`). Command-argumentmenu’s voor Slack worden geleverd als ephemeral Block Kit-knoppen.
