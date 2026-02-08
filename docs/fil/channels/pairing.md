---
summary: "Pangkalahatang-ideya ng pairing: aprubahan kung sino ang puwedeng mag-DM sa iyo + kung aling mga node ang puwedeng sumali"
read_when:
  - Pagse-setup ng kontrol sa access ng DM
  - Pag-pair ng bagong iOS/Android node
  - Pagrerepaso ng security posture ng OpenClaw
title: "Pairing"
x-i18n:
  source_path: channels/pairing.md
  source_hash: cc6ce9c71db6d96d
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:45:16Z
---

# Pairing

Ang “Pairing” ay ang tahasang **pag-apruba ng may-ari** ng OpenClaw.
Ginagamit ito sa dalawang lugar:

1. **DM pairing** (sino ang pinapayagang makipag-usap sa bot)
2. **Node pairing** (kung aling mga device/node ang pinapayagang sumali sa Gateway network)

Konteksto ng seguridad: [Security](/gateway/security)

## 1) DM pairing (inbound chat access)

Kapag ang isang channel ay naka-configure gamit ang DM policy na `pairing`, ang mga hindi kilalang sender ay makakatanggap ng maikling code at ang kanilang mensahe ay **hindi ipo-process** hangga’t hindi mo inaaprubahan.

Ang mga default na DM policy ay naka-dokumento sa: [Security](/gateway/security)

Mga pairing code:

- 8 character, uppercase, walang mga nakalilitong character (`0O1I`).
- **Nag-e-expire pagkalipas ng 1 oras**. Ipinapadala lang ng bot ang pairing message kapag may bagong request na nalikha (humigit-kumulang isang beses kada oras kada sender).
- Ang mga pending na DM pairing request ay may limit na **3 kada channel** bilang default; ang mga karagdagang request ay binabalewala hanggang may mag-expire o maaprubahan.

### Aprubahan ang isang sender

```bash
openclaw pairing list telegram
openclaw pairing approve telegram <CODE>
```

Mga suportadong channel: `telegram`, `whatsapp`, `signal`, `imessage`, `discord`, `slack`.

### Saan nakaimbak ang estado

Naka-store sa ilalim ng `~/.openclaw/credentials/`:

- Mga pending na request: `<channel>-pairing.json`
- Approved allowlist store: `<channel>-allowFrom.json`

Ituring ang mga ito bilang sensitibo (sila ang nagba-block o nagpapahintulot ng access sa iyong assistant).

## 2) Node device pairing (iOS/Android/macOS/headless nodes)

Ang mga node ay kumokonekta sa Gateway bilang **mga device** na may `role: node`. Gumagawa ang Gateway ng device pairing request na kailangang aprubahan.

### Aprubahan ang isang node device

```bash
openclaw devices list
openclaw devices approve <requestId>
openclaw devices reject <requestId>
```

### Imbakan ng estado ng node pairing

Naka-store sa ilalim ng `~/.openclaw/devices/`:

- `pending.json` (panandalian; nag-e-expire ang mga pending na request)
- `paired.json` (mga naka-pair na device + mga token)

### Mga tala

- Ang legacy na `node.pair.*` API (CLI: `openclaw nodes pending/approve`) ay isang hiwalay na pairing store na pagmamay-ari ng Gateway. Kailangan pa rin ng device pairing ang mga WS node.

## Kaugnay na docs

- Security model + prompt injection: [Security](/gateway/security)
- Ligtas na pag-update (run doctor): [Updating](/install/updating)
- Mga config ng channel:
  - Telegram: [Telegram](/channels/telegram)
  - WhatsApp: [WhatsApp](/channels/whatsapp)
  - Signal: [Signal](/channels/signal)
  - BlueBubbles (iMessage): [BlueBubbles](/channels/bluebubbles)
  - iMessage (legacy): [iMessage](/channels/imessage)
  - Discord: [Discord](/channels/discord)
  - Slack: [Slack](/channels/slack)
