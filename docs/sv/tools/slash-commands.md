---
summary: "Slashkommandon: text vs. native, konfig och stödda kommandon"
read_when:
  - När du använder eller konfigurerar chattkommandon
  - Vid felsökning av kommandoroutning eller behörigheter
title: "Slashkommandon"
x-i18n:
  source_path: tools/slash-commands.md
  source_hash: ca0deebf89518e8c
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T08:19:13Z
---

# Slashkommandon

Kommandon hanteras av Gateway. De flesta kommandon måste skickas som ett **fristående** meddelande som börjar med `/`.
Det värd‑endast bash‑chattkommandot använder `! <cmd>` (med `/bash <cmd>` som alias).

Det finns två relaterade system:

- **Kommandon**: fristående `/...`‑meddelanden.
- **Direktiv**: `/think`, `/verbose`, `/reasoning`, `/elevated`, `/exec`, `/model`, `/queue`.
  - Direktiv tas bort från meddelandet innan modellen ser det.
  - I vanliga chattmeddelanden (inte enbart direktiv) behandlas de som ”inline‑tips” och **består inte** sessionsinställningar.
  - I meddelanden som endast innehåller direktiv (meddelandet innehåller bara direktiv) består de till sessionen och svarar med en bekräftelse.
  - Direktiv tillämpas endast för **auktoriserade avsändare** (kanalernas tillåtelselistor/parkoppling plus `commands.useAccessGroups`).
    Obehöriga avsändare ser direktiv behandlade som vanlig text.

Det finns också några **inline‑genvägar** (endast tillåtelselista/auktoriserade avsändare): `/help`, `/commands`, `/status`, `/whoami` (`/id`).
De körs omedelbart, tas bort innan modellen ser meddelandet, och kvarvarande text fortsätter genom det normala flödet.

## Konfig

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

- `commands.text` (standard `true`) aktiverar tolkning av `/...` i chattmeddelanden.
  - På ytor utan native‑kommandon (WhatsApp/WebChat/Signal/iMessage/Google Chat/MS Teams) fungerar textkommandon fortfarande även om du sätter detta till `false`.
- `commands.native` (standard `"auto"`) registrerar native‑kommandon.
  - Auto: på för Discord/Telegram; av för Slack (tills du lägger till slashkommandon); ignoreras för leverantörer utan native‑stöd.
  - Sätt `channels.discord.commands.native`, `channels.telegram.commands.native` eller `channels.slack.commands.native` för att åsidosätta per leverantör (bool eller `"auto"`).
  - `false` rensar tidigare registrerade kommandon på Discord/Telegram vid start. Slack‑kommandon hanteras i Slack‑appen och tas inte bort automatiskt.
- `commands.nativeSkills` (standard `"auto"`) registrerar **skill**‑kommandon nativt när det stöds.
  - Auto: på för Discord/Telegram; av för Slack (Slack kräver att du skapar ett slashkommando per skill).
  - Sätt `channels.discord.commands.nativeSkills`, `channels.telegram.commands.nativeSkills` eller `channels.slack.commands.nativeSkills` för att åsidosätta per leverantör (bool eller `"auto"`).
- `commands.bash` (standard `false`) aktiverar `! <cmd>` för att köra värd‑shellkommandon (`/bash <cmd>` är ett alias; kräver `tools.elevated`‑tillåtelselistor).
- `commands.bashForegroundMs` (standard `2000`) styr hur länge bash väntar innan det växlar till bakgrundsläge (`0` bakgrundar omedelbart).
- `commands.config` (standard `false`) aktiverar `/config` (läser/skriv­er `openclaw.json`).
- `commands.debug` (standard `false`) aktiverar `/debug` (endast körningstids‑åsidosättningar).
- `commands.useAccessGroups` (standard `true`) upprätthåller tillåtelselistor/policys för kommandon.

## Kommandolista

Text + native (när aktiverat):

- `/help`
- `/commands`
- `/skill <name> [input]` (kör en skill efter namn)
- `/status` (visa aktuell status; inkluderar leverantörsanvändning/kvot för aktuell modellleverantör när tillgängligt)
- `/allowlist` (lista/lägg till/ta bort poster i tillåtelselistan)
- `/approve <id> allow-once|allow-always|deny` (lös exec‑godkännandepromptar)
- `/context [list|detail|json]` (förklara ”context”; `detail` visar per‑fil + per‑verktyg + per‑skill + systempromptstorlek)
- `/whoami` (visa ditt avsändar‑id; alias: `/id`)
- `/subagents list|stop|log|info|send` (inspektera, stoppa, logga eller skicka meddelanden till underagentkörningar för aktuell session)
- `/config show|get|set|unset` (spara konfig till disk, endast ägare; kräver `commands.config: true`)
- `/debug show|set|unset|reset` (körningstidsåsidosättningar, endast ägare; kräver `commands.debug: true`)
- `/usage off|tokens|full|cost` (användningsfot per svar eller lokal kostnadssammanfattning)
- `/tts off|always|inbound|tagged|status|provider|limit|summary|audio` (styr TTS; se [/tts](/tts))
  - Discord: native‑kommandot är `/voice` (Discord reserverar `/tts`); text `/tts` fungerar fortfarande.
- `/stop`
- `/restart`
- `/dock-telegram` (alias: `/dock_telegram`) (växla svar till Telegram)
- `/dock-discord` (alias: `/dock_discord`) (växla svar till Discord)
- `/dock-slack` (alias: `/dock_slack`) (växla svar till Slack)
- `/activation mention|always` (endast grupper)
- `/send on|off|inherit` (endast ägare)
- `/reset` eller `/new [model]` (valfri modellhint; resten skickas vidare)
- `/think <off|minimal|low|medium|high|xhigh>` (dynamiska val per modell/leverantör; alias: `/thinking`, `/t`)
- `/verbose on|full|off` (alias: `/v`)
- `/reasoning on|off|stream` (alias: `/reason`; när på, skickar ett separat meddelande med prefix `Reasoning:`; `stream` = endast Telegram‑utkast)
- `/elevated on|off|ask|full` (alias: `/elev`; `full` hoppar över exec‑godkännanden)
- `/exec host=<sandbox|gateway|node> security=<deny|allowlist|full> ask=<off|on-miss|always> node=<id>` (skicka `/exec` för att visa aktuellt)
- `/model <name>` (alias: `/models`; eller `/<alias>` från `agents.defaults.models.*.alias`)
- `/queue <mode>` (plus alternativ som `debounce:2s cap:25 drop:summarize`; skicka `/queue` för att se aktuella inställningar)
- `/bash <command>` (endast värd; alias för `! <command>`; kräver `commands.bash: true` + `tools.elevated`‑tillåtelselistor)

Endast text:

- `/compact [instructions]` (se [/concepts/compaction](/concepts/compaction))
- `! <command>` (endast värd; en i taget; använd `!poll` + `!stop` för långvariga jobb)
- `!poll` (kontrollera utdata/status; accepterar valfri `sessionId`; `/bash poll` fungerar också)
- `!stop` (stoppa det körande bash‑jobbet; accepterar valfri `sessionId`; `/bash stop` fungerar också)

Noteringar:

- Kommandon accepterar en valfri `:` mellan kommandot och argumenten (t.ex. `/think: high`, `/send: on`, `/help:`).
- `/new <model>` accepterar ett modellalias, `provider/model` eller ett leverantörsnamn (fuzzy‑match); om ingen match finns behandlas texten som meddelandets innehåll.
- För full uppdelning av leverantörsanvändning, använd `openclaw status --usage`.
- `/allowlist add|remove` kräver `commands.config=true` och respekterar kanalens `configWrites`.
- `/usage` styr användningsfoten per svar; `/usage cost` skriver ut en lokal kostnadssammanfattning från OpenClaw‑sessionsloggar.
- `/restart` är avstängd som standard; sätt `commands.restart: true` för att aktivera den.
- `/verbose` är avsedd för felsökning och extra insyn; håll den **av** vid normal användning.
- `/reasoning` (och `/verbose`) är riskabla i gruppsammanhang: de kan avslöja intern resonemang eller verktygsutdata som du inte avsåg att exponera. Föredra att lämna dem avstängda, särskilt i gruppchattar.
- **Snabb väg:** meddelanden som endast innehåller kommandon från tillåtelselista hanteras omedelbart (kringgår kö + modell).
- **Grupptomnämnings‑gating:** meddelanden som endast innehåller kommandon från tillåtelselista kringgår krav på omnämnanden.
- **Inline‑genvägar (endast tillåtelselista):** vissa kommandon fungerar även när de bäddas in i ett vanligt meddelande och tas bort innan modellen ser återstående text.
  - Exempel: `hey /status` triggar ett statussvar och återstående text fortsätter genom det normala flödet.
- För närvarande: `/help`, `/commands`, `/status`, `/whoami` (`/id`).
- Obehöriga meddelanden som endast innehåller kommandon ignoreras tyst, och inline‑`/...`‑token behandlas som vanlig text.
- **Skill‑kommandon:** `user-invocable`‑skills exponeras som slashkommandon. Namn saneras till `a-z0-9_` (max 32 tecken); kollisioner får numeriska suffix (t.ex. `_2`).
  - `/skill <name> [input]` kör en skill efter namn (användbart när native‑kommandogränser hindrar per‑skill‑kommandon).
  - Som standard vidarebefordras skill‑kommandon till modellen som en normal begäran.
  - Skills kan valfritt deklarera `command-dispatch: tool` för att routa kommandot direkt till ett verktyg (deterministiskt, ingen modell).
  - Exempel: `/prose` (OpenProse‑plugin) — se [OpenProse](/prose).
- **Argument för native‑kommandon:** Discord använder autocomplete för dynamiska alternativ (och knappmenyer när du utelämnar obligatoriska argument). Telegram och Slack visar en knappmeny när ett kommando stöder val och du utelämnar argumentet.

## Användningsytor (vad som visas var)

- **Leverantörsanvändning/kvot** (exempel: ”Claude 80% kvar”) visas i `/status` för aktuell modellleverantör när användningsspårning är aktiverad.
- **Tokens/kostnad per svar** styrs av `/usage off|tokens|full` (läggs till normala svar).
- `/model status` handlar om **modeller/autentisering/endpoints**, inte användning.

## Modellval (`/model`)

`/model` är implementerad som ett direktiv.

Exempel:

```
/model
/model list
/model 3
/model openai/gpt-5.2
/model opus@anthropic:default
/model status
```

Noteringar:

- `/model` och `/model list` visar en kompakt, numrerad väljare (modellfamilj + tillgängliga leverantörer).
- `/model <#>` väljer från den väljaren (och föredrar aktuell leverantör när möjligt).
- `/model status` visar den detaljerade vyn, inklusive konfigurerad leverantörsendpoint (`baseUrl`) och API‑läge (`api`) när tillgängligt.

## Debug‑åsidosättningar

`/debug` låter dig sätta **endast körningstids**‑konfigurationsåsidosättningar (minne, inte disk). Endast ägare. Avstängd som standard; aktivera med `commands.debug: true`.

Exempel:

```
/debug show
/debug set messages.responsePrefix="[openclaw]"
/debug set channels.whatsapp.allowFrom=["+1555","+4477"]
/debug unset messages.responsePrefix
/debug reset
```

Noteringar:

- Åsidosättningar gäller omedelbart för nya konfigläsningar, men skriver **inte** till `openclaw.json`.
- Använd `/debug reset` för att rensa alla åsidosättningar och återgå till konfig på disk.

## Konfiguppdateringar

`/config` skriver till din konfig på disk (`openclaw.json`). Endast ägare. Avstängd som standard; aktivera med `commands.config: true`.

Exempel:

```
/config show
/config show messages.responsePrefix
/config get messages.responsePrefix
/config set messages.responsePrefix="[openclaw]"
/config unset messages.responsePrefix
```

Noteringar:

- Konfig valideras före skrivning; ogiltiga ändringar avvisas.
- `/config`‑uppdateringar består över omstarter.

## Yt‑noteringar

- **Textkommandon** körs i den normala chattsessionen (DM delar `main`, grupper har sin egen session).
- **Native‑kommandon** använder isolerade sessioner:
  - Discord: `agent:<agentId>:discord:slash:<userId>`
  - Slack: `agent:<agentId>:slack:slash:<userId>` (prefix konfigurerbart via `channels.slack.slashCommand.sessionPrefix`)
  - Telegram: `telegram:slash:<userId>` (riktar in sig på chattsessionen via `CommandTargetSessionKey`)
- **`/stop`** riktar in sig på den aktiva chattsessionen så att den kan avbryta den aktuella körningen.
- **Slack:** `channels.slack.slashCommand` stöds fortfarande för ett enda `/openclaw`‑liknande kommando. Om du aktiverar `commands.native` måste du skapa ett Slack‑slashkommando per inbyggt kommando (samma namn som `/help`). Menyer för kommandoargument i Slack levereras som tillfälliga Block Kit‑knappar.
