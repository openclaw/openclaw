---
summary: "Doctor कमांड: स्वास्थ्य जाँच, विन्यास माइग्रेशन, और मरम्मत चरण"
read_when:
  - Doctor माइग्रेशन जोड़ते या संशोधित करते समय
  - ब्रेकिंग विन्यास परिवर्तनों को प्रस्तुत करते समय
title: "Doctor"
x-i18n:
  source_path: gateway/doctor.md
  source_hash: df7b25f60fd08d50
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:49:37Z
---

# Doctor

`openclaw doctor` OpenClaw के लिए मरम्मत + माइग्रेशन टूल है। यह पुराने
config/state को ठीक करता है, स्वास्थ्य की जाँच करता है, और कार्रवाई योग्य
मरम्मत चरण प्रदान करता है।

## त्वरित प्रारंभ

```bash
openclaw doctor
```

### हेडलेस / स्वचालन

```bash
openclaw doctor --yes
```

बिना प्रॉम्प्ट किए डिफ़ॉल्ट स्वीकार करें (जहाँ लागू हो वहाँ restart/service/sandbox मरम्मत चरणों सहित)।

```bash
openclaw doctor --repair
```

बिना प्रॉम्प्ट किए अनुशंसित मरम्मत लागू करें (जहाँ सुरक्षित हो वहाँ मरम्मत + restart)।

```bash
openclaw doctor --repair --force
```

आक्रामक मरम्मत भी लागू करें (कस्टम supervisor configs को ओवरराइट करता है)।

```bash
openclaw doctor --non-interactive
```

बिना प्रॉम्प्ट चलाएँ और केवल सुरक्षित माइग्रेशन लागू करें (config normalization + डिस्क पर state मूव्स)। restart/service/sandbox क्रियाएँ, जिनके लिए मानव पुष्टि आवश्यक है, छोड़ दी जाती हैं।
Legacy state माइग्रेशन पहचान होने पर स्वचालित रूप से चलते हैं।

```bash
openclaw doctor --deep
```

अतिरिक्त gateway इंस्टॉलेशन के लिए सिस्टम सेवाओं को स्कैन करें (launchd/systemd/schtasks)।

यदि आप लिखने से पहले बदलावों की समीक्षा करना चाहते हैं, तो पहले config फ़ाइल खोलें:

```bash
cat ~/.openclaw/openclaw.json
```

## यह क्या करता है (सारांश)

- git इंस्टॉल के लिए वैकल्पिक pre-flight अपडेट (केवल interactive)।
- UI प्रोटोकॉल नवीनता जाँच (जब प्रोटोकॉल स्कीमा नया हो तो Control UI को पुनर्निर्मित करता है)।
- स्वास्थ्य जाँच + restart प्रॉम्प्ट।
- Skills स्थिति सारांश (eligible/missing/blocked)।
- legacy मानों के लिए config normalization।
- OpenCode Zen provider override चेतावनियाँ (`models.providers.opencode`)।
- Legacy on-disk state माइग्रेशन (sessions/agent dir/WhatsApp auth)।
- State integrity और permissions जाँच (sessions, transcripts, state dir)।
- स्थानीय रूप से चलने पर config फ़ाइल permission जाँच (chmod 600)।
- Model auth स्वास्थ्य: OAuth expiry जाँचता है, समाप्त होने वाले टोकन रीफ़्रेश कर सकता है, और auth-profile cooldown/disabled अवस्थाएँ रिपोर्ट करता है।
- अतिरिक्त workspace dir पहचान (`~/openclaw`)।
- sandboxing सक्षम होने पर Sandbox image मरम्मत।
- Legacy service माइग्रेशन और अतिरिक्त gateway पहचान।
- Gateway runtime जाँच (service इंस्टॉल है लेकिन चल नहीं रही; cached launchd label)।
- Channel स्थिति चेतावनियाँ (चल रहे gateway से probe की गई)।
- Supervisor config ऑडिट (launchd/systemd/schtasks) वैकल्पिक मरम्मत के साथ।
- Gateway runtime best-practice जाँच (Node बनाम Bun, version-manager paths)।
- Gateway port collision diagnostics (डिफ़ॉल्ट `18789`)।
- खुले DM policies के लिए सुरक्षा चेतावनियाँ।
- जब कोई `gateway.auth.token` सेट न हो तो Gateway auth चेतावनियाँ (local mode; token generation का प्रस्ताव)।
- Linux पर systemd linger जाँच।
- Source install जाँच (pnpm workspace mismatch, missing UI assets, missing tsx binary)।
- अपडेटेड config + wizard metadata लिखता है।

## विस्तृत व्यवहार और तर्क

### 0) वैकल्पिक अपडेट (git इंस्टॉल)

यदि यह git checkout है और doctor interactive रूप से चल रहा है, तो doctor चलाने से पहले
अपडेट (fetch/rebase/build) का प्रस्ताव देता है।

### 1) Config normalization

यदि config में legacy मान संरचनाएँ हैं (उदाहरण के लिए channel-specific override के बिना `messages.ackReaction`),
तो doctor उन्हें वर्तमान स्कीमा में normalize करता है।

### 2) Legacy config key माइग्रेशन

जब config में deprecated keys होती हैं, अन्य कमांड चलने से मना कर देती हैं और
आपसे `openclaw doctor` चलाने को कहती हैं।

Doctor करेगा:

- बताएगा कि कौन-सी legacy keys मिलीं।
- लागू किए गए माइग्रेशन को दिखाएगा।
- अपडेटेड स्कीमा के साथ `~/.openclaw/openclaw.json` को फिर से लिखेगा।

Gateway भी startup पर legacy config फ़ॉर्मेट पहचानने पर doctor माइग्रेशन अपने-आप चलाता है,
ताकि पुराने configs बिना मैनुअल हस्तक्षेप के ठीक हो जाएँ।

वर्तमान माइग्रेशन:

- `routing.allowFrom` → `channels.whatsapp.allowFrom`
- `routing.groupChat.requireMention` → `channels.whatsapp/telegram/imessage.groups."*".requireMention`
- `routing.groupChat.historyLimit` → `messages.groupChat.historyLimit`
- `routing.groupChat.mentionPatterns` → `messages.groupChat.mentionPatterns`
- `routing.queue` → `messages.queue`
- `routing.bindings` → top-level `bindings`
- `routing.agents`/`routing.defaultAgentId` → `agents.list` + `agents.list[].default`
- `routing.agentToAgent` → `tools.agentToAgent`
- `routing.transcribeAudio` → `tools.media.audio.models`
- `bindings[].match.accountID` → `bindings[].match.accountId`
- `identity` → `agents.list[].identity`
- `agent.*` → `agents.defaults` + `tools.*` (tools/elevated/exec/sandbox/subagents)
- `agent.model`/`allowedModels`/`modelAliases`/`modelFallbacks`/`imageModelFallbacks`
  → `agents.defaults.models` + `agents.defaults.model.primary/fallbacks` + `agents.defaults.imageModel.primary/fallbacks`

### 2b) OpenCode Zen provider overrides

यदि आपने मैन्युअल रूप से `models.providers.opencode` (या `opencode-zen`) जोड़ा है, तो यह
`@mariozechner/pi-ai` से built-in OpenCode Zen catalog को override करता है। इससे
हर मॉडल को एक ही API पर मजबूर किया जा सकता है या लागत शून्य हो सकती है। Doctor चेतावनी देता है
ताकि आप override हटाकर per-model API routing + लागत पुनर्स्थापित कर सकें।

### 3) Legacy state माइग्रेशन (डिस्क लेआउट)

Doctor पुराने on-disk लेआउट को वर्तमान संरचना में माइग्रेट कर सकता है:

- Sessions store + transcripts:
  - `~/.openclaw/sessions/` से `~/.openclaw/agents/<agentId>/sessions/` तक
- Agent dir:
  - `~/.openclaw/agent/` से `~/.openclaw/agents/<agentId>/agent/` तक
- WhatsApp auth state (Baileys):
  - legacy `~/.openclaw/credentials/*.json` से ( `oauth.json` को छोड़कर)
  - `~/.openclaw/credentials/whatsapp/<accountId>/...` तक (डिफ़ॉल्ट account id: `default`)

ये माइग्रेशन best-effort और idempotent हैं; यदि legacy फ़ोल्डर बैकअप के रूप में पीछे रह जाते हैं,
तो doctor चेतावनियाँ देगा। Gateway/CLI भी startup पर legacy sessions + agent dir को
auto-migrate करता है ताकि history/auth/models बिना मैनुअल doctor रन के
per-agent path में आ जाएँ। WhatsApp auth को जानबूझकर केवल `openclaw doctor` के माध्यम से माइग्रेट किया जाता है।

### 4) State integrity जाँच (session persistence, routing, और safety)

State directory ऑपरेशनल brainstem है। यदि यह गायब हो जाए, तो आप
sessions, credentials, logs, और config खो देते हैं (जब तक कहीं और बैकअप न हो)।

Doctor जाँचता है:

- **State dir missing**: catastrophic state loss के बारे में चेतावनी देता है, directory फिर से बनाने का प्रॉम्प्ट देता है,
  और याद दिलाता है कि वह खोया हुआ डेटा पुनर्प्राप्त नहीं कर सकता।
- **State dir permissions**: लिखने योग्य होने की पुष्टि करता है; permissions सुधारने का प्रस्ताव देता है
  (और owner/group mismatch मिलने पर `chown` संकेत देता है)।
- **Session dirs missing**: `sessions/` और session store directory
  इतिहास को बनाए रखने और `ENOENT` crashes से बचने के लिए आवश्यक हैं।
- **Transcript mismatch**: हाल की session entries के लिए transcript फ़ाइलें गायब होने पर चेतावनी देता है।
- **Main session “1-line JSONL”**: जब मुख्य transcript में केवल एक पंक्ति हो (इतिहास जमा नहीं हो रहा) तब फ़्लैग करता है।
- **Multiple state dirs**: जब कई `~/.openclaw` फ़ोल्डर अलग-अलग home directories में हों
  या जब `OPENCLAW_STATE_DIR` कहीं और इंगित करता हो (इतिहास इंस्टॉल्स के बीच बँट सकता है) तब चेतावनी देता है।
- **Remote mode reminder**: यदि `gateway.mode=remote`, तो doctor याद दिलाता है कि
  इसे remote host पर चलाएँ (state वहीं रहता है)।
- **Config file permissions**: यदि `~/.openclaw/openclaw.json`
  group/world readable है तो चेतावनी देता है और `600` तक कड़ा करने का प्रस्ताव देता है।

### 5) Model auth स्वास्थ्य (OAuth expiry)

Doctor auth store में OAuth profiles का निरीक्षण करता है, समाप्त/समाप्त होने वाले टोकन पर चेतावनी देता है,
और जहाँ सुरक्षित हो वहाँ उन्हें रीफ़्रेश कर सकता है। यदि Anthropic Claude Code
profile पुराना है, तो यह `claude setup-token` चलाने (या setup-token पेस्ट करने) का सुझाव देता है।
Refresh प्रॉम्प्ट केवल interactive (TTY) में दिखाई देते हैं; `--non-interactive`
refresh प्रयासों को छोड़ देता है।

Doctor उन auth profiles की भी रिपोर्ट करता है जो अस्थायी रूप से अनुपयोगी हैं, कारण:

- छोटे cooldowns (rate limits/timeouts/auth failures)
- लंबे disable (billing/credit failures)

### 6) Hooks model validation

यदि `hooks.gmail.model` सेट है, तो doctor catalog और allowlist के विरुद्ध model reference को validate करता है
और जब वह resolve नहीं होगा या disallowed है तो चेतावनी देता है।

### 7) Sandbox image मरम्मत

जब sandboxing सक्षम हो, doctor Docker images की जाँच करता है और यदि वर्तमान image गायब हो तो
build करने या legacy नामों पर स्विच करने का प्रस्ताव देता है।

### 8) Gateway service माइग्रेशन और cleanup संकेत

Doctor legacy gateway services (launchd/systemd/schtasks) पहचानता है और
उन्हें हटाने तथा वर्तमान gateway port का उपयोग करते हुए OpenClaw service इंस्टॉल करने का प्रस्ताव देता है।
यह अतिरिक्त gateway-जैसी services के लिए स्कैन भी कर सकता है और cleanup संकेत प्रिंट करता है।
Profile-नामित OpenClaw gateway services को first-class माना जाता है और उन्हें "extra" के रूप में फ़्लैग नहीं किया जाता।

### 9) सुरक्षा चेतावनियाँ

Doctor चेतावनियाँ देता है जब कोई provider बिना allowlist के DMs के लिए खुला हो,
या जब कोई policy खतरनाक तरीके से कॉन्फ़िगर की गई हो।

### 10) systemd linger (Linux)

यदि systemd user service के रूप में चल रहा हो, तो doctor सुनिश्चित करता है कि lingering सक्षम हो
ताकि logout के बाद भी gateway जीवित रहे।

### 11) Skills स्थिति

Doctor वर्तमान workspace के लिए eligible/missing/blocked skills का एक त्वरित सारांश प्रिंट करता है।

### 12) Gateway auth जाँच (local token)

Doctor local gateway पर `gateway.auth` के गायब होने पर चेतावनी देता है और
token generate करने का प्रस्ताव देता है। स्वचालन में token
creation को मजबूर करने के लिए `openclaw doctor --generate-gateway-token` का उपयोग करें।

### 13) Gateway स्वास्थ्य जाँच + restart

Doctor स्वास्थ्य जाँच चलाता है और gateway अस्वस्थ दिखने पर restart का प्रस्ताव देता है।

### 14) Channel स्थिति चेतावनियाँ

यदि gateway स्वस्थ है, तो doctor channel status probe चलाता है और
सुझाए गए fixes के साथ चेतावनियाँ रिपोर्ट करता है।

### 15) Supervisor config ऑडिट + मरम्मत

Doctor इंस्टॉल किए गए supervisor config (launchd/systemd/schtasks) में
missing या outdated defaults (जैसे systemd network-online dependencies और
restart delay) की जाँच करता है। mismatch मिलने पर यह अपडेट की सिफ़ारिश करता है और
service file/task को वर्तमान defaults में फिर से लिख सकता है।

Notes:

- `openclaw doctor` supervisor config को फिर से लिखने से पहले प्रॉम्प्ट करता है।
- `openclaw doctor --yes` डिफ़ॉल्ट repair प्रॉम्प्ट स्वीकार करता है।
- `openclaw doctor --repair` बिना प्रॉम्प्ट किए अनुशंसित fixes लागू करता है।
- `openclaw doctor --repair --force` कस्टम supervisor configs को ओवरराइट करता है।
- आप `openclaw gateway install --force` के माध्यम से हमेशा full rewrite को मजबूर कर सकते हैं।

### 16) Gateway runtime + port diagnostics

Doctor service runtime (PID, last exit status) का निरीक्षण करता है और
service इंस्टॉल होने के बावजूद वास्तव में न चलने पर चेतावनी देता है। यह gateway port
(डिफ़ॉल्ट `18789`) पर port collisions की भी जाँच करता है और संभावित कारण
(पहले से चल रहा gateway, SSH टनल) रिपोर्ट करता है।

### 17) Gateway runtime best practices

Doctor चेतावनी देता है जब gateway service Bun पर या version-managed Node path पर चलती है
(`nvm`, `fnm`, `volta`, `asdf`, आदि)। WhatsApp + Telegram चैनलों को Node की आवश्यकता होती है,
और version-manager paths upgrades के बाद टूट सकते हैं क्योंकि service आपकी shell init लोड नहीं करती।
Doctor उपलब्ध होने पर system Node install (Homebrew/apt/choco) में माइग्रेट करने का प्रस्ताव देता है।

### 18) Config लिखना + wizard metadata

Doctor किसी भी config बदलाव को स्थायी करता है और doctor रन को रिकॉर्ड करने के लिए wizard metadata स्टैम्प करता है।

### 19) Workspace सुझाव (backup + memory system)

Doctor यदि workspace memory system गायब हो तो उसका सुझाव देता है और
यदि workspace पहले से git के अंतर्गत न हो तो backup टिप प्रिंट करता है।

Workspace संरचना और git backup (अनुशंसित private GitHub या GitLab) के पूर्ण मार्गदर्शक के लिए
देखें [/concepts/agent-workspace](/concepts/agent-workspace)।
