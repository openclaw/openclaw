---
summary: "Mga patakaran sa pamamahala ng session, mga key, at persistence para sa mga chat"
read_when:
  - Pagbabago ng paghawak o pag-iimbak ng session
title: "Pamamahala ng Session"
x-i18n:
  source_path: concepts/session.md
  source_hash: e2040cea1e0738a8
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:45:44Z
---

# Pamamahala ng Session

Itinuturing ng OpenClaw ang **isang direct-chat session bawat agent** bilang pangunahing default. Ang mga direct chat ay nagsasama-sama sa `agent:<agentId>:<mainKey>` (default `main`), habang ang mga group/channel chat ay nakakakuha ng sarili nilang mga key. Iginagalang ang `session.mainKey`.

Gamitin ang `session.dmScope` upang kontrolin kung paano pinapangkat ang **mga direct message**:

- `main` (default): lahat ng DM ay nagbabahagi ng pangunahing session para sa continuity.
- `per-peer`: ihiwalay ayon sa sender id sa iba’t ibang channel.
- `per-channel-peer`: ihiwalay ayon sa channel + sender (inirerekomenda para sa mga multi-user inbox).
- `per-account-channel-peer`: ihiwalay ayon sa account + channel + sender (inirerekomenda para sa mga multi-account inbox).
  Gamitin ang `session.identityLinks` upang i-map ang mga provider‑prefixed peer id sa isang canonical na identidad para ang iisang tao ay magbahagi ng iisang DM session sa iba’t ibang channel kapag gumagamit ng `per-peer`, `per-channel-peer`, o `per-account-channel-peer`.

## Secure DM mode (inirerekomenda para sa mga multi-user setup)

> **Babala sa Seguridad:** Kung ang iyong agent ay maaaring makatanggap ng DM mula sa **maraming tao**, mariing inirerekomenda na i-enable ang secure DM mode. Kung wala ito, lahat ng user ay magbabahagi ng iisang conversation context, na maaaring mag-leak ng pribadong impormasyon sa pagitan ng mga user.

**Halimbawa ng problema sa default na settings:**

- Si Alice (`<SENDER_A>`) ay nag-message sa iyong agent tungkol sa isang pribadong paksa (halimbawa, isang medical appointment)
- Si Bob (`<SENDER_B>`) ay nag-message sa iyong agent at nagtanong ng “Ano nga ulit ang pinag-uusapan natin?”
- Dahil parehong DM ay nagbabahagi ng iisang session, maaaring sumagot ang model kay Bob gamit ang naunang context ni Alice.

**Ang solusyon:** Itakda ang `dmScope` upang ihiwalay ang mga session bawat user:

```json5
// ~/.openclaw/openclaw.json
{
  session: {
    // Secure DM mode: isolate DM context per channel + sender.
    dmScope: "per-channel-peer",
  },
}
```

**Kailan ito dapat i-enable:**

- May pairing approvals ka para sa higit sa isang sender
- Gumagamit ka ng DM allowlist na may maraming entry
- Itinakda mo ang `dmPolicy: "open"`
- Maraming phone number o account ang maaaring mag-message sa iyong agent

Mga tala:

- Default ay `dmScope: "main"` para sa continuity (lahat ng DM ay nagbabahagi ng pangunahing session). Ayos ito para sa single-user setup.
- Para sa mga multi-account inbox sa iisang channel, mas mainam ang `per-account-channel-peer`.
- Kung ang parehong tao ay kumokontak sa iyo sa maraming channel, gamitin ang `session.identityLinks` upang pagsamahin ang kanilang mga DM session sa isang canonical na identidad.
- Maaari mong i-verify ang iyong DM settings gamit ang `openclaw security audit` (tingnan ang [security](/cli/security)).

## Gateway ang source of truth

Ang lahat ng session state ay **pagmamay-ari ng gateway** (ang “master” OpenClaw). Ang mga UI client (macOS app, WebChat, atbp.) ay dapat mag-query sa gateway para sa mga listahan ng session at bilang ng token sa halip na magbasa ng mga lokal na file.

- Sa **remote mode**, ang session store na mahalaga ay nasa remote na host ng Gateway, hindi sa iyong Mac.
- Ang mga bilang ng token na ipinapakita sa mga UI ay nagmumula sa mga store field ng gateway (`inputTokens`, `outputTokens`, `totalTokens`, `contextTokens`). Hindi nagpa-parse ang mga client ng JSONL transcript para “itama” ang mga total.

## Saan naninirahan ang state

- Sa **host ng Gateway**:
  - Store file: `~/.openclaw/agents/<agentId>/sessions/sessions.json` (bawat agent).
- Mga transcript: `~/.openclaw/agents/<agentId>/sessions/<SessionId>.jsonl` (ang mga Telegram topic session ay gumagamit ng `.../<SessionId>-topic-<threadId>.jsonl`).
- Ang store ay isang map `sessionKey -> { sessionId, updatedAt, ... }`. Ligtas na burahin ang mga entry; muling nililikha ang mga ito kapag kailangan.
- Ang mga group entry ay maaaring magsama ng `displayName`, `channel`, `subject`, `room`, at `space` upang lagyan ng label ang mga session sa mga UI.
- Ang mga session entry ay may `origin` metadata (label + routing hints) upang maipaliwanag ng mga UI kung saan nagmula ang isang session.
- Ang OpenClaw ay **hindi** nagbabasa ng mga legacy na Pi/Tau session folder.

## Session pruning

Pinaiikli ng OpenClaw ang **mga lumang tool result** mula sa in-memory context bago mismo ang mga LLM call bilang default.
Hindi nito nire-rewrite ang JSONL history. Tingnan ang [/concepts/session-pruning](/concepts/session-pruning).

## Pre-compaction memory flush

Kapag ang isang session ay malapit na sa auto-compaction, maaaring magpatakbo ang OpenClaw ng isang **silent memory flush**
turn na nagpapaalala sa model na magsulat ng mga durable na tala sa disk. Tumatakbo lamang ito kapag
writable ang workspace. Tingnan ang [Memory](/concepts/memory) at
[Compaction](/concepts/compaction).

## Pagmamapa ng mga transport → session key

- Ang mga direct chat ay sumusunod sa `session.dmScope` (default `main`).
  - `main`: `agent:<agentId>:<mainKey>` (continuity sa iba’t ibang device/channel).
    - Maraming phone number at channel ang maaaring mag-map sa iisang pangunahing key ng agent; nagsisilbi silang mga transport papasok sa iisang conversation.
  - `per-peer`: `agent:<agentId>:dm:<peerId>`.
  - `per-channel-peer`: `agent:<agentId>:<channel>:dm:<peerId>`.
  - `per-account-channel-peer`: `agent:<agentId>:<channel>:<accountId>:dm:<peerId>` (ang accountId ay default sa `default`).
  - Kung ang `session.identityLinks` ay tumugma sa isang provider‑prefixed peer id (halimbawa `telegram:123`), papalitan ng canonical key ang `<peerId>` upang ang iisang tao ay magbahagi ng session sa iba’t ibang channel.
- Ang mga group chat ay naghihiwalay ng state: `agent:<agentId>:<channel>:group:<id>` (ang mga room/channel ay gumagamit ng `agent:<agentId>:<channel>:channel:<id>`).
  - Ang mga Telegram forum topic ay nagdadagdag ng `:topic:<threadId>` sa group id para sa isolation.
  - Ang mga legacy na `group:<id>` key ay kinikilala pa rin para sa migration.
- Ang mga inbound context ay maaari pa ring gumamit ng `group:<id>`; ang channel ay hinuhula mula sa `Provider` at ni-normalize sa canonical na `agent:<agentId>:<channel>:group:<id>` na anyo.
- Iba pang pinagmulan:
  - Mga cron job: `cron:<job.id>`
  - Mga webhook: `hook:<uuid>` (maliban kung tahasang itinakda ng hook)
  - Mga node run: `node-<nodeId>`

## Lifecycle

- Reset policy: muling ginagamit ang mga session hanggang sa mag-expire ang mga ito, at sinusuri ang expiry sa susunod na inbound message.
- Daily reset: default sa **4:00 AM lokal na oras sa host ng Gateway**. Itinuturing na stale ang isang session kapag ang huling update nito ay mas maaga kaysa sa pinakahuling daily reset time.
- Idle reset (opsyonal): nagdadagdag ang `idleMinutes` ng sliding idle window. Kapag parehong naka-configure ang daily at idle reset, **kung alin ang unang mag-expire** ang magpupuwersa ng bagong session.
- Legacy idle-only: kung itatakda mo ang `session.idleMinutes` nang walang anumang `session.reset`/`resetByType` config, mananatili ang OpenClaw sa idle-only mode para sa backward compatibility.
- Per-type override (opsyonal): hinahayaan ka ng `resetByType` na i-override ang policy para sa mga `dm`, `group`, at `thread` na session (thread = mga Slack/Discord thread, mga Telegram topic, Matrix thread kapag ibinigay ng connector).
- Per-channel override (opsyonal): ini-override ng `resetByChannel` ang reset policy para sa isang channel (naaangkop sa lahat ng uri ng session para sa channel na iyon at may mas mataas na prioridad kaysa sa `reset`/`resetByType`).
- Mga reset trigger: ang eksaktong `/new` o `/reset` (kasama ang anumang dagdag sa `resetTriggers`) ay nagsisimula ng bagong session id at ipinapasa ang natitirang bahagi ng mensahe. Tumatanggap ang `/new <model>` ng model alias, `provider/model`, o pangalan ng provider (fuzzy match) upang itakda ang bagong model ng session. Kung ang `/new` o `/reset` ay ipinadala nang mag-isa, nagpapatakbo ang OpenClaw ng isang maikling “hello” greeting turn upang kumpirmahin ang reset.
- Manual reset: burahin ang mga partikular na key mula sa store o alisin ang JSONL transcript; muling lilikhain ng susunod na mensahe ang mga ito.
- Ang mga isolated na cron job ay palaging lumilikha ng bagong `sessionId` sa bawat run (walang idle reuse).

## Send policy (opsyonal)

I-block ang delivery para sa mga partikular na uri ng session nang hindi naglilista ng mga indibidwal na id.

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

Runtime override (owner lamang):

- `/send on` → payagan para sa session na ito
- `/send off` → tanggihan para sa session na ito
- `/send inherit` → alisin ang override at gamitin ang mga patakaran ng config
  Ipadala ang mga ito bilang mga standalone na mensahe upang mairehistro.

## Configuration (opsyonal na halimbawa ng rename)

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

## Pag-inspect

- `openclaw status` — ipinapakita ang path ng store at mga kamakailang session.
- `openclaw sessions --json` — dini-dump ang bawat entry (i-filter gamit ang `--active <minutes>`).
- `openclaw gateway call sessions.list --params '{}'` — kinukuha ang mga session mula sa tumatakbong Gateway (gamitin ang `--url`/`--token` para sa remote Gateway access).
- Ipadala ang `/status` bilang standalone na mensahe sa chat upang makita kung reachable ang agent, gaano karami sa session context ang nagagamit, ang kasalukuyang thinking/verbose toggle, at kung kailan huling na-refresh ang iyong WhatsApp web creds (nakakatulong para makita ang pangangailangang mag-relink).
- Ipadala ang `/context list` o `/context detail` upang makita kung ano ang nasa system prompt at mga injected na workspace file (at ang pinakamalalaking contributor sa context).
- Ipadala ang `/stop` bilang standalone na mensahe upang ihinto ang kasalukuyang run, linisin ang mga naka-queue na followup para sa session na iyon, at itigil ang anumang sub-agent run na nilikha mula rito (kasama sa reply ang bilang na nahinto).
- Ipadala ang `/compact` (opsyonal na mga instruksyon) bilang standalone na mensahe upang ibuod ang mas lumang context at magpalaya ng espasyo sa window. Tingnan ang [/concepts/compaction](/concepts/compaction).
- Maaaring buksan nang direkta ang mga JSONL transcript upang suriin ang buong mga turn.

## Mga tip

- Panatilihing nakalaan ang pangunahing key para sa 1:1 na trapiko; hayaan ang mga group na panatilihin ang sarili nilang mga key.
- Kapag nag-a-automate ng cleanup, burahin ang mga indibidwal na key sa halip na ang buong store upang mapanatili ang context sa ibang lugar.

## Metadata ng pinagmulan ng session

Ang bawat session entry ay nagtatala kung saan ito nagmula (best‑effort) sa `origin`:

- `label`: human label (nireresolba mula sa conversation label + subject ng group/channel)
- `provider`: normalized na channel id (kasama ang mga extension)
- `from`/`to`: mga raw routing id mula sa inbound envelope
- `accountId`: provider account id (kapag multi-account)
- `threadId`: thread/topic id kapag sinusuportahan ng channel
  Ang mga origin field ay pinupunan para sa mga direct message, channel, at group. Kung ang isang
  connector ay nag-a-update lamang ng delivery routing (halimbawa, upang panatilihing sariwa ang isang DM main session),
  dapat pa rin itong magbigay ng inbound context upang mapanatili ng session ang
  explainer metadata nito. Magagawa ito ng mga extension sa pamamagitan ng pagpapadala ng `ConversationLabel`,
  `GroupSubject`, `GroupChannel`, `GroupSpace`, at `SenderName` sa inbound
  context at pagtawag sa `recordSessionMetaFromInbound` (o pagpasa ng parehong context
  sa `updateLastRoute`).
