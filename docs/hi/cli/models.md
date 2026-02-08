---
summary: "`openclaw models` के लिए CLI संदर्भ (status/list/set/scan, उपनाम, फॉलबैक, प्रमाणीकरण)"
read_when:
  - आप डिफ़ॉल्ट मॉडल बदलना चाहते हैं या प्रदाता प्रमाणीकरण स्थिति देखना चाहते हैं
  - आप उपलब्ध मॉडल/प्रदाताओं को स्कैन करना और प्रमाणीकरण प्रोफ़ाइलों का डिबग करना चाहते हैं
title: "मॉडल्स"
x-i18n:
  source_path: cli/models.md
  source_hash: 923b6ffc7de382ba
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:49:06Z
---

# `openclaw models`

मॉडल डिस्कवरी, स्कैनिंग और विन्यास (डिफ़ॉल्ट मॉडल, फॉलबैक, प्रमाणीकरण प्रोफ़ाइल).

संबंधित:

- प्रदाता + मॉडल: [Models](/providers/models)
- प्रदाता प्रमाणीकरण सेटअप: [Getting started](/start/getting-started)

## सामान्य कमांड

```bash
openclaw models status
openclaw models list
openclaw models set <model-or-alias>
openclaw models scan
```

`openclaw models status` समाधान किए गए डिफ़ॉल्ट/फॉलबैक के साथ प्रमाणीकरण का अवलोकन दिखाता है।
जब प्रदाता उपयोग स्नैपशॉट उपलब्ध होते हैं, तो OAuth/टोकन स्थिति अनुभाग में
प्रदाता उपयोग हेडर शामिल होते हैं।
प्रत्येक विन्यस्त प्रदाता प्रोफ़ाइल के विरुद्ध लाइव प्रमाणीकरण प्रोब चलाने के लिए `--probe` जोड़ें।
प्रोब वास्तविक अनुरोध होते हैं (टोकन खर्च कर सकते हैं और दर-सीमाएँ ट्रिगर कर सकते हैं)।
विन्यस्त एजेंट के मॉडल/प्रमाणीकरण स्थिति का निरीक्षण करने के लिए `--agent <id>` का उपयोग करें। यदि छोड़ा गया,
तो कमांड `OPENCLAW_AGENT_DIR`/`PI_CODING_AGENT_DIR` का उपयोग करता है यदि सेट हों, अन्यथा
विन्यस्त डिफ़ॉल्ट एजेंट का उपयोग करता है।

नोट्स:

- `models set <model-or-alias>` `provider/model` या किसी उपनाम को स्वीकार करता है।
- मॉडल संदर्भ **पहले** `/` पर विभाजित करके पार्स किए जाते हैं। यदि मॉडल ID में `/` (OpenRouter-शैली) शामिल है, तो प्रदाता उपसर्ग शामिल करें (उदाहरण: `openrouter/moonshotai/kimi-k2`)।
- यदि आप प्रदाता छोड़ देते हैं, तो OpenClaw इनपुट को डिफ़ॉल्ट प्रदाता के लिए एक उपनाम या मॉडल के रूप में मानता है (यह केवल तब काम करता है जब मॉडल ID में `/` न हो)।

### `models status`

विकल्प:

- `--json`
- `--plain`
- `--check` (एग्ज़िट 1=समाप्त/अनुपस्थित, 2=समाप्ति के निकट)
- `--probe` (विन्यस्त प्रमाणीकरण प्रोफ़ाइलों का लाइव प्रोब)
- `--probe-provider <name>` (एक प्रदाता को प्रोब करें)
- `--probe-profile <id>` (दोहराएँ या अल्पविराम-सेपरेटेड प्रोफ़ाइल आईडी)
- `--probe-timeout <ms>`
- `--probe-concurrency <n>`
- `--probe-max-tokens <n>`
- `--agent <id>` (विन्यस्त एजेंट आईडी; `OPENCLAW_AGENT_DIR`/`PI_CODING_AGENT_DIR` को ओवरराइड करता है)

## उपनाम + फॉलबैक

```bash
openclaw models aliases list
openclaw models fallbacks list
```

## प्रमाणीकरण प्रोफ़ाइल

```bash
openclaw models auth add
openclaw models auth login --provider <id>
openclaw models auth setup-token
openclaw models auth paste-token
```

`models auth login` किसी प्रदाता प्लगइन का प्रमाणीकरण प्रवाह (OAuth/एपीआई कुंजी) चलाता है। कौन-से प्रदाता इंस्टॉल हैं यह देखने के लिए
`openclaw plugins list` का उपयोग करें।

नोट्स:

- `setup-token` सेटअप-टोकन मान के लिए संकेत देता है (इसे किसी भी मशीन पर `claude setup-token` के साथ जनरेट करें)।
- `paste-token` किसी अन्य स्थान पर या स्वचालन से जनरेट की गई टोकन स्ट्रिंग स्वीकार करता है।
