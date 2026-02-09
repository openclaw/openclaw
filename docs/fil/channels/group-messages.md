---
summary: "Pag-uugali at config para sa paghawak ng WhatsApp group messages (ang mentionPatterns ay ibinabahagi sa iba’t ibang surface)"
read_when:
  - Kapag binabago ang mga patakaran ng group message o mga mention
title: "Group Messages"
---

# Group messages (WhatsApp web channel)

Layunin: hayaan si Clawd na manatili sa mga WhatsApp group, magising lang kapag na-ping, at panatilihing hiwalay ang thread na iyon mula sa personal na DM session.

**Draft streaming:** opsyonal na `channels.telegram.streamMode` ay gumagamit ng `sendMessageDraft` sa mga private topic chat (Bot API 9.3+). Ito ay hiwalay sa channel block streaming.

## Ano ang naipatupad (2025-12-03)

- Activation modes: `mention` (default) or `always`. Para sa mga multi-agent setup, itakda ang `agents.list[].groupChat.mentionPatterns` bawat agent (o gamitin ang `messages.groupChat.mentionPatterns` bilang global fallback). Mga activation mode: `mention` (default) o `always`. Ang `mention` ay nangangailangan ng ping (tunay na WhatsApp @-mentions sa pamamagitan ng `mentionedJids`, mga regex pattern, o ang E.164 ng bot kahit saan sa teksto). Ang `always` ay ginigising ang agent sa bawat mensahe ngunit dapat lamang itong sumagot kapag maaari itong magbigay ng makabuluhang halaga; kung hindi, ibinabalik nito ang silent token na `NO_REPLY`.
- Maaaring itakda ang mga default sa config (`channels.whatsapp.groups`) at i-override bawat group sa pamamagitan ng `/activation`. `allowlist` uses `channels.whatsapp.groupAllowFrom` (fallback: explicit `channels.whatsapp.allowFrom`). Patakaran sa grupo: Kinokontrol ng `channels.whatsapp.groupPolicy` kung tatanggapin ang mga mensahe ng grupo (`open|disabled|allowlist`).
- Per-group sessions: session keys look like `agent:<agentId>:whatsapp:group:<jid>` so commands such as `/verbose on` or `/think high` (sent as standalone messages) are scoped to that group; personal DM state is untouched. 2. Nilalaktawan ang mga heartbeat para sa mga group thread.
- Context injection: **pending-only** group messages (default 50) that _did not_ trigger a run are prefixed under `[Chat messages since your last reply - for context]`, with the triggering line under `[Current message - respond to this]`. Messages already in the session are not re-injected.
- Sender surfacing: ang bawat batch ng grupo ay nagtatapos na ngayon sa `[from: Sender Name (+E164)]` para malaman ni Pi kung sino ang nagsasalita.
- Ephemeral/view-once: binubuksan namin ang mga ito bago kunin ang teksto/mga mention, kaya ang mga ping sa loob ng mga ito ay nagti-trigger pa rin.
- Group system prompt: on the first turn of a group session (and whenever `/activation` changes the mode) we inject a short blurb into the system prompt like `You are replying inside the WhatsApp group "<subject>". 6. Mga miyembro ng grupo: Alice (+44...), Bob (+43...), … Activation: trigger-only … Address the specific sender noted in the message context.` If metadata isn’t available we still tell the agent it’s a group chat.

## Halimbawa ng config (WhatsApp)

Magdagdag ng `groupChat` block sa `~/.openclaw/openclaw.json` para gumana ang mga display-name ping kahit kapag tinatanggal ng WhatsApp ang visual na `@` sa body ng teksto:

```json5
{
  channels: {
    whatsapp: {
      groups: {
        "*": { requireMention: true },
      },
    },
  },
  agents: {
    list: [
      {
        id: "main",
        groupChat: {
          historyLimit: 50,
          mentionPatterns: ["@?openclaw", "\\+?15555550123"],
        },
      },
    ],
  },
}
```

Mga tala:

- Case-insensitive ang mga regex; sinasaklaw nila ang display-name ping tulad ng `@openclaw` at ang raw na numero na may o walang `+`/mga espasyo.
- Nagpapadala pa rin ang WhatsApp ng canonical mentions sa pamamagitan ng `mentionedJids` kapag may nag-tap sa contact, kaya bihirang kailanganin ang number fallback ngunit kapaki-pakinabang itong safety net.

### Activation command (owner-only)

Gamitin ang group chat command:

- `/activation mention`
- `/activation always`

9. Ang owner number lamang (mula sa `channels.whatsapp.allowFrom`, o ang sariling E.164 ng bot kapag hindi nakatakda) ang maaaring magbago nito. Ipadala ang `/status` bilang hiwalay na mensahe sa grupo upang makita ang kasalukuyang activation mode.

## Paano gamitin

1. Idagdag ang iyong WhatsApp account (ang nagpapatakbo ng OpenClaw) sa grupo.
2. 11. Sabihin ang `@openclaw …` (o isama ang numero). Tanging mga sender na nasa allowlist ang puwedeng mag-trigger nito maliban kung itatakda mo ang `groupPolicy: "open"`.
3. Isasama ng agent prompt ang kamakailang group context kasama ang trailing na `[from: …]` marker para ma-address ang tamang tao.
4. 13. Ang mga session-level directive (`/verbose on`, `/think high`, `/new` o `/reset`, `/compact`) ay naaangkop lang sa session ng grupong iyon; ipadala ang mga ito bilang standalone na mensahe para marehistro. Nanatiling hiwalay at independent ang iyong personal na DM session.

## Pagsubok / beripikasyon

- Manual smoke:
  - Magpadala ng `@openclaw` ping sa grupo at kumpirmahin ang reply na tumutukoy sa pangalan ng sender.
  - Magpadala ng ikalawang ping at tiyaking kasama ang history block at saka ito nalilinis sa susunod na turn.
- Suriin ang gateway logs (patakbuhin gamit ang `--verbose`) para makita ang mga entry na `inbound web message` na nagpapakita ng `from: <groupJid>` at ang `[from: …]` suffix.

## Mga kilalang konsiderasyon

- Sadyang nilalaktawan ang mga heartbeat para sa mga grupo upang maiwasan ang maingay na broadcast.
- Gumagamit ang echo suppression ng pinagsamang batch string; kung magpadala ka ng magkaparehong teksto nang dalawang beses nang walang mga mention, ang una lang ang makakakuha ng tugon.
- Lalabas ang mga entry ng session store bilang `agent:<agentId>:whatsapp:group:<jid>` sa session store (`~/.openclaw/agents/<agentId>/sessions/sessions.json` bilang default); ang nawawalang entry ay nangangahulugang hindi pa nagti-trigger ng run ang grupo.
- Ang mga typing indicator sa mga grupo ay sumusunod sa `agents.defaults.typingMode` (default: `message` kapag walang mention).
