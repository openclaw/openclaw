---
summary: "Status, funktioner och konfiguration för Discord-botstöd"
read_when:
  - Arbetar med funktioner för Discord-kanalen
title: "Discord"
---

# Discord (Bot API)

Status: redo för DM och textkanaler i guild via den officiella Discord-botgatewayen.

## Snabbstart (nybörjare)

1. Skapa en Discord-bot och kopiera bottoken.
2. I Discord-appens inställningar, aktivera **Message Content Intent** (och **Server Members Intent** om du planerar att använda tillåtelselistor eller namnuppslag).
3. Ställ in token för OpenClaw:
   - Env: `DISCORD_BOT_TOKEN=...`
   - Eller konfig: `channels.discord.token: "..."`.
   - Om båda är inställda har konfig företräde (env-reserv gäller endast standardkontot).
4. Bjud in boten till din server med meddelanderättigheter (skapa en privat server om du bara vill använda DM).
5. Starta gatewayen.
6. DM-åtkomst är parning som standard; godkänn parningskoden vid första kontakten.

Minimal konfig:

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

- Prata med OpenClaw via Discord-DM eller guild-kanaler.
- Direktchattar kollapsar till agentens huvudsession (standard `agent:main:main`); guild-kanaler förblir isolerade som `agent:<agentId>:discord:channel:<channelId>` (visningsnamn använder `discord:<guildSlug>#<channelSlug>`).
- Grupp-DM ignoreras som standard; aktivera via `channels.discord.dm.groupEnabled` och begränsa valfritt med `channels.discord.dm.groupChannels`.
- Håll routning deterministisk: svar går alltid tillbaka till kanalen de kom in på.

## Hur det fungerar

1. Skapa en Discord-applikation → Bot, aktivera de intents du behöver (DM + guild-meddelanden + meddelandeinnehåll) och hämta bottoken.
2. Bjud in boten till din server med de behörigheter som krävs för att läsa/skicka meddelanden där du vill använda den.
3. Konfigurera OpenClaw med `channels.discord.token` (eller `DISCORD_BOT_TOKEN` som reserv).
4. Kör gatewayen; den startar automatiskt Discord-kanalen när en token finns tillgänglig (konfig först, env-reserv) och `channels.discord.enabled` inte är `false`.
   - Om du föredrar miljövariabler, sätt `DISCORD_BOT_TOKEN` (ett konfigblock är valfritt).
5. Direktchatt: använd `user:<id>` (eller en `<@id>` nämnd) när du levererar; alla varvar landar i den delade `main`-sessionen. Bare numeriska ID är tvetydiga och avvisade.
6. Guild kanaler: använd `channel:<channelId>` för leverans. Omnämningar krävs som standard och kan ställas in per guild eller per kanal.
7. Direktchatt: säkra som standard via `channels.discord.dm.policy` (standard: `"parning"`). Okända avsändare får en parningskod (löper ut efter 1 timme); godkänner via `openclaw parkoppling godkänna discord <code>`.
   - För att behålla äldre ”öppen för alla”-beteende: sätt `channels.discord.dm.policy="open"` och `channels.discord.dm.allowFrom=["*"]`.
   - För strikt tillåtelselista: sätt `channels.discord.dm.policy="allowlist"` och lista avsändare i `channels.discord.dm.allowFrom`.
   - För att ignorera alla DM: sätt `channels.discord.dm.enabled=false` eller `channels.discord.dm.policy="disabled"`.
8. Grupp-DM ignoreras som standard; aktivera via `channels.discord.dm.groupEnabled` och begränsa valfritt med `channels.discord.dm.groupChannels`.
9. Valfria guild-regler: sätt `channels.discord.guilds` nycklade per guild-id (föredraget) eller slug, med regler per kanal.
10. Valfria inhemska kommandon: `commands.native` defaults to `"auto"` (på för Discord/Telegram, off for Slack). Åsidosätt med `channels.discord.commands.native: true<unk> false<unk> "auto"`; `false` rensar tidigare registrerade kommandon. Textkommandon kontrolleras av `commands.text` och måste skickas som fristående `/...` meddelanden. Använd `commands.useAccessGroups: false` för att förbigå access-gruppskontroller efter kommandon.
    - Fullständig kommandolista + konfig: [Slash commands](/tools/slash-commands)
11. Valfri guild kontexthistorik: sätt `channels.discord.historyLimit` (standard 20, faller tillbaka till `messages. roupChat.historyLimit`) att inkludera de sista N guild meddelanden som sammanhang när du svarar på ett omnämnande. Sätt `0` till att inaktivera.
12. Reaktioner: agenten kan trigga reaktioner via verktyget `discord` (styrt av `channels.discord.actions.*`).
    - Semantik för borttagning av reaktioner: se [/tools/reactions](/tools/reactions).
    - Verktyget `discord` exponeras endast när den aktuella kanalen är Discord.
13. Inbyggda kommandon använder isolerade sessionsnycklar (`agent:<agentId>:discord:slash:<userId>`) snarare än den delade `main`-sessionen.

Obs: Namn → id resolution använder guild medlems sökning och kräver Server Medlemmar Intent; om boten inte kan söka medlemmar, använd ID eller `<@id>` omnämnanden.
Obs: Slugs är gemener med mellanslag som ersätts med `-`. Kanalnamn är sluggade utan ledande `#`.
Obs: Guild context `[från:]` rader inkluderar `author.tag` + `id` för att göra ping-ready svar lätt.

## Konfigskrivningar

Som standard tillåts Discord att skriva konfiguppdateringar som triggas av `/config set|unset` (kräver `commands.config: true`).

Inaktivera med:

```json5
{
  channels: { discord: { configWrites: false } },
}
```

## Hur du skapar din egen bot

Detta är inställningen i ”Discord Developer Portal” för att köra OpenClaw i en serverkanal (guild) som `#help`.

### 1. Skapa Discord-appen + botanvändare

1. Discord Developer Portal → **Applications** → **New Application**
2. I din app:
   - **Bot** → **Add Bot**
   - Kopiera **Bot Token** (detta är vad du anger i `DISCORD_BOT_TOKEN`)

### 2) Aktivera gateway-intents som OpenClaw behöver

Discord blockerar ”privileged intents” om du inte uttryckligen aktiverar dem.

I **Bot** → **Privileged Gateway Intents**, aktivera:

- **Message Content Intent** (krävs för att läsa meddelandetext i de flesta guilds; utan den ser du ”Used disallowed intents” eller så ansluter boten men reagerar inte på meddelanden)
- **Server Members Intent** (rekommenderas; krävs för vissa medlems-/användaruppslag och matchning mot tillåtelselistor i guilds)

Du behöver vanligtvis **inte** **Presence Intent**. Ställa in botens egen närvaro (`setPresence` åtgärd) använder gateway OP3 och kräver inte denna avsikt; det behövs bara om du vill få närvarouppdateringar om andra guildmedlemmar.

### 3. Generera en inbjudnings-URL (OAuth2 URL Generator)

I din app: **OAuth2** → **URL Generator**

**Scopes**

- ✅ `bot`
- ✅ `applications.commands` (krävs för inbyggda kommandon)

**Botbehörigheter** (minsta baslinje)

- ✅ Visa kanaler
- ✅ Skicka meddelanden
- ✅ Läs meddelandehistorik
- ✅ Bädda in länkar
- ✅ Bifoga filer
- ✅ Lägg till reaktioner (valfritt men rekommenderat)
- ✅ Använd externa emojis / stickers (valfritt; endast om du vill ha dem)

Undvik **Administrator** om du inte felsöker och fullt ut litar på boten.

Kopiera den genererade URL:en, öppna den, välj din server och installera boten.

### 4. Hämta id:n (guild/användare/kanal)

Discord använder numeriska id:n överallt; OpenClaw-konfig föredrar id:n.

1. Discord (desktop/webb) → **User Settings** → **Advanced** → aktivera **Developer Mode**
2. Högerklicka:
   - Servernamn → **Copy Server ID** (guild-id)
   - Kanal (t.ex. `#help`) → **Kopiera kanal-ID**
   - Din användare → **Copy User ID**

### 5) Konfigurera OpenClaw

#### Token

Sätt bottoken via miljövariabel (rekommenderat på servrar):

- `DISCORD_BOT_TOKEN=...`

Eller via konfig:

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

Stöd för flera konton: använd `channels.discord.accounts` med per-konto-token och valfri `name`. Se [`gateway/configuration`](/gateway/configuration#telegramaccounts--discordaccounts--slackaccounts--signalaccounts--imessageaccounts) för det delade mönstret.

#### Tillåtelselista + kanalroutning

Exempel ”en server, tillåt bara mig, tillåt bara #help”:

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

Noteringar:

- `requireMention: true` betyder att boten bara svarar när den omnämns (rekommenderas för delade kanaler).
- `agents.list[].groupChat.mentionPatterns` (eller `messages.groupChat.mentionPatterns`) räknas också som omnämningar för guild-meddelanden.
- Överstyrning för flera agenter: sätt per-agent-mönster på `agents.list[].groupChat.mentionPatterns`.
- Om `channels` finns, nekas alla kanaler som inte listas som standard.
- Använd en `"*"`-kanalpost för att tillämpa standarder över alla kanaler; explicita kanalposter åsidosätter jokertecknet.
- Trådar ärver överordnad kanal konfiguration (tillåten lista, `requireMention`, färdigheter, uppmaningar, etc.) om du inte lägger till trådens kanal-id explicit.
- Ägare tips: när en per-guild eller per-channel `users` allowlist matchar avsändaren, behandlar OpenClaw den avsändaren som ägare i systemprompten. För en global ägare över kanaler, sätt `commands.ownerAllowFrom`.
- Meddelanden skrivna av boten ignoreras som standard; sätt `channels.discord.allowBots=true` för att tillåta dem (egna meddelanden filtreras fortfarande).
- Varning: Om du tillåter svar på andra robotar (`channels.discord.allowBots=true`), förhindra bot-to-bot svar loopar med `requireMention`, `channels.discord.guilds.*.channels.<id>.users` tillåter listor, och/eller klara skyddsräcken i `AGENTS.md` och `SOUL.md`.

### 6. Verifiera att det fungerar

1. Starta gatewayen.
2. I din serverkanal, skicka: `@Krill hello` (eller vad din bot nu heter).
3. Om inget händer: kontrollera **Felsökning** nedan.

### Felsökning

- Först: kör `openclaw doctor` och `openclaw channels status --probe` (åtgärdsbara varningar + snabba granskningar).
- **”Used disallowed intents”**: aktivera **Message Content Intent** (och troligen **Server Members Intent**) i Developer Portal och starta sedan om gatewayen.
- **Boten ansluter men svarar aldrig i en guild-kanal**:
  - Saknar **Message Content Intent**, eller
  - Boten saknar kanalbehörigheter (Visa/Skicka/Läs historik), eller
  - Din konfig kräver omnämningar och du omnämnde den inte, eller
  - Din guild-/kanaltillåtelselista nekar kanalen/användaren.
- **`requireMention: false` men fortfarande inga svar**:
- `channels.discord.groupPolicy` defaults to **allowlist**; set it to `"open"` eller add a guild entry under `channels.discord.guilds` (valfritt lista kanaler under `channels.discord.guilds.<id>.channels` att begränsa).
  - Om du bara anger `DISCORD_BOT_TOKEN` och aldrig skapar en `channels.discord`-sektion, är runtime
    standardinställningen `groupPolicy` till `open`. Lägg till `channels.discord.groupPolicy`,
    `channels.defaults.groupPolicy`, eller en guild/channel allowlist för att låsa ner den.
- `requireMention` måste leva under `channels.discord.guilds` (eller en specifik kanal). `channels.discord.requireMention` på den översta nivån ignoreras.
- **Behörighetsgranskningar** (`kanalstatus --probe`) kontrollera endast numeriska kanal-ID. Om du använder sniglar/namn som `channels.discord.guilds.*.channels`-nycklar, kan revisionen inte verifiera behörigheter.
- **DM fungerar inte**: `channels.discord.dm.enabled=false`, `channels.discord.dm.policy="disabled"`, eller så har du ännu inte blivit godkänd (`channels.discord.dm.policy="pairing"`).
- **Exec-godkännanden i Discord**: Discord stöder en **knapp-UI** för exec-godkännanden i DMs (Tillåt en gång / Tillåt alltid / neka). `/approve <id> ...` är bara för vidarebefordrade godkännanden och kommer inte att lösa Discords knappmeddelanden. Om du ser `❌ Misslyckades att skicka in godkännande: Fel: okänt godkännande-id` eller UI dyker aldrig upp, kontroll:
  - `channels.discord.execApprovals.enabled: true` i din konfig.
  - Att ditt Discord-användar-id finns listat i `channels.discord.execApprovals.approvers` (UI:t skickas endast till godkännare).
  - Använd knapparna i DM-prompten (**Tillåt en gång**, **Tillåt alltid**, **Neka**).
  - Se [Exec approvals](/tools/exec-approvals) och [Slash commands](/tools/slash-commands) för det bredare godkännande- och kommandoflödet.

## Funktioner och begränsningar

- DM och textkanaler i guild (trådar behandlas som separata kanaler; röst stöds inte).
- Skrivindikatorer skickas bäst-effort; meddelandeuppdelning använder `channels.discord.textChunkLimit` (standard 2000) och delar långa svar efter radantal (`channels.discord.maxLinesPerMessage`, standard 17).
- Valfri radbrytningsuppdelning: sätt `channels.discord.chunkMode="newline"` för att dela på tomrader (styckegränser) före längduppdelning.
- Filuppladdningar stöds upp till den konfigurerade `channels.discord.mediaMaxMb` (standard 8 MB).
- Omnämningsstyrda guild-svar som standard för att undvika högljudda botar.
- Svarskontext injiceras när ett meddelande refererar till ett annat meddelande (citerat innehåll + id:n).
- Inbyggd svarstrådning är **av som standard**; aktivera med `channels.discord.replyToMode` och svarstaggar.

## Försökspolicy

Utgående Discords API-anrop återförsök på hastighetsgränser (429) med Discord `retry_after` när det är tillgängligt, med exponentiell backoff och jitter. Konfigurera via `channels.discord.retry`. Se [Försök igen policy](/concepts/retry).

## Konfig

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

Ack reaktioner kontrolleras globalt via `messages.ackReaction` +
`messages.ackReactionScope`. Använd `messages.removeAckAfterReply` för att rensa
ack-reaktionen efter att botten svarat.

- `dm.enabled`: sätt `false` för att ignorera alla DM (standard `true`).
- `dm.policy`: DM åtkomstkontroll (`parning` rekommenderas). `"open"` kräver `dm.allowFrom=["*"]`.
- `dm.allowFrom`: DM allowlist (användar-ID eller namn). Används av `dm.policy="allowlist"` och för `dm.policy="open"` validering. Guiden accepterar användarnamn och löser dem till ids när bot kan söka medlemmar.
- `dm.groupEnabled`: aktivera grupp-DM (standard `false`).
- `dm.groupChannels`: valfri tillåtelselista för grupp-DM-kanal-id:n eller slugs.
- `groupPolicy`: styr hantering av guild-kanaler (`open|disabled|allowlist`); `allowlist` kräver kanaltillåtelselistor.
- `guilds`: per-guild-regler nycklade per guild-id (föredraget) eller slug.
- `guilds."*"`: standardinställningar per guild som tillämpas när ingen explicit post finns.
- `guilds.<id>.slug`: valfri vänlig slug som används för visningsnamn.
- `guilds.<id>.users`: valfria per-guild användare allowlist (ID eller namn).
- `guilds.<id>.tools`: valfri policy för per-guild overrides (`allow`/`deny`/`alsoAllow`) som används när kanalen override saknas.
- `guilds.<id>.toolsBySender`: valfri policy för per-sender åsidosätter på guild nivå (gäller när kanalöverskridande saknas; `"*"` wildcard stöds).
- `guilds.<id>.kanaler.<channel>.allow`: tillåt/nekad kanalen när `groupPolicy="allowlist"`.
- `guilds.<id>.kanaler.<channel>.requireMention`: omnämnandespärr för kanalen.
- `guilds.<id>.kanaler.<channel>.tools`: valfria verktygspolicy-åsidosättningar per kanal (`allow`/`deny`/`alsoAllow`).
- `guilds.<id>.kanaler.<channel>.toolsBySender`: valfri policy för per-sender åsidosätter i kanalen (`"*"` wildcard stöds).
- `guilds.<id>.kanaler.<channel>.users`: valfri användar-tillåtelselista per kanal.
- `guilds.<id>.kanaler.<channel>.skills`: färdighetsfilter (utelämna = alla Skills, tom = inga).
- `guilds.<id>.kanaler.<channel>.systemPrompt`: extra systemprompt för kanalen. Discord-kanaltrådar injiceras som **opålitliga** sammanhang (inte systemprompt).
- `guilds.<id>.kanaler.<channel>.enabled`: sätt `false` för att inaktivera kanalen.
- `guilds.<id>.channels`: kanalregler (nycklar är kanalsniglar eller ids).
- `guilds.<id>.requireNämn `: per guild nämna krav (overridable per kanal).
- `guilds.<id>.reactionNotifications`: reaktionssystemets händelse-läge (`off`, `own`, `all`, `allowlist`).
- `textChunkLimit`: utgående textdatablockstorlek (tecken). Standard: 2000.
- `chunkMode`: `length` (standard) delar endast när `textChunkLimit` överskrids; `newline` delar på tomrader (styckegränser) före längduppdelning.
- `maxLinesPerMessage`: mjuk maxantal per meddelande. Standard: 17.
- `mediaMaxMb`: kläm inkommande media som sparas på disk.
- `historyLimit`: antal senaste guild-meddelanden att inkludera som kontext när man svarar på en omnämning (standard 20; faller tillbaka till `messages.groupChat.historyLimit`; `0` inaktiverar).
- `dmHistoryLimit`: DM historikgräns i användarens varv. Åsidosättningar per användare: `dms["<user_id>"].historyLimit`.
- `retry`: försökspolicy för utgående Discord API-anrop (försök, minDelayMs, maxDelayMs, jitter).
- `pluralkit`: lös PluralKit-proxyade meddelanden så att systemmedlemmar framstår som distinkta avsändare.
- `actions`: per-åtgärd verktygsgrindar; utelämna för att tillåta alla (sätt `false` för att inaktivera).
  - `reactions` (täcker reagera + läsa reaktioner)
  - `stickers`, `emojiUploads`, `stickerUploads`, `polls`, `permissions`, `messages`, `threads`, `pins`, `search`
  - `memberInfo`, `roleInfo`, `channelInfo`, `voiceStatus`, `events`
  - `channels` (skapa/redigera/ta bort kanaler + kategorier + behörigheter)
  - `roles` (lägg till/ta bort roller, standard `false`)
  - `moderation` (timeout/kick/ban, standard `false`)
  - `presence` (botstatus/aktivitet, standard `false`)
- `execApprovals`: Discord-only exec godkännande DMs (knapp UI). Stöder `enabled`, `approvers`, `agentFilter`, `sessionFilter`.

Reaktionsnotifikationer använder `guilds.<id>.reaktionNotiser`:

- `off`: inga reaktionshändelser.
- `own`: reaktioner på botens egna meddelanden (standard).
- `all`: alla reaktioner på alla meddelanden.
- `allowlist`: reaktioner från `guilds.<id>.users` på alla meddelanden (tom lista inaktiveras).

### PluralKit (PK)-stöd

Aktivera PK uppslagningar så att proxied meddelanden lösa till det underliggande systemet + medlem.
När den är aktiverad använder OpenClaw medlemsidentiteten för tillåtna listor och etiketterar
avsändaren som `Member (PK:System)` för att undvika oavsiktliga Discord-pingar.

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

Noteringar om tillåtelselista (PK aktiverat):

- Använd `pk:<memberId>` i `dm.allowFrom`, `guilds.<id>.users`, eller per kanal `users`.
- Medlemmars visningsnamn matchas också på namn/slug.
- Uppslag använder det **ursprungliga** Discord-meddelande-id:t (före proxy), så PK-API:t löser det endast inom sitt 30-minutersfönster.
- Om PK-uppslag misslyckas (t.ex. privat system utan token) behandlas proxyade meddelanden som botmeddelanden och släpps inte igenom om inte `channels.discord.allowBots=true`.

### Standardvärden för verktygsåtgärder

| Åtgärdsgrupp   | Standard | Noteringar                                              |
| -------------- | -------- | ------------------------------------------------------- |
| reactions      | enabled  | Reagera + lista reaktioner + emojiList                  |
| stickers       | enabled  | Skicka stickers                                         |
| emojiUploads   | enabled  | Ladda upp emojis                                        |
| stickerUploads | enabled  | Ladda upp stickers                                      |
| polls          | enabled  | Skapa omröstningar                                      |
| permissions    | enabled  | Ögonblicksbild av kanalbehörigheter                     |
| messages       | enabled  | Läs/skicka/redigera/ta bort                             |
| threads        | enabled  | Skapa/lista/svara                                       |
| pins           | enabled  | Fäst/lossa/lista                                        |
| search         | enabled  | Meddelandesökning (förhandsfunktion) |
| memberInfo     | enabled  | Medlemsinfo                                             |
| roleInfo       | enabled  | Rollista                                                |
| channelInfo    | enabled  | Kanalinfo + lista                                       |
| channels       | enabled  | Kanal-/kategorihantering                                |
| voiceStatus    | enabled  | Uppslag av röststatus                                   |
| events         | enabled  | Lista/skapa schemalagda händelser                       |
| roles          | disabled | Lägg till/ta bort roller                                |
| moderation     | disabled | Timeout/kick/ban                                        |
| presence       | disabled | Botstatus/aktivitet (setPresence)    |

- `replyToMode`: `off` (standard), `first`, eller `all`. Gäller endast när modellen innehåller en svarstagg.

## Svarstaggar

För att begära ett trådat svar kan modellen inkludera en tagg i sin utdata:

- `[[reply_to_current]]` — svara på det utlösande Discord-meddelandet.
- `[[reply_to:<id>]]` — svara på ett specifikt meddelande-id från kontext/historik.
  Nuvarande meddelande-id läggs till i uppmaningar som `[message_id: …]`; historik poster innehåller redan ids.

Beteendet styrs av `channels.discord.replyToMode`:

- `off`: ignorera taggar.
- `first`: endast första utgående stycket/bilagan är ett svar.
- `all`: varje utgående stycke/bilaga är ett svar.

Noteringar om matchning av tillåtelselista:

- `allowFrom`/`users`/`groupChannels` accepterar id:n, namn, taggar eller omnämningar som `<@id>`.
- Prefix som `discord:`/`user:` (användare) och `channel:` (grupp-DM) stöds.
- Använd `*` för att tillåta vilken avsändare/kanal som helst.
- När `guilds.<id>.channels` är närvarande, kanaler som inte anges nekas som standard.
- När `guilds.<id>.channels` utelämnas, alla kanaler i den tillåtna guilden är tillåtna.
- För att tillåta **inga kanaler**, sätt `channels.discord.groupPolicy: "disabled"` (eller behåll en tom tillåtelselista).
- Konfigurationsguiden accepterar `Guild/Channel`-namn (offentliga + privata) och löser dem till id:n när möjligt.
- Vid start löser OpenClaw kanal-/användarnamn i tillåtelselistor till id:n (när boten kan söka medlemmar) och loggar mappningen; olösta poster behålls som de är skrivna.

Noteringar om inbyggda kommandon:

- De registrerade kommandona speglar OpenClaws chattkommandon.
- Inbyggda kommandon följer samma tillåtelselistor som DM/guild-meddelanden (`channels.discord.dm.allowFrom`, `channels.discord.guilds`, per-kanalregler).
- Slash-kommandon kan fortfarande vara synliga i Discord-UI för användare som inte är tillåtna; OpenClaw upprätthåller tillåtelselistor vid exekvering och svarar ”not authorized”.

## Verktygsåtgärder

Agenten kan anropa `discord` med åtgärder som:

- `react` / `reactions` (lägg till eller lista reaktioner)
- `sticker`, `poll`, `permissions`
- `readMessages`, `sendMessage`, `editMessage`, `deleteMessage`
- Läs-/sök-/fäst-verktygspayloads inkluderar normaliserade `timestampMs` (UTC epoch ms) och `timestampUtc` tillsammans med råa Discord `timestamp`.
- `threadCreate`, `threadList`, `threadReply`
- `pinMessage`, `unpinMessage`, `listPins`
- `searchMessages`, `memberInfo`, `roleInfo`, `roleAdd`, `roleRemove`, `emojiList`
- `channelInfo`, `channelList`, `voiceStatus`, `eventList`, `eventCreate`
- `timeout`, `kick`, `ban`
- `setPresence` (botaktivitet och onlinestatus)

Discord-meddelande-id dyker upp i det injicerade sammanhanget (`[discord-meddelande-id: …]` och historik linjer) så att agenten kan rikta dem.
Emoji kan vara unicode (t.ex., `✅`) eller anpassad emoji-syntax som `<:party_blob:1234567890>`.

## Säkerhet och drift

- Behandla bottoken som ett lösenord; föredra `DISCORD_BOT_TOKEN`-miljövariabeln på övervakade värdar eller lås ned filbehörigheter för konfigfilen.
- Ge endast boten de behörigheter den behöver (vanligtvis Läs/Skicka meddelanden).
- Om boten fastnar eller blir rate-limitad, starta om gatewayen (`openclaw gateway --force`) efter att ha bekräftat att inga andra processer äger Discord-sessionen.
