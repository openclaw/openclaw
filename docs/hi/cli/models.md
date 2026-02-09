---
summary: "`openclaw models` के लिए CLI संदर्भ (status/list/set/scan, उपनाम, फॉलबैक, प्रमाणीकरण)"
read_when:
  - आप डिफ़ॉल्ट मॉडल बदलना चाहते हैं या प्रदाता प्रमाणीकरण स्थिति देखना चाहते हैं
  - आप उपलब्ध मॉडल/प्रदाताओं को स्कैन करना और प्रमाणीकरण प्रोफ़ाइलों का डिबग करना चाहते हैं
title: "मॉडल्स"
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

`openclaw models status` shows the resolved default/fallbacks plus an auth overview.
When provider usage snapshots are available, the OAuth/token status section includes
provider usage headers.
Add `--probe` to run live auth probes against each configured provider profile.
Probes are real requests (may consume tokens and trigger rate limits).
Use `--agent <id>` to inspect a configured agent’s model/auth state. When omitted,
the command uses `OPENCLAW_AGENT_DIR`/`PI_CODING_AGENT_DIR` if set, otherwise the
configured default agent.

नोट्स:

- `models set <model-or-alias>` `provider/model` या किसी उपनाम को स्वीकार करता है।
- Model refs are parsed by splitting on the **first** `/`. If the model ID includes `/` (OpenRouter-style), include the provider prefix (example: `openrouter/moonshotai/kimi-k2`).
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

`models auth login` runs a provider plugin’s auth flow (OAuth/API key). Use
`openclaw plugins list` to see which providers are installed.

नोट्स:

- `setup-token` सेटअप-टोकन मान के लिए संकेत देता है (इसे किसी भी मशीन पर `claude setup-token` के साथ जनरेट करें)।
- `paste-token` किसी अन्य स्थान पर या स्वचालन से जनरेट की गई टोकन स्ट्रिंग स्वीकार करता है।
