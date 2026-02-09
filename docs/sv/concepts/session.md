---
summary: "Regler, nycklar och persistens för sessionshantering i chattar"
read_when:
  - Modifierar sessionshantering eller lagring
title: "Sessionshantering"
---

# Sessionshantering

OpenClaw behandlar **en direktchatt per agent** som primär. Direktchattar kollapsar till `agent:<agentId>:<mainKey>` (standard `main`), medan grupp/kanalchattar får sina egna nycklar. `session.mainKey` är hedrad.

Använd `session.dmScope` för att styra hur **direktmeddelanden** grupperas:

- `main` (standard): alla DM delar huvudsessionskontinuitet.
- `per-peer`: isolera per avsändar-id över kanaler.
- `per-channel-peer`: isolera per kanal + avsändare (rekommenderas för inkorgar med flera användare).
- `per-account-channel-peer`: isolera från konto + kanal + avsändare (rekommenderas för multi-account inkorgar).
  Använd `session. dentityLinks` för att kartlägga leverantörs-prefixed kamrat-ids till en kanonisk identitet så att samma person delar en DM-session över kanaler när man använder `per-peer`, `per-channel-peer`, eller `per-account-channel-peer`.

## Säker DM-läge (rekommenderas för uppsättningar med flera användare)

> **Säkerhetsvarning:** Om din agent kan ta emot DMs från **flera personer**, bör du starkt överväga att aktivera säkert DM-läge. Utan det delar alla användare samma kontext som kan läcka privat information mellan användare.

**Exempel på problemet med standardinställningar:**

- Alice (`<SENDER_A>`) meddelar din agent om ett privat ämne (till exempel ett läkarbesök)
- Bob (`<SENDER_B>`) meddelar din agent och frågar ”Vad pratade vi om?”
- Eftersom båda DM delar samma session kan modellen svara Bob med hjälp av Alices tidigare kontext.

**Åtgärden:** Sätt `dmScope` för att isolera sessioner per användare:

```json5
// ~/.openclaw/openclaw.json
{
  session: {
    // Secure DM mode: isolate DM context per channel + sender.
    dmScope: "per-channel-peer",
  },
}
```

**När ska detta aktiveras:**

- Du har parningsgodkännanden för mer än en avsändare
- Du använder en DM-tillåtelselista med flera poster
- Du sätter `dmPolicy: "open"`
- Flera telefonnummer eller konton kan kontakta din agent

Noteringar:

- Standard är `dmScope: "main"` för kontinuitet (alla DMs delar huvudsessionen). Detta är bra för enanvändares inställningar.
- För inkorgar med flera konton på samma kanal, föredra `per-account-channel-peer`.
- Om samma person kontaktar dig via flera kanaler, använd `session.identityLinks` för att slå samman deras DM-sessioner till en kanonisk identitet.
- Du kan verifiera dina DM-inställningar med `openclaw security audit` (se [security](/cli/security)).

## Gateway är sanningskällan

Alla sessionsstater är **ägda av gateway** (“master” OpenClaw). UI-klienter (macOS app, WebChat, etc.) måste fråga gateway för sessionslistor och token räknas istället för att läsa lokala filer.

- I **fjärrläge** finns den sessionslagring du bryr dig om på den fjärranslutna gateway-värden, inte på din Mac.
- Tokenantal som visas i UIs kommer från gatewayens butiksfält (`inputTokens`, `outputTokens`, `totalTokens`, `contextTokens`). Klienter tolkar inte JSONL avskrifter för att “fixa upp” summor.

## Var tillstånd lagras

- På **gateway-värden**:
  - Lagringsfil: `~/.openclaw/agents/<agentId>/sessions/sessions.json` (per agent).
- Transkript: `~/.openclaw/agents/<agentId>/sessions/<SessionId>.jsonl` (Telegram-ämnessessioner använder `.../<SessionId>-topic-<threadId>.jsonl`).
- Butiken är en karta `sessionKey -> { sessionId, updatedAt, ... }`. Att ta bort poster är säkert; de återskapas på begäran.
- Grupposter kan innehålla `displayName`, `channel`, `subject`, `room` och `space` för att märka sessioner i UI:n.
- Sessionsposter innehåller `origin`-metadata (etikett + routningstips) så att UI:n kan förklara var en session kommer ifrån.
- OpenClaw läser **inte** äldre Pi/Tau-sessionsmappar.

## Sessionsrensning

OpenClaw trims **gamla verktygsresultat** från kontexten i minnet precis innan LLM-samtal som standard.
Detta skriver **inte** om JSONL-historik. Se [/concepts/session-pruning](/concepts/session-pruning).

## Förkompaktering: minnesrensning

När en session närmar sig automatisk komprimering kan OpenClaw köra en **tyst minnesfärg**
sväng som påminner modellen om att skriva hållbara anteckningar till disken. Detta körs bara när
arbetsytan är skrivbar. Se [Memory](/concepts/memory) och
[Compaction](/concepts/compaction).

## Mappning av transporter → sessionsnycklar

- Direktchattar följer `session.dmScope` (standard `main`).
  - `main`: `agent:<agentId>:<mainKey>` (kontinuitet över enheter/kanaler).
    - Flera telefonnummer och kanaler kan mappas till samma agent-huvudnyckel; de fungerar som transporter in i en konversation.
  - `per-peer`: `agent:<agentId>:dm:<peerId>`.
  - `per-channel-peer`: `agent:<agentId>:<channel>:dm:<peerId>`.
  - `per-account-channel-peer`: `agent:<agentId>:<channel>:<accountId>:dm:<peerId>` (accountId är som standard `default`).
  - Om `session.identityLinks` matchar ett leverantörsprefixat peer-id (till exempel `telegram:123`), ersätter den kanoniska nyckeln `<peerId>` så att samma person delar en session över kanaler.
- Gruppchattar isolerar tillstånd: `agent:<agentId>:<channel>:group:<id>` (rum/kanaler använder `agent:<agentId>:<channel>:channel:<id>`).
  - Telegram-forumämnen lägger till `:topic:<threadId>` till grupp-id:t för isolering.
  - Äldre `group:<id>`-nycklar känns fortfarande igen för migrering.
- Inkommande kontexter kan fortfarande använda `group:<id>`; kanalen härleds från `Provider` och normaliseras till den kanoniska `agent:<agentId>:<channel>:group:<id>`-formen.
- Andra källor:
  - Cron-jobb: `cron:<job.id>`
  - Webhooks: `hook:<uuid>` (om inte uttryckligen satt av hooken)
  - Node-körningar: `node-<nodeId>`

## Livscykel

- Återställningspolicy: sessioner återanvänds tills de löper ut, och utgång utvärderas vid nästa inkommande meddelande.
- Daglig återställning: Standard är **4:00 AM lokal tid på gateway-värden**. En session är föråldrad när dess senaste uppdatering är tidigare än den senaste dagliga återställningstiden.
- Idle reset (valfritt): `idleMinutes` lägger till ett glidande inaktiv fönster. När både dagliga och inaktiva återställningar är konfigurerade, tvingar **oavsett vilken som går ut först** en ny session.
- Äldre endast-inaktivitet: om du sätter `session.idleMinutes` utan någon `session.reset`/`resetByType`-konfiguration förblir OpenClaw i endast-inaktivitetsläge för bakåtkompatibilitet.
- Överstyrning per typ (valfritt): `resetByType` låter dig åsidosätta policyn för `dm`, `group` och `thread`-sessioner (tråd = Slack/Discord-trådar, Telegram-ämnen, Matrix-trådar när de tillhandahålls av kontakten).
- Överstyrning per kanal (valfritt): `resetByChannel` åsidosätter återställningspolicyn för en kanal (gäller alla sessionstyper för den kanalen och har företräde framför `reset`/`resetByType`).
- Återställ utlösare: exakt `/new` eller `/reset` (plus eventuella extramaterial i `resetTriggers`) starta ett nytt sessions-id och skicka resten av meddelandet genom. `/new <model>` accepterar ett modellalias, `provider/model`, eller leverantörsnamn (luddig match) för att ställa in den nya sessionsmodellen. Om `/new` eller `/reset` skickas ensam, kör OpenClaw en kort “hej” hälsning sväng för att bekräfta återställningen.
- Manuell återställning: ta bort specifika nycklar från lagringen eller ta bort JSONL-transkriptet; nästa meddelande återskapar dem.
- Isolerade cron-jobb skapar alltid en ny `sessionId` per körning (ingen inaktivitetsåteranvändning).

## Sändpolicy (valfritt)

Blockera leverans för specifika sessionstyper utan att lista enskilda id:n.

```json5
{
  session: {
    sendPolicy: {
      rules: [
        { action: "deny", match: { channel: "discord", chatType: "group" } },
        { action: "deny", match: { keyPrefix: "cron:" } },
      ],
      default: "allow",
    },
  },
}
```

Körtidsöverstyrning (endast ägare):

- `/send on` → tillåt för denna session
- `/send off` → neka för denna session
- `/send inherit` → rensa överstyrning och använd konfigregler
  Skicka dessa som fristående meddelanden så att de registreras.

## Konfiguration (valfritt exempel på namnbyte)

```json5
// ~/.openclaw/openclaw.json
{
  session: {
    scope: "per-sender", // keep group keys separate
    dmScope: "main", // DM continuity (set per-channel-peer/per-account-channel-peer for shared inboxes)
    identityLinks: {
      alice: ["telegram:123456789", "discord:987654321012345678"],
    },
    reset: {
      // Defaults: mode=daily, atHour=4 (gateway host local time).
      // If you also set idleMinutes, whichever expires first wins.
      mode: "daily",
      atHour: 4,
      idleMinutes: 120,
    },
    resetByType: {
      thread: { mode: "daily", atHour: 4 },
      dm: { mode: "idle", idleMinutes: 240 },
      group: { mode: "idle", idleMinutes: 120 },
    },
    resetByChannel: {
      discord: { mode: "idle", idleMinutes: 10080 },
    },
    resetTriggers: ["/new", "/reset"],
    store: "~/.openclaw/agents/{agentId}/sessions/sessions.json",
    mainKey: "main",
  },
}
```

## Inspektering

- `openclaw status` — visar lagringsväg och senaste sessioner.
- `openclaw sessions --json` — dumpar varje post (filtrera med `--active <minutes>`).
- `openclaw gateway call sessions.list --params '{}'` — hämtar sessioner från den körande gatewayn (använd `--url`/`--token` för åtkomst till fjärr-gateway).
- Skicka `/status` som ett fristående meddelande i chatten för att se om agenten är nåbar, hur mycket av sessionskontexten som används, aktuella thinking/verbose-växlar och när dina WhatsApp-webbuppgifter senast uppdaterades (hjälper att upptäcka behov av omkoppling).
- Skicka `/context list` eller `/context detail` för att se vad som finns i systemprompten och injicerade arbetsytefiler (och de största kontextbidragen).
- Skicka `/stop` som ett fristående meddelande för att avbryta den pågående körningen, rensa köade uppföljningar för den sessionen och stoppa eventuella subagent-körningar som startats från den (svaret inkluderar antalet stoppade).
- Skicka `/compact` (valfria instruktioner) som ett fristående meddelande för att sammanfatta äldre sammanhang och frigöra fönsterutrymme. Se [/concepts/compaction](/concepts/compaction).
- JSONL-transkript kan öppnas direkt för att granska fullständiga turer.

## Tips

- Håll den primära nyckeln dedikerad till 1:1-trafik; låt grupper behålla sina egna nycklar.
- Vid automatiserad städning, ta bort enskilda nycklar i stället för hela lagringen för att bevara kontext på andra ställen.

## Sessionsursprungsmetadata

Varje sessionspost registrerar var den kom ifrån (bästa möjliga) i `origin`:

- `label`: mänsklig etikett (löst från konversationsetikett + gruppämne/kanal)
- `provider`: normaliserat kanal-id (inklusive tillägg)
- `from`/`to`: råa routnings-id:n från det inkommande kuvertet
- `accountId`: leverantörskonto-id (vid flera konton)
- `threadId`: tråd/tråd-id när kanalen stöder den
  Ursprungsfälten är befolkade för direkta meddelanden, kanaler och grupper. Om en
  connector endast uppdaterar leveransvägen (till exempel för att hålla en DM huvudsession
  färsk), det bör fortfarande ge inkommande sammanhang så sessionen håller sin
  förklarare metadata. Tillägg kan göra detta genom att skicka `ConversationLabel`,
  `GroupSubject`, `GroupChannel`, `GroupSpace`, och `SenderName` i det inkommande
  sammanhanget och ringer `recordSessionMetaFromInbound` (eller skickar samma kontext
  till `updateLastRoute`).
