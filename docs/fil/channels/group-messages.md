---
summary: "Pag-uugali at config para sa paghawak ng WhatsApp group messages (ang mentionPatterns ay ibinabahagi sa iba’t ibang surface)"
read_when:
  - Kapag binabago ang mga patakaran ng group message o mga mention
title: "Group Messages"
x-i18n:
  source_path: channels/group-messages.md
  source_hash: 181a72f12f5021af
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:45:26Z
---

# Group messages (WhatsApp web channel)

Layunin: hayaan si Clawd na manatili sa mga WhatsApp group, magising lang kapag na-ping, at panatilihing hiwalay ang thread na iyon mula sa personal na DM session.

Tandaan: ginagamit na ngayon ang `agents.list[].groupChat.mentionPatterns` ng Telegram/Discord/Slack/iMessage; ang dokumentong ito ay nakatuon sa WhatsApp-specific na pag-uugali. Para sa mga multi-agent setup, itakda ang `agents.list[].groupChat.mentionPatterns` kada agent (o gamitin ang `messages.groupChat.mentionPatterns` bilang global fallback).

## Ano ang naipatupad (2025-12-03)

- Mga activation mode: `mention` (default) o `always`. Ang `mention` ay nangangailangan ng ping (tunay na WhatsApp @-mentions sa pamamagitan ng `mentionedJids`, mga regex pattern, o ang E.164 ng bot kahit saan sa teksto). Ang `always` ay gumigising sa agent sa bawat mensahe ngunit dapat lang itong sumagot kapag may maidaragdag na makabuluhang halaga; kung wala, ibinabalik nito ang silent token na `NO_REPLY`. Maaaring itakda ang mga default sa config (`channels.whatsapp.groups`) at i-override kada grupo sa pamamagitan ng `/activation`. Kapag nakatakda ang `channels.whatsapp.groups`, kumikilos din ito bilang group allowlist (isama ang `"*"` para payagan ang lahat).
- Group policy: kinokontrol ng `channels.whatsapp.groupPolicy` kung tinatanggap ang mga group message (`open|disabled|allowlist`). Ginagamit ng `allowlist` ang `channels.whatsapp.groupAllowFrom` (fallback: tahasang `channels.whatsapp.allowFrom`). Ang default ay `allowlist` (naka-block hanggang magdagdag ka ng mga sender).
- Per-group sessions: ang mga session key ay mukhang `agent:<agentId>:whatsapp:group:<jid>` kaya ang mga command gaya ng `/verbose on` o `/think high` (ipinadala bilang standalone na mga mensahe) ay naka-scope sa grupong iyon; hindi naaapektuhan ang personal na DM state. Nilalaktawan ang mga heartbeat para sa mga group thread.
- Context injection: ang **pending-only** na mga group message (default na 50) na _hindi_ nag-trigger ng run ay ipinaprefix sa ilalim ng `[Chat messages since your last reply - for context]`, kasama ang linya na nag-trigger sa ilalim ng `[Current message - respond to this]`. Ang mga mensaheng nasa session na ay hindi muling ini-inject.
- Sender surfacing: ang bawat batch ng grupo ay nagtatapos na ngayon sa `[from: Sender Name (+E164)]` para malaman ni Pi kung sino ang nagsasalita.
- Ephemeral/view-once: binubuksan namin ang mga ito bago kunin ang teksto/mga mention, kaya ang mga ping sa loob ng mga ito ay nagti-trigger pa rin.
- Group system prompt: sa unang turn ng isang group session (at tuwing binabago ng `/activation` ang mode) nag-iinject kami ng maikling blurb sa system prompt tulad ng `You are replying inside the WhatsApp group "<subject>". Group members: Alice (+44...), Bob (+43...), … Activation: trigger-only … Address the specific sender noted in the message context.`. Kapag walang metadata, sinasabi pa rin namin sa agent na ito ay isang group chat.

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

Ang owner number lang (mula sa `channels.whatsapp.allowFrom`, o ang sariling E.164 ng bot kapag hindi nakatakda) ang puwedeng magbago nito. Ipadala ang `/status` bilang standalone na mensahe sa grupo para makita ang kasalukuyang activation mode.

## Paano gamitin

1. Idagdag ang iyong WhatsApp account (ang nagpapatakbo ng OpenClaw) sa grupo.
2. Sabihin ang `@openclaw …` (o isama ang numero). Tanging ang mga allowlisted sender lang ang makakapag-trigger nito maliban kung itinakda mo ang `groupPolicy: "open"`.
3. Isasama ng agent prompt ang kamakailang group context kasama ang trailing na `[from: …]` marker para ma-address ang tamang tao.
4. Ang mga session-level directive (`/verbose on`, `/think high`, `/new` o `/reset`, `/compact`) ay naaangkop lamang sa session ng grupong iyon; ipadala ang mga ito bilang standalone na mensahe para marehistro. Mananatiling independent ang iyong personal na DM session.

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
