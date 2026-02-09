---
summary: "Slash-kommandoer: tekst vs. native, konfiguration og understøttede kommandoer"
read_when:
  - Brug eller konfigurer chatkommandoer
  - Fejlfinding af kommandorouting eller tilladelser
title: "Slash-kommandoer"
---

# Slash-kommandoer

Kommandoer håndteres af Porten. De fleste kommandoer skal sendes som en **standalone** besked, der starter med `/`.
Kommandoen host- only bash chat bruger `! <cmd>` (med `/bash <cmd>` som et alias).

Der er to relaterede systemer:

- **Kommandoer**: selvstændige `/...`-beskeder.
- **Direktiver**: `/think`, `/verbose`, `/reasoning`, `/elevated`, `/exec`, `/model`, `/queue`.
  - Direktiver fjernes fra beskeden, før modellen ser den.
  - I normale chatbeskeder (ikke kun-direktiv) behandles de som “inline-hints” og **persistérer ikke** sessionsindstillinger.
  - I beskeder, der kun består af direktiver (beskeden indeholder kun direktiver), persistérer de til sessionen og svarer med en bekræftelse.
  - Direktiver anvendes kun for **autoriserede afsendere** (kanal allowlists/parring plus `commands.useAccessGroups`).
    Uautoriserede afsendere ser direktiver, der behandles som almindelig tekst.

Der er også et par **inline genveje** (tilladt/autoriserede afsendere kun): `/help`, `/commands`, `/status`, `/whoami` (`/id`).
De kører straks, er strippet før modellen ser meddelelsen, og den resterende tekst fortsætter gennem den normale flow.

## Konfiguration

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

- `commands.text` (standard `true`) aktiverer parsing af `/...` i chatbeskeder.
  - På overflader uden native kommandoer (WhatsApp/WebChat/Signal/iMessage/Google Chat/MS Teams) virker tekstkommandoer stadig, selv hvis du sætter dette til `false`.
- `commands.native` (standard `"auto"`) registrerer native kommandoer.
  - Auto: til for Discord/Telegram; fra for Slack (indtil du tilføjer slash-kommandoer); ignoreres for udbydere uden native understøttelse.
  - Sæt `channels.discord.commands.native`, `channels.telegram.commands.native` eller `channels.slack.commands.native` for at tilsidesætte pr. udbyder (bool eller `"auto"`).
  - `false` rydder tidligere registrerede kommandoer på Discord/Telegram ved opstart. Slack kommandoer administreres i Slack app'en og fjernes ikke automatisk.
- `commands.nativeSkills` (standard `"auto"`) registrerer **skill**-kommandoer nativt, når det understøttes.
  - Auto: til for Discord/Telegram; fra for Slack (Slack kræver oprettelse af en slash-kommando pr. skill).
  - Sæt `channels.discord.commands.nativeSkills`, `channels.telegram.commands.nativeSkills` eller `channels.slack.commands.nativeSkills` for at tilsidesætte pr. udbyder (bool eller `"auto"`).
- `commands.bash` (standard `false`) aktiverer `! <cmd>` for at køre vært shell kommandoer (`/bash <cmd>` er et alias; kræver `tools.elevated` allowlists).
- `commands.bashForegroundMs` (standard `2000`) styrer, hvor længe bash venter, før der skiftes til baggrundstilstand (`0` baggrundsætter med det samme).
- `commands.config` (standard `false`) aktiverer `/config` (læser/skriver `openclaw.json`).
- `commands.debug` (standard `false`) aktiverer `/debug` (kun runtime-tilsidesættelser).
- `commands.useAccessGroups` (standard `true`) håndhæver tilladelseslister/politikker for kommandoer.

## Kommandoliste

Tekst + native (når aktiveret):

- `/help`
- `/commands`
- `/skill <name> [input]` (kør en skill efter navn)
- `/status` (vis aktuel status; inkluderer udbyderbrug/kvote for den aktuelle modeludbyder, når tilgængelig)
- `/allowlist` (list/tilføj/fjern poster i tilladelseslisten)
- `/approve <id> allow-once|allow-always|deny` (afklar exec-godkendelsesprompter)
- `/context [list|detail|json]` (forklar “kontekst”; `detail` viser pr.-fil + pr.-værktøj + pr.-skill + systemprompt-størrelse)
- `/whoami` (vis dit afsender-id; alias: `/id`)
- `/subagents list|stop|log|info|send` (inspicér, stop, log eller send beskeder til underagent-kørsler for den aktuelle session)
- `/config show|get|set|unset` (persistér konfiguration til disk, kun ejer; kræver `commands.config: true`)
- `/debug show|set|unset|reset` (runtime-tilsidesættelser, kun ejer; kræver `commands.debug: true`)
- `/usage off|tokens|full|cost` (brugsfodnote pr. svar eller lokal omkostningsoversigt)
- `/tts off|always|inbound|tagged|status|provider|limit|summary|audio` (styr TTS; se [/tts](/tts))
  - Discord: native kommando er `/voice` (Discord reserverer `/tts`); tekst `/tts` virker stadig.
- `/stop`
- `/restart`
- `/dock-telegram` (alias: `/dock_telegram`) (skift svar til Telegram)
- `/dock-discord` (alias: `/dock_discord`) (skift svar til Discord)
- `/dock-slack` (alias: `/dock_slack`) (skift svar til Slack)
- `/activation mention|always` (kun grupper)
- `/send on|off|inherit` (kun ejer)
- `/reset` eller `/new [model]` (valgfrit modelhint; resten sendes videre)
- `/think <off|minimal|low|medium|high|xhigh>` (dynamiske valg efter model/udbyder; aliaser: `/thinking`, `/t`)
- `/verbose on|full|off` (alias: `/v`)
- `/reasoning on|off|stream` (alias: `/reason`; når slået til, sendes en separat besked med præfikset `Reasoning:`; `stream` = kun Telegram-kladde)
- `/elevated on|off|ask|full` (alias: `/elev`; `full` springer exec-godkendelser over)
- `/exec host=<sandbox|gateway|node> security=<deny|allowlist|full> ask=<off|on-miss|always> node=<id>` (send `/exec` for at vise aktuelt)
- `/model <name>` (alias: `/models`; eller `/<alias>` fra `agents.defaults.models.*.alias`)
- `/queue <mode>` (plus muligheder som `debounce:2s cap:25 drop:summarize`; send `/queue` for at se aktuelle indstillinger)
- `/bash <command>` (kun vært; alias for `! <command>`; kræver `commands.bash: true` + `tools.elevated` tilladlister)

Kun tekst:

- `/compact [instructions]` (se [/concepts/compaction](/concepts/compaction))
- `! <command>` (kun vært; én ad gangen; brug `!poll` + `!stop` til langvarige job)
- `!poll` (tjek output/status; accepterer valgfri `sessionId`; `/bash poll` virker også)
- `!stop` (stop det kørende bash-job; accepterer valgfri `sessionId`; `/bash stop` virker også)

Noter:

- Kommandoer accepterer et valgfrit `:` mellem kommandoen og argumenter (fx `/think: high`, `/send: on`, `/help:`).
- `/new <model>` accepterer et modelalias, `provider/model` eller et udbydernavn (fuzzy match); hvis der ikke er match, behandles teksten som beskedens indhold.
- For fuld opdeling af udbyderbrug, brug `openclaw status --usage`.
- `/allowlist add|remove` kræver `commands.config=true` og respekterer kanalens `configWrites`.
- `/usage` styrer brugsfodnoten pr. svar; `/usage cost` udskriver en lokal omkostningsoversigt fra OpenClaw-sessionslogs.
- `/restart` er deaktiveret som standard; sæt `commands.restart: true` for at aktivere det.
- `/verbose` er beregnet til fejlfinding og ekstra synlighed; hold den **slået fra** ved normal brug.
- `/ræsonnement` (og `/verbose`) er risikabelt i gruppeindstillinger: de kan afsløre intern ræsonnement eller værktøj output du ikke havde til hensigt at forklare. Foretrækker at forlade dem, især i gruppechats.
- **Hurtig sti:** kommando-kun-beskeder fra tilladte afsendere håndteres med det samme (omgår kø + model).
- **Gruppe-mention-gating:** kommando-kun-beskeder fra tilladte afsendere omgår krav om mentions.
- **Inline-genveje (kun tilladte afsendere):** visse kommandoer virker også, når de er indlejret i en normal besked, og fjernes før modellen ser den resterende tekst.
  - Eksempel: `hey /status` udløser et statussvar, og den resterende tekst fortsætter gennem det normale flow.
- Aktuelt: `/help`, `/commands`, `/status`, `/whoami` (`/id`).
- Uautoriserede kommando-kun-beskeder ignoreres stiltiende, og inline `/...`-tokens behandles som almindelig tekst.
- **Færdighedskommandoer:** `bruger-uigenkaldelig` færdigheder er afsløret som skråstreg kommandoer. Navne desinficeres til `a-z0-9_` (max 32 tegn); kollisioner får numeriske suffikser (f.eks. `_2`).
  - `/skill <name> [input]` kører en skill efter navn (nyttigt når native kommandogrænser forhindrer pr.-skill-kommandoer).
  - Som standard videresendes skill-kommandoer til modellen som en normal anmodning.
  - Skills kan valgfrit erklære `command-dispatch: tool` for at route kommandoen direkte til et værktøj (deterministisk, ingen model).
  - Eksempel: `/prose` (OpenProse-plugin) — se [OpenProse](/prose).
- **Indfødte kommando argumenter:** Discord bruger autofuldførelse til dynamiske indstillinger (og knapmenuer, når du udelader nødvendige args). Telegram og Slack viser en knap menu, når en kommando understøtter valg, og du udelader arg.

## Brugsflader (hvad vises hvor)

- **Udbyderbrug/kvote** (eksempel: “Claude 80% tilbage”) vises i `/status` for den aktuelle modeludbyder, når brugssporing er aktiveret.
- **Tokens/omkostning pr. svar** styres af `/usage off|tokens|full` (vedhæftet normale svar).
- `/model status` handler om **modeller/autentificering/endpoints**, ikke brug.

## Modelvalg (`/model`)

`/model` er implementeret som et direktiv.

Eksempler:

```
/model
/model list
/model 3
/model openai/gpt-5.2
/model opus@anthropic:default
/model status
```

Noter:

- `/model` og `/model list` viser en kompakt, nummereret vælger (modelfamilie + tilgængelige udbydere).
- `/model <#>` vælger fra den vælger (og foretrækker den aktuelle udbyder, når det er muligt).
- `/model status` viser den detaljerede visning, herunder konfigureret udbyder endpoint (`baseUrl`) og API mode (`api`) når tilgængelig.

## Debug-tilsidesættelser

`/debug` lader dig angive **runtime-only** config overrides (hukommelse, ikke disk). Udelukkende ejer. Deaktiveret som standard; aktivér med `commands.debug: true`.

Eksempler:

```
/debug show
/debug set messages.responsePrefix="[openclaw]"
/debug set channels.whatsapp.allowFrom=["+1555","+4477"]
/debug unset messages.responsePrefix
/debug reset
```

Noter:

- Tilsidesættelser anvendes straks på nye konfigurationslæsninger, men skriver **ikke** til `openclaw.json`.
- Brug `/debug reset` til at rydde alle tilsidesættelser og vende tilbage til konfigurationen på disk.

## Konfigurationsopdateringer

`/config` skriver til din konfiguration på disken (`openclaw.json`). Udelukkende ejer. Deaktiveret som standard; aktivér med `commands.config: true`.

Eksempler:

```
/config show
/config show messages.responsePrefix
/config get messages.responsePrefix
/config set messages.responsePrefix="[openclaw]"
/config unset messages.responsePrefix
```

Noter:

- Konfigurationen valideres før skrivning; ugyldige ændringer afvises.
- `/config`-opdateringer består på tværs af genstarter.

## Overfladenoter

- **Tekstkommandoer** kører i den normale chatsession (DM’er deler `main`, grupper har deres egen session).
- **Native kommandoer** bruger isolerede sessioner:
  - Discord: `agent:<agentId>:discord:slash:<userId>`
  - Slack: `agent:<agentId>:slack:slash:<userId>` (præfiks kan konfigureres via `channels.slack.slashCommand.sessionPrefix`)
  - Telegram: `telegram:slash:<userId>` (målretter chatsessionen via `CommandTargetSessionKey`)
- **`/stop`** målretter den aktive chatsession, så den kan afbryde den aktuelle kørsel.
- **Slack:** `channels.slack.slashCommand` er stadig understøttet for en enkelt `/openclaw`-lignende kommando. Hvis du aktiverer `commands.native`, skal du oprette en Slack skråstreg kommando pr. indbygget kommando (samme navne som `/help`). Kommando argument menuer til Slack leveres som flygtige Block Kit knapper.
