---
summary: "OpenClaw में OAuth: टोकन विनिमय, भंडारण, और बहु‑खाता पैटर्न"
read_when:
  - आप OpenClaw OAuth को एंड‑टू‑एंड समझना चाहते हैं
  - आपको टोकन अमान्यकरण / लॉगआउट की समस्याएँ आ रही हैं
  - आप setup-token या OAuth प्रमाणीकरण प्रवाह चाहते हैं
  - आप कई खाते या प्रोफ़ाइल रूटिंग चाहते हैं
title: "OAuth"
x-i18n:
  source_path: concepts/oauth.md
  source_hash: af714bdadc4a8929
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:49:16Z
---

# OAuth

OpenClaw उन प्रदाताओं के लिए OAuth के माध्यम से “subscription auth” का समर्थन करता है जो इसे प्रदान करते हैं (विशेष रूप से **OpenAI Codex (ChatGPT OAuth)**)। Anthropic सब्सक्रिप्शनों के लिए **setup-token** प्रवाह का उपयोग करें। यह पृष्ठ समझाता है:

- OAuth **टोकन विनिमय** कैसे काम करता है (PKCE)
- टोकन **कहाँ संग्रहीत** होते हैं (और क्यों)
- **कई खातों** को कैसे संभालें (प्रोफ़ाइल + प्रति‑सत्र ओवरराइड)

OpenClaw **provider plugins** का भी समर्थन करता है जो अपने स्वयं के OAuth या API‑key
प्रवाहों के साथ आते हैं। उन्हें इस प्रकार चलाएँ:

```bash
openclaw models auth login --provider <id>
```

## टोकन सिंक (यह क्यों मौजूद है)

OAuth प्रदाता आम तौर पर लॉगिन/रीफ़्रेश प्रवाह के दौरान **नया रिफ़्रेश टोकन** जारी करते हैं। कुछ प्रदाता (या OAuth क्लाइंट) उसी उपयोगकर्ता/ऐप के लिए नया टोकन जारी होने पर पुराने रिफ़्रेश टोकन को अमान्य कर सकते हैं।

व्यावहारिक लक्षण:

- आप OpenClaw _और_ Claude Code / Codex CLI के माध्यम से लॉग इन करते हैं → बाद में इनमें से कोई एक “लॉग आउट” हो जाता है

इसे कम करने के लिए, OpenClaw `auth-profiles.json` को **टोकन सिंक** के रूप में मानता है:

- रनटाइम **एक ही स्थान** से क्रेडेंशियल पढ़ता है
- हम कई प्रोफ़ाइल रख सकते हैं और उन्हें निर्धारक रूप से रूट कर सकते हैं

## भंडारण (टोकन कहाँ रहते हैं)

सीक्रेट्स **प्रति‑एजेंट** संग्रहीत होते हैं:

- Auth प्रोफ़ाइल (OAuth + API keys): `~/.openclaw/agents/<agentId>/agent/auth-profiles.json`
- रनटाइम कैश (स्वचालित रूप से प्रबंधित; संपादित न करें): `~/.openclaw/agents/<agentId>/agent/auth.json`

विरासत आयात‑केवल फ़ाइल (अब भी समर्थित, लेकिन मुख्य स्टोर नहीं):

- `~/.openclaw/credentials/oauth.json` (पहली बार उपयोग पर `auth-profiles.json` में आयात)

उपरोक्त सभी `$OPENCLAW_STATE_DIR` (state dir override) का भी सम्मान करते हैं। पूर्ण संदर्भ: [/gateway/configuration](/gateway/configuration#auth-storage-oauth--api-keys)

## Anthropic setup-token (subscription auth)

किसी भी मशीन पर `claude setup-token` चलाएँ, फिर इसे OpenClaw में पेस्ट करें:

```bash
openclaw models auth setup-token --provider anthropic
```

यदि आपने टोकन कहीं और जनरेट किया है, तो उसे मैन्युअली पेस्ट करें:

```bash
openclaw models auth paste-token --provider anthropic
```

सत्यापित करें:

```bash
openclaw models status
```

## OAuth विनिमय (लॉगिन कैसे काम करता है)

OpenClaw के इंटरैक्टिव लॉगिन प्रवाह `@mariozechner/pi-ai` में कार्यान्वित हैं और विज़ार्ड/कमांड्स से जुड़े हैं।

### Anthropic (Claude Pro/Max) setup-token

प्रवाह का स्वरूप:

1. `claude setup-token` चलाएँ
2. टोकन को OpenClaw में पेस्ट करें
3. टोकन auth प्रोफ़ाइल के रूप में संग्रहीत करें (रीफ़्रेश नहीं)

विज़ार्ड पथ है `openclaw onboard` → auth विकल्प `setup-token` (Anthropic)।

### OpenAI Codex (ChatGPT OAuth)

प्रवाह का स्वरूप (PKCE):

1. PKCE verifier/challenge + रैंडम `state` जनरेट करें
2. `https://auth.openai.com/oauth/authorize?...` खोलें
3. `http://127.0.0.1:1455/auth/callback` पर कॉलबैक कैप्चर करने का प्रयास करें
4. यदि कॉलबैक बाइंड नहीं हो पाता (या आप रिमोट/हेडलेस हैं), तो रीडायरेक्ट URL/कोड पेस्ट करें
5. `https://auth.openai.com/oauth/token` पर एक्सचेंज करें
6. एक्सेस टोकन से `accountId` निकालें और `{ access, refresh, expires, accountId }` संग्रहीत करें

विज़ार्ड पथ है `openclaw onboard` → auth विकल्प `openai-codex`।

## रीफ़्रेश + समाप्ति

प्रोफ़ाइल एक `expires` टाइमस्टैम्प संग्रहीत करती हैं।

रनटाइम पर:

- यदि `expires` भविष्य में है → संग्रहीत एक्सेस टोकन का उपयोग करें
- यदि समाप्त हो गया है → (फ़ाइल लॉक के तहत) रीफ़्रेश करें और संग्रहीत क्रेडेंशियल ओवरराइट करें

रीफ़्रेश प्रवाह स्वचालित है; सामान्यतः आपको टोकन मैन्युअली प्रबंधित करने की आवश्यकता नहीं होती।

## कई खाते (प्रोफ़ाइल) + रूटिंग

दो पैटर्न:

### 1) पसंदीदा: अलग‑अलग एजेंट

यदि आप चाहते हैं कि “व्यक्तिगत” और “कार्य” कभी इंटरैक्ट न करें, तो अलग‑थलग एजेंट उपयोग करें (अलग सत्र + क्रेडेंशियल + वर्कस्पेस):

```bash
openclaw agents add work
openclaw agents add personal
```

फिर प्रति‑एजेंट auth कॉन्फ़िगर करें (विज़ार्ड) और चैट्स को सही एजेंट पर रूट करें।

### 2) उन्नत: एक एजेंट में कई प्रोफ़ाइल

`auth-profiles.json` उसी प्रदाता के लिए कई प्रोफ़ाइल IDs का समर्थन करता है।

कौन‑सी प्रोफ़ाइल उपयोग होगी, चुनें:

- कॉन्फ़िग ऑर्डरिंग के माध्यम से वैश्विक रूप से (`auth.order`)
- प्रति‑सत्र `/model ...@<profileId>` के माध्यम से

उदाहरण (सत्र ओवरराइड):

- `/model Opus@anthropic:work`

कौन‑कौन से प्रोफ़ाइल IDs मौजूद हैं, यह कैसे देखें:

- `openclaw channels list --json` (`auth[]` दिखाता है)

संबंधित दस्तावेज़:

- [/concepts/model-failover](/concepts/model-failover) (रोटेशन + कूलडाउन नियम)
- [/tools/slash-commands](/tools/slash-commands) (कमांड सतह)
