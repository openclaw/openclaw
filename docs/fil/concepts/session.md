---
summary: "Mga patakaran sa pamamahala ng session, mga key, at persistence para sa mga chat"
read_when:
  - Pagbabago ng paghawak o pag-iimbak ng session
title: "Pamamahala ng Session"
---

# Pamamahala ng Session

OpenClaw treats **one direct-chat session per agent** as primary. Direct chats collapse to `agent:<agentId>:<mainKey>` (default `main`), while group/channel chats get their own keys. `session.mainKey` is honored.

Gamitin ang `session.dmScope` upang kontrolin kung paano pinapangkat ang **mga direct message**:

- `main` (default): lahat ng DM ay nagbabahagi ng pangunahing session para sa continuity.
- `per-peer`: ihiwalay ayon sa sender id sa iba’t ibang channel.
- `per-channel-peer`: ihiwalay ayon sa channel + sender (inirerekomenda para sa mga multi-user inbox).
- `per-account-channel-peer`: isolate by account + channel + sender (recommended for multi-account inboxes).
  Use `session.identityLinks` to map provider-prefixed peer ids to a canonical identity so the same person shares a DM session across channels when using `per-peer`, `per-channel-peer`, or `per-account-channel-peer`.

## Secure DM mode (inirerekomenda para sa mga multi-user setup)

> **Security Warning:** If your agent can receive DMs from **multiple people**, you should strongly consider enabling secure DM mode. Without it, all users share the same conversation context, which can leak private information between users.

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

- Default is `dmScope: "main"` for continuity (all DMs share the main session). This is fine for single-user setups.
- Para sa mga multi-account inbox sa iisang channel, mas mainam ang `per-account-channel-peer`.
- Kung ang parehong tao ay kumokontak sa iyo sa maraming channel, gamitin ang `session.identityLinks` upang pagsamahin ang kanilang mga DM session sa isang canonical na identidad.
- Maaari mong i-verify ang iyong DM settings gamit ang `openclaw security audit` (tingnan ang [security](/cli/security)).

## Gateway ang source of truth

All session state is **owned by the gateway** (the “master” OpenClaw). UI clients (macOS app, WebChat, etc.) ay dapat mag-query sa gateway para sa mga listahan ng session at mga bilang ng token sa halip na magbasa ng mga lokal na file.

- Sa **remote mode**, ang session store na mahalaga ay nasa remote na host ng Gateway, hindi sa iyong Mac.
- Token counts shown in UIs come from the gateway’s store fields (`inputTokens`, `outputTokens`, `totalTokens`, `contextTokens`). Hindi pinaparse ng mga client ang mga JSONL transcript para “ayusin” ang mga kabuuan.

## Saan naninirahan ang state

- Sa **host ng Gateway**:
  - Store file: `~/.openclaw/agents/<agentId>/sessions/sessions.json` (bawat agent).
- Mga transcript: `~/.openclaw/agents/<agentId>/sessions/<SessionId>.jsonl` (ang mga Telegram topic session ay gumagamit ng `.../<SessionId>-topic-<threadId>.jsonl`).
- Ang store ay isang map `sessionKey -> { sessionId, updatedAt, ... }`. Deleting entries is safe; they are recreated on demand.
- Ang mga group entry ay maaaring magsama ng `displayName`, `channel`, `subject`, `room`, at `space` upang lagyan ng label ang mga session sa mga UI.
- Ang mga session entry ay may `origin` metadata (label + routing hints) upang maipaliwanag ng mga UI kung saan nagmula ang isang session.
- Ang OpenClaw ay **hindi** nagbabasa ng mga legacy na Pi/Tau session folder.

## Session pruning

OpenClaw trims **old tool results** from the in-memory context right before LLM calls by default.
This does **not** rewrite JSONL history. Tingnan ang [/concepts/session-pruning](/concepts/session-pruning).

## Pre-compaction memory flush

When a session nears auto-compaction, OpenClaw can run a **silent memory flush**
turn that reminds the model to write durable notes to disk. This only runs when
the workspace is writable. See [Memory](/concepts/memory) and
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
- Daily reset: defaults to **4:00 AM local time on the gateway host**. A session is stale once its last update is earlier than the most recent daily reset time.
- Idle reset (optional): `idleMinutes` adds a sliding idle window. When both daily and idle resets are configured, **whichever expires first** forces a new session.
- Legacy idle-only: kung itatakda mo ang `session.idleMinutes` nang walang anumang `session.reset`/`resetByType` config, mananatili ang OpenClaw sa idle-only mode para sa backward compatibility.
- Per-type override (opsyonal): hinahayaan ka ng `resetByType` na i-override ang policy para sa mga `dm`, `group`, at `thread` na session (thread = mga Slack/Discord thread, mga Telegram topic, Matrix thread kapag ibinigay ng connector).
- Per-channel override (opsyonal): ini-override ng `resetByChannel` ang reset policy para sa isang channel (naaangkop sa lahat ng uri ng session para sa channel na iyon at may mas mataas na prioridad kaysa sa `reset`/`resetByType`).
- Reset triggers: exact `/new` or `/reset` (plus any extras in `resetTriggers`) start a fresh session id and pass the remainder of the message through. `/new <model>` accepts a model alias, `provider/model`, or provider name (fuzzy match) to set the new session model. If `/new` or `/reset` is sent alone, OpenClaw runs a short “hello” greeting turn to confirm the reset.
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
- Magpadala ng `/compact` (opsyonal na mga tagubilin) bilang hiwalay na mensahe upang ibuod ang mas lumang context at magpalaya ng espasyo sa window. See [/concepts/compaction](/concepts/compaction).
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
- `threadId`: thread/topic id kapag sinusuportahan ito ng channel
  Ang mga origin field ay napupunan para sa mga direct message, channel, at grupo. If a
  connector only updates delivery routing (for example, to keep a DM main session
  fresh), it should still provide inbound context so the session keeps its
  explainer metadata. Extensions can do this by sending `ConversationLabel`,
  `GroupSubject`, `GroupChannel`, `GroupSpace`, and `SenderName` in the inbound
  context and calling `recordSessionMetaFromInbound` (or passing the same context
  to `updateLastRoute`).
