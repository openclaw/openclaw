---
summary: "मॉडल प्रमाणीकरण: OAuth, API कुंजियाँ, और सेटअप-टोकन"
read_when:
  - मॉडल प्रमाणीकरण या OAuth की समाप्ति का डीबगिंग
  - प्रमाणीकरण या क्रेडेंशियल संग्रहण का दस्तावेज़ीकरण
title: "प्रमाणीकरण"
---

# प्रमाणीकरण

49. OpenClaw model providers के लिए OAuth और API keys का समर्थन करता है। 50. Anthropic
    accounts के लिए, हम **API key** का उपयोग करने की सिफारिश करते हैं। 1. Claude सब्सक्रिप्शन एक्सेस के लिए,
    `claude setup-token` द्वारा बनाया गया long‑lived token उपयोग करें।

पूर्ण OAuth फ़्लो और संग्रहण लेआउट के लिए [/concepts/oauth](/concepts/oauth) देखें।

## अनुशंसित Anthropic सेटअप (API कुंजी)

यदि आप Anthropic का सीधे उपयोग कर रहे हैं, तो API कुंजी का उपयोग करें।

1. Anthropic Console में एक API कुंजी बनाएँ।
2. इसे **Gateway होस्ट** (वह मशीन जिस पर `openclaw gateway` चल रहा है) पर रखें।

```bash
export ANTHROPIC_API_KEY="..."
openclaw models status
```

3. यदि Gateway systemd/launchd के अंतर्गत चलता है, तो कुंजी को
   `~/.openclaw/.env` में रखना बेहतर है ताकि डेमन उसे पढ़ सके:

```bash
cat >> ~/.openclaw/.env <<'EOF'
ANTHROPIC_API_KEY=...
EOF
```

फिर डेमन को पुनः प्रारंभ करें (या अपने Gateway प्रक्रिया को पुनः प्रारंभ करें) और दोबारा जाँचें:

```bash
openclaw models status
openclaw doctor
```

यदि आप स्वयं env vars प्रबंधित नहीं करना चाहते, तो ऑनबोर्डिंग विज़ार्ड डेमन उपयोग के लिए
API कुंजियाँ संग्रहीत कर सकता है: `openclaw onboard`।

env inheritance के विवरण के लिए [Help](/help) देखें (`env.shellEnv`,
`~/.openclaw/.env`, systemd/launchd)।

## Anthropic: सेटअप-टोकन (सदस्यता प्रमाणीकरण)

2. Anthropic के लिए, अनुशंसित तरीका **API key** है। 3. यदि आप Claude
   सब्सक्रिप्शन का उपयोग कर रहे हैं, तो setup-token flow भी समर्थित है। 4. इसे **gateway host** पर चलाएँ:

```bash
claude setup-token
```

फिर इसे OpenClaw में पेस्ट करें:

```bash
openclaw models auth setup-token --provider anthropic
```

यदि टोकन किसी अन्य मशीन पर बनाया गया था, तो उसे मैन्युअल रूप से पेस्ट करें:

```bash
openclaw models auth paste-token --provider anthropic
```

यदि आपको Anthropic की कोई त्रुटि दिखाई दे, जैसे:

```
This credential is only authorized for use with Claude Code and cannot be used for other API requests.
```

…तो इसके बजाय Anthropic API कुंजी का उपयोग करें।

मैन्युअल टोकन प्रविष्टि (किसी भी प्रदाता के लिए; `auth-profiles.json` लिखता है + विन्यास अपडेट करता है):

```bash
openclaw models auth paste-token --provider anthropic
openclaw models auth paste-token --provider openrouter
```

ऑटोमेशन‑अनुकूल जाँच (समाप्त/अनुपस्थित होने पर `1` के साथ निकास, समाप्ति के करीब होने पर `2`):

```bash
openclaw models status --check
```

वैकल्पिक ops स्क्रिप्ट (systemd/Termux) यहाँ प्रलेखित हैं:
[/automation/auth-monitoring](/automation/auth-monitoring)

> `claude setup-token` के लिए एक इंटरैक्टिव TTY आवश्यक है।

## मॉडल प्रमाणीकरण स्थिति जाँचें

```bash
openclaw models status
openclaw doctor
```

## किस क्रेडेंशियल का उपयोग किया जाए, इसे नियंत्रित करना

### प्रति‑सत्र (चैट कमांड)

वर्तमान सत्र के लिए किसी विशिष्ट प्रदाता क्रेडेंशियल को पिन करने हेतु `/model <alias-or-id>@<profileId>` का उपयोग करें
(उदाहरण प्रोफ़ाइल आईडी: `anthropic:default`, `anthropic:work`)।

कॉम्पैक्ट पिकर के लिए `/model` (या `/model list`) का उपयोग करें; पूर्ण दृश्य के लिए
`/model status` का उपयोग करें (उम्मीदवार + अगला auth प्रोफ़ाइल, तथा विन्यस्त होने पर प्रदाता एंडपॉइंट विवरण)।

### प्रति‑एजेंट (CLI ओवरराइड)

किसी एजेंट के लिए स्पष्ट auth प्रोफ़ाइल क्रम ओवरराइड सेट करें (उस एजेंट के `auth-profiles.json` में संग्रहीत):

```bash
openclaw models auth order get --provider anthropic
openclaw models auth order set --provider anthropic anthropic:default
openclaw models auth order clear --provider anthropic
```

किसी विशिष्ट एजेंट को लक्षित करने के लिए `--agent <id>` का उपयोग करें; इसे छोड़ने पर विन्यस्त डिफ़ॉल्ट एजेंट उपयोग होगा।

## समस्या-निवारण

### “No credentials found”

यदि Anthropic टोकन प्रोफ़ाइल अनुपस्थित है, तो **Gateway होस्ट** पर `claude setup-token` चलाएँ,
फिर दोबारा जाँचें:

```bash
openclaw models status
```

### टोकन समाप्ति के करीब/समाप्त

5. कौन‑सा प्रोफ़ाइल समाप्त होने वाला है यह पुष्टि करने के लिए `openclaw models status` चलाएँ। 6. यदि प्रोफ़ाइल
   गायब है, तो `claude setup-token` फिर से चलाएँ और टोकन दोबारा पेस्ट करें।

## आवश्यकताएँ

- Claude Max या Pro सदस्यता (`claude setup-token` के लिए)
- Claude Code CLI स्थापित (`claude` कमांड उपलब्ध)
