---
summary: "OpenClaw के लिए उन्नत सेटअप और विकास वर्कफ़्लो"
read_when:
  - नई मशीन सेट कर रहे हों
  - आप अपने व्यक्तिगत सेटअप को प्रभावित किए बिना “latest + greatest” चाहते हों
title: "सेटअप"
---

# सेटअप

<Note>
If you are setting up for the first time, start with [Getting Started](/start/getting-started).
For wizard details, see [Onboarding Wizard](/start/wizard).
</Note>

अंतिम अद्यतन: 2026-01-01

## TL;DR

- **टेलरिंग रिपॉज़िटरी के बाहर रहती है:** `~/.openclaw/workspace` (workspace) + `~/.openclaw/openclaw.json` (config)।
- **स्थिर वर्कफ़्लो:** macOS ऐप इंस्टॉल करें; उसे bundled Gateway चलाने दें।
- **Bleeding edge वर्कफ़्लो:** `pnpm gateway:watch` के माध्यम से Gateway स्वयं चलाएँ, फिर macOS ऐप को Local मोड में अटैच होने दें।

## Prereqs (from source)

- Node `>=22`
- `pnpm`
- Docker (वैकल्पिक; केवल containerized setup/e2e के लिए — देखें [Docker](/install/docker))

## Tailoring strategy (ताकि अपडेट्स से नुकसान न हो)

यदि आप “100% मेरे अनुसार” _और_ आसान अपडेट चाहते हैं, तो अपनी कस्टमाइज़ेशन यहाँ रखें:

- **Config:** `~/.openclaw/openclaw.json` (JSON/JSON5-जैसा)
- **Workspace:** `~/.openclaw/workspace` (skills, prompts, memories; इसे एक निजी git repo बनाएँ)

एक बार बूटस्ट्रैप करें:

```bash
openclaw setup
```

इस repo के भीतर से, local CLI entry का उपयोग करें:

```bash
openclaw setup
```

यदि आपके पास अभी global install नहीं है, तो इसे `pnpm openclaw setup` के माध्यम से चलाएँ।

## इस repo से Gateway चलाएँ

`pnpm build` के बाद, आप packaged CLI को सीधे चला सकते हैं:

```bash
node openclaw.mjs gateway --port 18789 --verbose
```

## Stable workflow (macOS ऐप पहले)

1. **OpenClaw.app** इंस्टॉल करें और लॉन्च करें (menu bar)।
2. onboarding/permissions checklist (TCC prompts) पूरा करें।
3. सुनिश्चित करें कि Gateway **Local** है और चल रहा है (ऐप इसे प्रबंधित करता है)।
4. surfaces लिंक करें (उदाहरण: WhatsApp):

```bash
openclaw channels login
```

5. Sanity check:

```bash
openclaw health
```

यदि आपके build में onboarding उपलब्ध नहीं है:

- `openclaw setup` चलाएँ, फिर `openclaw channels login`, फिर Gateway को मैन्युअली शुरू करें (`openclaw gateway`)।

## Bleeding edge workflow (टर्मिनल में Gateway)

लक्ष्य: TypeScript Gateway पर काम करना, hot reload पाना, और macOS ऐप UI को अटैच रखना।

### 0. (वैकल्पिक) macOS ऐप को भी source से चलाएँ

यदि आप macOS ऐप को भी bleeding edge पर चाहते हैं:

```bash
./scripts/restart-mac.sh
```

### 1. dev Gateway शुरू करें

```bash
pnpm install
pnpm gateway:watch
```

`gateway:watch` gateway को watch mode में चलाता है और TypeScript बदलावों पर reload करता है।

### 2. macOS ऐप को अपने चल रहे Gateway की ओर इंगित करें

**OpenClaw.app** में:

- Connection Mode: **Local**
  ऐप कॉन्फ़िगर किए गए पोर्ट पर चल रहे gateway से अटैच हो जाएगा।

### 3. सत्यापित करें

- ऐप के भीतर Gateway status **“Using existing gateway …”** दिखना चाहिए
- या CLI के माध्यम से:

```bash
openclaw health
```

### Common footguns

- **गलत पोर्ट:** Gateway WS का डिफ़ॉल्ट `ws://127.0.0.1:18789` है; ऐप + CLI को एक ही पोर्ट पर रखें।
- **स्टेट कहाँ रहती है:**
  - Credentials: `~/.openclaw/credentials/`
  - Sessions: `~/.openclaw/agents/<agentId>/sessions/`
  - Logs: `/tmp/openclaw/`

## Credential storage map

auth डिबग करते समय या यह तय करते समय कि क्या बैकअप करना है, इसका उपयोग करें:

- **WhatsApp**: `~/.openclaw/credentials/whatsapp/<accountId>/creds.json`
- **Telegram bot token**: config/env या `channels.telegram.tokenFile`
- **Discord bot token**: config/env (token file अभी समर्थित नहीं)
- **Slack tokens**: config/env (`channels.slack.*`)
- **Pairing allowlists**: `~/.openclaw/credentials/<channel>-allowFrom.json`
- **Model auth profiles**: `~/.openclaw/agents/<agentId>/agent/auth-profiles.json`
- **Legacy OAuth import**: `~/.openclaw/credentials/oauth.json`
  अधिक विवरण: [Security](/gateway/security#credential-storage-map)।

## Updating (आपके सेटअप को नुकसान पहुँचाए बिना)

- `~/.openclaw/workspace` और `~/.openclaw/` को “आपकी चीज़ें” बनाए रखें; व्यक्तिगत prompts/config को `openclaw` repo में न रखें।
- Source अपडेट करना: `git pull` + `pnpm install` (जब lockfile बदले) + `pnpm gateway:watch` का उपयोग जारी रखें।

## Linux (systemd user service)

Linux इंस्टॉलेशन एक systemd **user** सेवा का उपयोग करते हैं। By default, systemd stops user
services on logout/idle, which kills the Gateway. ऑनबोर्डिंग सक्षम करने का प्रयास करती है
आपके लिए lingering (sudo के लिए प्रॉम्प्ट आ सकता है)। If it’s still off, run:

```bash
sudo loginctl enable-linger $USER
```

For always-on or multi-user servers, consider a **system** service instead of a
user service (no lingering needed). See [Gateway runbook](/gateway) for the systemd notes.

## Related docs

- [Gateway runbook](/gateway) (flags, supervision, ports)
- [Gateway configuration](/gateway/configuration) (config schema + उदाहरण)
- [Discord](/channels/discord) और [Telegram](/channels/telegram) (reply tags + replyToMode सेटिंग्स)
- [OpenClaw assistant setup](/start/openclaw)
- [macOS app](/platforms/macos) (gateway lifecycle)
