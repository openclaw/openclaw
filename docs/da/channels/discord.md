---
summary: "Status for Discord-botunderstøttelse, funktioner og konfiguration"
read_when:
  - Arbejder med Discord-kanalfunktioner
title: "Discord"
---

# Discord (Bot API)

Status: klar til DM’er og guild-tekstkanaler via den officielle Discord bot-gateway.

## Hurtig opsætning (begynder)

1. Opret en Discord-bot, og kopiér bot-tokenet.
2. I Discord-appens indstillinger skal du aktivere **Message Content Intent** (og **Server Members Intent**, hvis du vil bruge tilladelseslister eller navneopslag).
3. Sæt tokenet for OpenClaw:
   - Env: `DISCORD_BOT_TOKEN=...`
   - Eller config: `channels.discord.token: "..."`.
   - Hvis begge er sat, har config forrang (env fallback er kun for standardkontoen).
4. Invitér botten til din server med beskedtilladelser (opret en privat server, hvis du kun vil bruge DM’er).
5. Start gateway’en.
6. DM-adgang er som standard parring; godkend parringskoden ved første kontakt.

Minimal konfiguration:

```json5
{
  channels: {
    discord: {
      enabled: true,
      token: "YOUR_BOT_TOKEN",
    },
  },
}
```

## Mål

- Tal med OpenClaw via Discord-DM’er eller guild-kanaler.
- Direkte chats samles i agentens hovedsession (standard `agent:main:main`); guild-kanaler forbliver isolerede som `agent:<agentId>:discord:channel:<channelId>` (visningsnavne bruger `discord:<guildSlug>#<channelSlug>`).
- GruppeDM'er ignoreres som standard; aktiveres via `channels.discord.dm.groupEnabled` og kan eventuelt begrænses af `channels.discord.dm.groupChannels`.
- Hold routing deterministisk: svar sendes altid tilbage til den kanal, de kom fra.

## Sådan virker det

1. Opret en Discord-applikation → Bot, aktivér de intents, du har brug for (DM’er + guild-beskeder + message content), og hent bot-tokenet.
2. Invitér botten til din server med de tilladelser, der kræves for at læse/sende beskeder der, hvor du vil bruge den.
3. Konfigurér OpenClaw med `channels.discord.token` (eller `DISCORD_BOT_TOKEN` som fallback).
4. Kør gateway’en; den starter automatisk Discord-kanalen, når et token er tilgængeligt (config først, env fallback), og `channels.discord.enabled` ikke er `false`.
   - Hvis du foretrækker miljøvariabler, så sæt `DISCORD_BOT_TOKEN` (en config-blok er valgfri).
5. Direkte chats: brug `bruger:<id>` (eller en `<@id>` omtale) ved levering; alle vender land i den delte `main` session. Bare numeriske id'er er tvetydige og afvist.
6. Guild kanaler: brug `kanal:<channelId>` for levering. Nævner er påkrævet som standard og kan indstilles per guild eller per kanal.
7. Direkte chats: sikker som standard via `channels.discord.dm.policy` (default: `"pairing"`). Ukendte afsendere får en parringskode (udløber efter 1 time). Godkend via `openclaw parring godkend discord <code>`.
   - For at bevare den gamle “åben for alle”-adfærd: sæt `channels.discord.dm.policy="open"` og `channels.discord.dm.allowFrom=["*"]`.
   - For hård tilladelsesliste: sæt `channels.discord.dm.policy="allowlist"` og list afsendere i `channels.discord.dm.allowFrom`.
   - For at ignorere alle DM’er: sæt `channels.discord.dm.enabled=false` eller `channels.discord.dm.policy="disabled"`.
8. GruppeDM'er ignoreres som standard; aktiveres via `channels.discord.dm.groupEnabled` og kan eventuelt begrænses af `channels.discord.dm.groupChannels`.
9. Valgfrie guild-regler: sæt `channels.discord.guilds` med nøgle efter guild-id (foretrukket) eller slug, med regler pr. kanal.
10. Valgfrie indfødte kommandoer: `commands.native` standard er `"auto"` (tændt for Discord/Telegram, slukket for Slack). Tilsidesæt med `channels.discord.commands.native: trueřfalseř"auto"`; `false` rydder tidligere registrerede kommandoer. Tekst kommandoer styres af `commands.text` og skal sendes som standalone `/...` beskeder. Brug `commands.useAccessGroups: false` for at omgå access-group tjek for kommandoer.
    - Fuld kommandoliste + konfiguration: [Slash commands](/tools/slash-commands)
11. Valgfri guild konteksthistorik: sæt `channels.discord.historyLimit` (standard 20, falder tilbage til `beskeder. roupChat.historyLimit`) til at inkludere de sidste N guild beskeder som kontekst, når du besvarer en omtale. Sæt `0` til deaktiveret.
12. Reaktioner: agenten kan udløse reaktioner via værktøjet `discord` (styret af `channels.discord.actions.*`).
    - Semantik for fjernelse af reaktioner: se [/tools/reactions](/tools/reactions).
    - Værktøjet `discord` eksponeres kun, når den aktuelle kanal er Discord.
13. Native commands bruger isolerede sessionsnøgler (`agent:<agentId>:discord:slash:<userId>`) frem for den delte `main`-session.

Bemærk: Navn → id opløsning bruger guild medlem søgning og kræver Server Members Intent; hvis bot ikke kan søge medlemmer, bruge id'er eller `<@id>` omtaler.
Bemærk: Snegle er små bogstaver med mellemrum erstattet af `-`. Kanal navne er træg uden den førende `#`.
Bemærk: Guild kontekst `[fra:]` linjer omfatter `author.tag` + `id` for at gøre ping-ready svar let.

## Config-skrivninger

Som standard har Discord tilladelse til at skrive konfigurationsopdateringer udløst af `/config set|unset` (kræver `commands.config: true`).

Deaktivér med:

```json5
{
  channels: { discord: { configWrites: false } },
}
```

## Sådan opretter du din egen bot

Dette er opsætningen i “Discord Developer Portal” for at køre OpenClaw i en server- (guild-)kanal som `#help`.

### 1. Opret Discord-app + botbruger

1. Discord Developer Portal → **Applications** → **New Application**
2. I din app:
   - **Bot** → **Add Bot**
   - Kopiér **Bot Token** (det er dette, du indsætter i `DISCORD_BOT_TOKEN`)

### 2) Aktivér de gateway-intents, OpenClaw har brug for

Discord blokerer “privileged intents”, medmindre du eksplicit aktiverer dem.

I **Bot** → **Privileged Gateway Intents**, aktivér:

- **Message Content Intent** (påkrævet for at læse beskedtekst i de fleste guilds; uden den vil du se “Used disallowed intents”, eller botten vil forbinde men ikke reagere på beskeder)
- **Server Members Intent** (anbefalet; kræves til visse medlem-/brugeropslag og tilladelsesliste-match i guilds)

Du behøver normalt **ikke** **Tilstedeværelse**. Indstilling af bot's egen tilstedeværelse (`setPresence` handling) bruger gateway OP3 og kræver ikke denne hensigt det er kun nødvendigt, hvis du ønsker at modtage tilstedeværelse opdateringer om andre guild medlemmer.

### 3. Generér en invite-URL (OAuth2 URL Generator)

I din app: **OAuth2** → **URL Generator**

**Scopes**

- ✅ `bot`
- ✅ `applications.commands` (påkrævet for native commands)

**Bot Permissions** (minimal basis)

- ✅ View Channels
- ✅ Send Messages
- ✅ Read Message History
- ✅ Embed Links
- ✅ Attach Files
- ✅ Add Reactions (valgfrit men anbefalet)
- ✅ Use External Emojis / Stickers (valgfrit; kun hvis du vil bruge dem)

Undgå **Administrator**, medmindre du debugger og fuldt ud stoler på botten.

Kopiér den genererede URL, åbn den, vælg din server, og installér botten.

### 4. Hent id’erne (guild/bruger/kanal)

Discord bruger numeriske id’er overalt; OpenClaw-konfiguration foretrækker id’er.

1. Discord (desktop/web) → **User Settings** → **Advanced** → aktivér **Developer Mode**
2. Højreklik:
   - Servernavn → **Copy Server ID** (guild-id)
   - Kanal (f.eks. `#help`) → **Kopier Kanal-ID**
   - Din bruger → **Copy User ID**

### 5) Konfigurér OpenClaw

#### Token

Sæt bot-tokenet via env var (anbefalet på servere):

- `DISCORD_BOT_TOKEN=...`

Eller via config:

```json5
{
  channels: {
    discord: {
      enabled: true,
      token: "YOUR_BOT_TOKEN",
    },
  },
}
```

Understøttelse af flere konti: brug `channels.discord.accounts` med tokens pr. konto og valgfri `name`. Se [`gateway/configuration`](/gateway/configuration#telegramaccounts--discordaccounts--slackaccounts--signalaccounts--imessageaccounts) for det delte mønster.

#### Tilladelsesliste + kanal-routing

Eksempel “én server, kun mig tilladt, kun #help tilladt”:

```json5
{
  channels: {
    discord: {
      enabled: true,
      dm: { enabled: false },
      guilds: {
        YOUR_GUILD_ID: {
          users: ["YOUR_USER_ID"],
          requireMention: true,
          channels: {
            help: { allow: true, requireMention: true },
          },
        },
      },
      retry: {
        attempts: 3,
        minDelayMs: 500,
        maxDelayMs: 30000,
        jitter: 0.1,
      },
    },
  },
}
```

Noter:

- `requireMention: true` betyder, at botten kun svarer, når den bliver nævnt (anbefalet i delte kanaler).
- `agents.list[].groupChat.mentionPatterns` (eller `messages.groupChat.mentionPatterns`) tæller også som mentions for guild-beskeder.
- Multi-agent-override: sæt mønstre pr. agent på `agents.list[].groupChat.mentionPatterns`.
- Hvis `channels` er til stede, afvises enhver kanal, der ikke er listet, som standard.
- Brug en `"*"`-kanalpost til at anvende standarder på tværs af alle kanaler; eksplicitte kanalposter tilsidesætter wildcardet.
- Tråde arver forælder kanal config (allowlist, `requireMention`, færdigheder, prompter, etc.) medmindre du tilføjer tråden kanal-id eksplicit.
- Ejer tip: når en per-guild eller per-channel `users` allowlist matcher afsenderen, OpenClaw behandler at afsender som ejer i systemet prompt. For en global ejer på tværs af kanaler, sæt `commands.ownerAllowFrom`.
- Bot-forfattede beskeder ignoreres som standard; sæt `channels.discord.allowBots=true` for at tillade dem (egne beskeder filtreres fortsat).
- Advarsel: Hvis du tillader svar til andre bots (`channels.discord.allowBots=true`), forhindre bot-to-bot svar loops med `requireMention`, `channels.discord.guilds.*.channels.<id>.users` tilladte og/eller klare guardrails i »AGENTS.md« og »SOUL.md«.

### 6. Verificér at det virker

1. Start gateway’en.
2. I din serverkanal, send: `@Krill hello` (eller hvad end dit botnavn er).
3. Hvis der ikke sker noget: tjek **Fejlfinding** nedenfor.

### Fejlfinding

- Først: kør `openclaw doctor` og `openclaw channels status --probe` (handlingsbare advarsler + hurtige audits).
- **“Used disallowed intents”**: aktivér **Message Content Intent** (og sandsynligvis **Server Members Intent**) i Developer Portal, og genstart derefter gateway’en.
- **Botten forbinder men svarer aldrig i en guild-kanal**:
  - Manglende **Message Content Intent**, eller
  - Botten mangler kanaltilladelser (View/Send/Read History), eller
  - Din konfiguration kræver mentions, og du nævnte den ikke, eller
  - Din guild-/kanal-tilladelsesliste afviser kanalen/brugeren.
- **`requireMention: false` men stadig ingen svar**:
- `channels.discord.groupPolicy` defaults til **allowlist**; sæt den til `"open"` eller tilføj en guild post under `channels.discord.guilds` (valgfrit liste kanaler under `channels.discord.guilds.<id>.channels` at begrænse).
  - Hvis du kun indstille `DISCORD_BOT_TOKEN` og aldrig oprette en `channels.discord` sektion, runtime
    standard `groupPolicy` til `open`. Tilføj `channels.discord.groupPolicy`,
    `channels.defaults.groupPolicy`, eller en guild/channel allowlist for at låse den ned.
- `requireMention` skal leve under `channels.discord.guilds` (eller en bestemt kanal). `channels.discord.requireMention` på øverste niveau ignoreres.
- **Tilladelse audits** (`kanal status --probe`) tjek kun numeriske kanal IDs. Hvis du bruger slugs/names som `channels.discord.guilds.*.channels` nøgler, revisionen kan ikke bekræfte tilladelser.
- **DM’er virker ikke**: `channels.discord.dm.enabled=false`, `channels.discord.dm.policy="disabled"`, eller du er endnu ikke godkendt (`channels.discord.dm.policy="pairing"`).
- **Exec godkendelser i Discord**: Discord understøtter en **knap UI** for exec godkendelser i DMs (Tillad en gang / Altid tillade / Deny). `/Godkend <id> ...` er kun til videresendte godkendelser og vil ikke løse Discord's knap prompter. Hvis du ser `❌ Mislykkedes at indsende godkendelse: Fejl: ukendt godkendelse id` eller UI aldrig dukker op, tjek:
  - `channels.discord.execApprovals.enabled: true` i din config.
  - At dit Discord-bruger-id er listet i `channels.discord.execApprovals.approvers` (UI’et sendes kun til godkendere).
  - Brug knapperne i DM-prompten (**Allow once**, **Always allow**, **Deny**).
  - Se [Exec approvals](/tools/exec-approvals) og [Slash commands](/tools/slash-commands) for den bredere godkendelses- og kommandoflow.

## Funktioner & begrænsninger

- DM’er og guild-tekstkanaler (tråde behandles som separate kanaler; voice understøttes ikke).
- Typing-indikatorer sendes best effort; beskedopdeling bruger `channels.discord.textChunkLimit` (standard 2000) og splitter lange svar efter linjeantal (`channels.discord.maxLinesPerMessage`, standard 17).
- Valgfri newline-opdeling: sæt `channels.discord.chunkMode="newline"` for at splitte ved tomme linjer (afsnitsgrænser) før længdeopdeling.
- Filuploads understøttes op til den konfigurerede `channels.discord.mediaMaxMb` (standard 8 MB).
- Mention-styrede guild-svar som standard for at undgå støjende bots.
- Svarskontekst injiceres, når en besked refererer til en anden besked (citeret indhold + id’er).
- Native reply-threading er **slået fra som standard**; aktivér med `channels.discord.replyToMode` og reply-tags.

## Retry-politik

Outbound Discord API opkald prøve igen på hastighedsgrænser (429) ved hjælp af Discord `retry_after` når det er tilgængeligt, med eksponentiel backoff og jitter. Konfigurer via `channels.discord.retry`. Se [Prøv igen](/concepts/retry).

## Konfiguration

```json5
{
  channels: {
    discord: {
      enabled: true,
      token: "abc.123",
      groupPolicy: "allowlist",
      guilds: {
        "*": {
          channels: {
            general: { allow: true },
          },
        },
      },
      mediaMaxMb: 8,
      actions: {
        reactions: true,
        stickers: true,
        emojiUploads: true,
        stickerUploads: true,
        polls: true,
        permissions: true,
        messages: true,
        threads: true,
        pins: true,
        search: true,
        memberInfo: true,
        roleInfo: true,
        roles: false,
        channelInfo: true,
        channels: true,
        voiceStatus: true,
        events: true,
        moderation: false,
        presence: false,
      },
      replyToMode: "off",
      dm: {
        enabled: true,
        policy: "pairing", // pairing | allowlist | open | disabled
        allowFrom: ["123456789012345678", "steipete"],
        groupEnabled: false,
        groupChannels: ["openclaw-dm"],
      },
      guilds: {
        "*": { requireMention: true },
        "123456789012345678": {
          slug: "friends-of-openclaw",
          requireMention: false,
          reactionNotifications: "own",
          users: ["987654321098765432", "steipete"],
          channels: {
            general: { allow: true },
            help: {
              allow: true,
              requireMention: true,
              users: ["987654321098765432"],
              skills: ["search", "docs"],
              systemPrompt: "Keep answers short.",
            },
          },
        },
      },
    },
  },
}
```

Ack reaktioner styres globalt via `messages.ackReaction` +
`messages.ackReactionScope`. Brug `messages.removeAckAfterReply` for at rydde
ack reaktion efter bot svar.

- `dm.enabled`: sæt `false` for at ignorere alle DM’er (standard `true`).
- `dm.policy`: DM access control (`pairing` anbefalet). `"open"` kræver `dm.allowFrom=["*"]`.
- `dm.allowFrom`: DM tilladt liste (brugernavne eller navne). Brugt af `dm.policy="allowlist"` og for `dm.policy="open"` validation. Guiden accepterer brugernavne og løser dem til id'er, når botten kan søge medlemmer.
- `dm.groupEnabled`: aktivér gruppe-DM’er (standard `false`).
- `dm.groupChannels`: valgfri tilladelsesliste for gruppe-DM-kanal-id’er eller slugs.
- `groupPolicy`: styrer håndtering af guild-kanaler (`open|disabled|allowlist`); `allowlist` kræver kanal-tilladelseslister.
- `guilds`: regler pr. guild med nøgle efter guild-id (foretrukket) eller slug.
- `guilds."*"`: standardindstillinger pr. guild, anvendt når der ikke findes en eksplicit post.
- `guilds.<id>.slug`: valgfri venlig slug brugt til visning af navne.
- `guilds.<id>.users`: valgfri per-guild bruger tilladt liste (ids eller navne).
- `guilds.<id>.tools`: valgfri per-guild tool policy overrides (`allow`/`deny`/`alsoAllow`) bruges, når kanalen override mangler.
- `guilds.<id>.toolsBySender`: valgfri per-sender værktøj politik tilsidesætter på guild niveau (gælder når kanalen tilsidesættelse mangler; `"*"` wildcard understøttet).
- `guilds.<id>.channels.<channel>.allow`: tillad/afvis kanalen, når `groupPolicy="allowlist"`.
- `guilds.<id>.channels.<channel>.requireMention`: mention-gating for kanalen.
- `guilds.<id>.channels.<channel>.tools`: valgfrie pr.-kanal værktøjspolitik-overskrivninger (`allow`/`deny`/`alsoAllow`).
- `guilds.<id>.channels.<channel>.toolsBySender`: valgfri per-sender værktøj politik tilsidesættelser i kanalen (`"*"` jokertegn understøttet).
- `guilds.<id>.channels.<channel>.users`: valgfri pr.-kanal bruger-tilladelsesliste.
- `guilds.<id>.channels.<channel>.skills`: skill-filter (udeladt = alle Skills, tom = ingen).
- `guilds.<id>.channels.<channel>.systemPrompt`: ekstra systemprompt for kanalen. Discord kanal emner injiceres som \*\*ikke-betroede \*\* kontekst (ikke system prompt).
- `guilds.<id>.channels.<channel>.enabled`: sæt `false` for at deaktivere kanalen.
- `guilds.<id>.channels`: kanal regler (nøgler er kanal snegle eller ids).
- `guilds.<id>.requireMention`: per-guild nævne krav (overridable per kanal).
- `guilds.<id>.reactionNotifications`: reaction system event mode (`off`, `own`, `all`, `allowlist`).
- `textChunkLimit`: udgående tekst chunk størrelse (tegn). Standard: 2000.
- `chunkMode`: `length` (standard) splitter kun, når `textChunkLimit` overskrides; `newline` splitter ved tomme linjer (afsnitsgrænser) før længdeopdeling.
- `maxLinesPerMessage`: soft max linjeantal pr. besked. Standard: 17.
- `mediaMaxMb`: begræns indgående medier gemt på disk.
- `historyLimit`: antal seneste guild-beskeder, der inkluderes som kontekst ved svar på en mention (standard 20; falder tilbage til `messages.groupChat.historyLimit`; `0` deaktiverer).
- `dmHistoryLimit`: DM historik grænse i bruger sving. Per-user tilsidesættelser: `dms["<user_id>"].historyLimit`.
- `retry`: retry-politik for udgående Discord API-kald (forsøg, minDelayMs, maxDelayMs, jitter).
- `pluralkit`: opløs PluralKit-proxyede beskeder, så systemmedlemmer fremstår som distinkte afsendere.
- `actions`: pr.-handling værktøjs-gates; udelad for at tillade alle (sæt `false` for at deaktivere).
  - `reactions` (dækker react + læs reaktioner)
  - `stickers`, `emojiUploads`, `stickerUploads`, `polls`, `permissions`, `messages`, `threads`, `pins`, `search`
  - `memberInfo`, `roleInfo`, `channelInfo`, `voiceStatus`, `events`
  - `channels` (opret/redigér/slet kanaler + kategorier + tilladelser)
  - `roles` (rolle tilføj/fjern, standard `false`)
  - `moderation` (timeout/kick/ban, standard `false`)
  - `presence` (bot-status/aktivitet, standard `false`)
- `execApprovals`: Discord-only exec approval DMs (knap UI). Understøtter `aktiveret`, `approvers`, `agentFilter`, `sessionFilter`.

Reaktionsnotifikationer bruger 'guilds.<id>.reaktionMeddelelser«:

- `off`: ingen reaktions-events.
- `own`: reaktioner på bottens egne beskeder (standard).
- `all`: alle reaktioner på alle beskeder.
- `allowlist`: reaktioner fra `guilds.<id>.users` på alle beskeder (tomme liste deaktiverer).

### PluralKit (PK)-understøttelse

Aktiver PK opslag så proxied beskeder løse til det underliggende system + medlem.
Når aktiveret, bruger OpenClaw medlemsidentiteten til tilladte lister og etiketter
afsenderen som `medlem (PK:System)` for at undgå tilfældige Discord pings.

```json5
{
  channels: {
    discord: {
      pluralkit: {
        enabled: true,
        token: "pk_live_...", // optional; required for private systems
      },
    },
  },
}
```

Tilladelsesliste-noter (PK-aktiveret):

- Brug `pk:<memberId>` i `dm.allowFrom`, `guilds.<id>.users`, eller per-kanal `brugere`.
- Medlemmers visningsnavne matches også efter navn/slug.
- Opslag bruger **den originale** Discord-besked-id (før proxy), så
  PK-API’et opløser den kun inden for sit 30-minutters vindue.
- Hvis PK opslag mislykkes (fx, privat system uden et token), proxied beskeder
  behandles som bot beskeder og tabes medmindre `channels.discord.allowBots=true`.

### Standarder for værktøjshandlinger

| Handlingsgruppe | Standard | Noter                                                 |
| --------------- | -------- | ----------------------------------------------------- |
| reactions       | enabled  | React + list reactions + emojiList                    |
| stickers        | enabled  | Send stickers                                         |
| emojiUploads    | enabled  | Upload emojis                                         |
| stickerUploads  | enabled  | Upload stickers                                       |
| polls           | enabled  | Opret afstemninger                                    |
| permissions     | enabled  | Kanal-tilladelsessnapshot                             |
| messages        | enabled  | Læs/send/redigér/slet                                 |
| threads         | enabled  | Opret/list/svar                                       |
| pins            | enabled  | Fastgør/ophæv/list                                    |
| search          | enabled  | Beskedsøgning (preview-funktion)   |
| memberInfo      | enabled  | Medlemsinfo                                           |
| roleInfo        | enabled  | Rolleliste                                            |
| channelInfo     | enabled  | Kanalinfo + liste                                     |
| channels        | enabled  | Kanal-/kategoristyring                                |
| voiceStatus     | enabled  | Voice state-opslag                                    |
| events          | enabled  | List/opret planlagte events                           |
| roles           | disabled | Rolle tilføj/fjern                                    |
| moderation      | disabled | Timeout/kick/ban                                      |
| presence        | disabled | Bot-status/aktivitet (setPresence) |

- `replyToMode`: `off` (standard), `first`, eller `all`. Gælder kun, når modellen indeholder et svarmærke.

## Reply-tags

For at anmode om et trådet svar kan modellen inkludere ét tag i sit output:

- `[[reply_to_current]]` — svar på den udløsende Discord-besked.
- `[[reply_to:<id>]]` — svar på et specifikt meddelelses-id fra kontekst/historik.
  Nuværende besked id tilføjes til at spørge som `[message_id: …]`; historik poster indeholder allerede ids.

Adfærd styres af `channels.discord.replyToMode`:

- `off`: ignorér tags.
- `first`: kun den første udgående chunk/vedhæftning er et svar.
- `all`: hver udgående chunk/vedhæftning er et svar.

Noter om tilladelsesliste-match:

- `allowFrom`/`users`/`groupChannels` accepterer id’er, navne, tags eller mentions som `<@id>`.
- Præfikser som `discord:`/`user:` (brugere) og `channel:` (gruppe-DM’er) understøttes.
- Brug `*` for at tillade enhver afsender/kanal.
- Når `guilds.<id>.channels` er til stede, kanaler der ikke er listet nægtes som standard.
- Når `guilds.<id>.channels` er udeladt, alle kanaler i den tilladte guild er tilladt.
- For at tillade **ingen kanaler**, sæt `channels.discord.groupPolicy: "disabled"` (eller behold en tom tilladelsesliste).
- Opsætningsguiden accepterer `Guild/Channel`-navne (offentlige + private) og opløser dem til id’er, når det er muligt.
- Ved opstart opløser OpenClaw kanal-/brugernavne i tilladelseslister til id’er (når botten kan søge medlemmer)
  og logger mappingen; uopløste poster bevares som indtastet.

Noter om native commands:

- De registrerede kommandoer spejler OpenClaws chatkommandoer.
- Native commands respekterer de samme tilladelseslister som DM’er/guild-beskeder (`channels.discord.dm.allowFrom`, `channels.discord.guilds`, pr.-kanal-regler).
- Slash commands kan stadig være synlige i Discord-UI’et for brugere, der ikke er på tilladelseslisten; OpenClaw håndhæver tilladelseslister ved udførsel og svarer “not authorized”.

## Værktøjshandlinger

Agenten kan kalde `discord` med handlinger som:

- `react` / `reactions` (tilføj eller list reaktioner)
- `sticker`, `poll`, `permissions`
- `readMessages`, `sendMessage`, `editMessage`, `deleteMessage`
- Read/search/pin-værktøjspayloads inkluderer normaliserede `timestampMs` (UTC epoch ms) og `timestampUtc` sammen med rå Discord `timestamp`.
- `threadCreate`, `threadList`, `threadReply`
- `pinMessage`, `unpinMessage`, `listPins`
- `searchMessages`, `memberInfo`, `roleInfo`, `roleAdd`, `roleRemove`, `emojiList`
- `channelInfo`, `channelList`, `voiceStatus`, `eventList`, `eventCreate`
- `timeout`, `kick`, `ban`
- `setPresence` (bot-aktivitet og online-status)

Discord besked id'er er dukket op i den injicerede sammenhæng (`[discord besked id: …]` og historie linjer), så agenten kan målrette dem.
Emoji kan være unicode (f.eks. `✅`) eller brugerdefineret emoji syntaks som `<:party_blob:1234567890>`.

## Sikkerhed & drift

- Behandl bot-tokenet som en adgangskode; foretræk `DISCORD_BOT_TOKEN`-env var på overvågede værter, eller lås konfigurationsfilens tilladelser ned.
- Giv kun botten de tilladelser, den har brug for (typisk Read/Send Messages).
- Hvis botten sidder fast eller er rate limited, genstart gateway’en (`openclaw gateway --force`) efter at have bekræftet, at ingen andre processer ejer Discord-sessionen.
