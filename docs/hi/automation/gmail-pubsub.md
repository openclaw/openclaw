---
summary: "gogcli के माध्यम से OpenClaw वेबहुक्स में एकीकृत Gmail Pub/Sub पुश"
read_when:
  - Gmail इनबॉक्स ट्रिगर्स को OpenClaw से जोड़ना
  - एजेंट वेक के लिए Pub/Sub पुश सेट करना
title: "Gmail PubSub"
x-i18n:
  source_path: automation/gmail-pubsub.md
  source_hash: dfb92133b69177e4
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:49:00Z
---

# Gmail Pub/Sub -> OpenClaw

लक्ष्य: Gmail watch -> Pub/Sub push -> `gog gmail watch serve` -> OpenClaw webhook।

## पूर्वापेक्षाएँ

- `gcloud` इंस्टॉल और लॉग इन ([install guide](https://docs.cloud.google.com/sdk/docs/install-sdk)).
- `gog` (gogcli) इंस्टॉल और Gmail खाते के लिए अधिकृत ([gogcli.sh](https://gogcli.sh/)).
- OpenClaw hooks सक्षम (देखें [Webhooks](/automation/webhook)).
- `tailscale` लॉग इन ([tailscale.com](https://tailscale.com/)). समर्थित सेटअप सार्वजनिक HTTPS एंडपॉइंट के लिए Tailscale Funnel का उपयोग करता है।
  अन्य टनल सेवाएँ काम कर सकती हैं, लेकिन वे DIY/असमर्थित हैं और मैन्युअल वायरिंग की आवश्यकता होती है।
  फिलहाल, हम Tailscale का समर्थन करते हैं।

उदाहरण hook config (Gmail preset mapping सक्षम करें):

```json5
{
  hooks: {
    enabled: true,
    token: "OPENCLAW_HOOK_TOKEN",
    path: "/hooks",
    presets: ["gmail"],
  },
}
```

Gmail सारांश को किसी चैट सतह पर पहुँचाने के लिए, preset को ऐसे mapping से ओवरराइड करें
जो `deliver` + वैकल्पिक `channel`/`to` सेट करता हो:

```json5
{
  hooks: {
    enabled: true,
    token: "OPENCLAW_HOOK_TOKEN",
    presets: ["gmail"],
    mappings: [
      {
        match: { path: "gmail" },
        action: "agent",
        wakeMode: "now",
        name: "Gmail",
        sessionKey: "hook:gmail:{{messages[0].id}}",
        messageTemplate: "New email from {{messages[0].from}}\nSubject: {{messages[0].subject}}\n{{messages[0].snippet}}\n{{messages[0].body}}",
        model: "openai/gpt-5.2-mini",
        deliver: true,
        channel: "last",
        // to: "+15551234567"
      },
    ],
  },
}
```

यदि आप एक स्थिर चैनल चाहते हैं, तो `channel` + `to` सेट करें। अन्यथा `channel: "last"`
अंतिम डिलीवरी रूट का उपयोग करता है (डिफ़ॉल्ट रूप से WhatsApp पर वापस जाता है)।

Gmail रन के लिए सस्ता मॉडल बाध्य करने हेतु, mapping में `model` सेट करें
(`provider/model` या उपनाम)। यदि आप `agents.defaults.models` लागू करते हैं, तो उसे वहीं शामिल करें।

Gmail hooks के लिए विशेष रूप से डिफ़ॉल्ट मॉडल और थिंकिंग लेवल सेट करने हेतु,
अपने config में `hooks.gmail.model` / `hooks.gmail.thinking` जोड़ें:

```json5
{
  hooks: {
    gmail: {
      model: "openrouter/meta-llama/llama-3.3-70b-instruct:free",
      thinking: "off",
    },
  },
}
```

नोट्स:

- mapping में प्रति-hook `model`/`thinking` अभी भी इन डिफ़ॉल्ट्स को ओवरराइड करता है।
- फॉलबैक क्रम: `hooks.gmail.model` → `agents.defaults.model.fallbacks` → प्राथमिक (auth/rate-limit/timeouts)।
- यदि `agents.defaults.models` सेट है, तो Gmail मॉडल allowlist में होना चाहिए।
- Gmail hook सामग्री डिफ़ॉल्ट रूप से external-content सुरक्षा सीमाओं के साथ रैप की जाती है।
  अक्षम करने के लिए (खतरनाक), `hooks.gmail.allowUnsafeExternalContent: true` सेट करें।

पेलोड हैंडलिंग को और अनुकूलित करने के लिए, `hooks.mappings` जोड़ें या
`hooks.transformsDir` के अंतर्गत JS/TS ट्रांसफ़ॉर्म मॉड्यूल जोड़ें
(देखें [Webhooks](/automation/webhook))।

## विज़ार्ड (अनुशंसित)

सब कुछ एक साथ वायर करने के लिए OpenClaw हेल्पर का उपयोग करें (macOS पर brew के माध्यम से deps इंस्टॉल करता है):

```bash
openclaw webhooks gmail setup \
  --account openclaw@gmail.com
```

डिफ़ॉल्ट्स:

- सार्वजनिक पुश एंडपॉइंट के लिए Tailscale Funnel का उपयोग करता है।
- `openclaw webhooks gmail run` के लिए `hooks.gmail` config लिखता है।
- Gmail hook preset (`hooks.presets: ["gmail"]`) सक्षम करता है।

पाथ नोट: जब `tailscale.mode` सक्षम होता है, तो OpenClaw स्वचालित रूप से
`hooks.gmail.serve.path` को `/` पर सेट करता है और सार्वजनिक पाथ को
`hooks.gmail.tailscale.path` (डिफ़ॉल्ट `/gmail-pubsub`) पर बनाए रखता है क्योंकि Tailscale
प्रॉक्सी करने से पहले set-path प्रीफ़िक्स हटा देता है।
यदि आपको बैकएंड को प्रीफ़िक्स्ड पाथ प्राप्त कराना है, तो
`hooks.gmail.tailscale.target` (या `--tailscale-target`) को
`http://127.0.0.1:8788/gmail-pubsub` जैसे पूर्ण URL पर सेट करें और `hooks.gmail.serve.path` से मेल कराएँ।

कस्टम एंडपॉइंट चाहते हैं? `--push-endpoint <url>` या `--tailscale off` का उपयोग करें।

प्लैटफ़ॉर्म नोट: macOS पर विज़ार्ड `gcloud`, `gogcli`, और `tailscale`
Homebrew के माध्यम से इंस्टॉल करता है; Linux पर इन्हें पहले मैन्युअली इंस्टॉल करें।

Gateway ऑटो-स्टार्ट (अनुशंसित):

- जब `hooks.enabled=true` और `hooks.gmail.account` सेट होता है, तो Gateway बूट पर
  `gog gmail watch serve` शुरू करता है और watch को स्वतः नवीनीकृत करता है।
- ऑप्ट आउट करने के लिए `OPENCLAW_SKIP_GMAIL_WATCHER=1` सेट करें (उपयोगी यदि आप डेमन स्वयं चलाते हैं)।
- मैन्युअल डेमन को एक ही समय पर न चलाएँ, अन्यथा
  `listen tcp 127.0.0.1:8788: bind: address already in use` का सामना करेंगे।

मैन्युअल डेमन ( `gog gmail watch serve` शुरू करता है + ऑटो-रिन्यू):

```bash
openclaw webhooks gmail run
```

## एक-बार का सेटअप

1. उस GCP प्रोजेक्ट का चयन करें **जो OAuth क्लाइंट का स्वामी है** जिसका उपयोग `gog` करता है।

```bash
gcloud auth login
gcloud config set project <project-id>
```

नोट: Gmail watch के लिए Pub/Sub टॉपिक उसी प्रोजेक्ट में होना आवश्यक है जिसमें OAuth क्लाइंट है।

2. APIs सक्षम करें:

```bash
gcloud services enable gmail.googleapis.com pubsub.googleapis.com
```

3. एक टॉपिक बनाएँ:

```bash
gcloud pubsub topics create gog-gmail-watch
```

4. Gmail push को प्रकाशित करने की अनुमति दें:

```bash
gcloud pubsub topics add-iam-policy-binding gog-gmail-watch \
  --member=serviceAccount:gmail-api-push@system.gserviceaccount.com \
  --role=roles/pubsub.publisher
```

## watch शुरू करें

```bash
gog gmail watch start \
  --account openclaw@gmail.com \
  --label INBOX \
  --topic projects/<project-id>/topics/gog-gmail-watch
```

आउटपुट से `history_id` सहेजें (डिबगिंग के लिए)।

## पुश हैंडलर चलाएँ

लोकल उदाहरण (shared token auth):

```bash
gog gmail watch serve \
  --account openclaw@gmail.com \
  --bind 127.0.0.1 \
  --port 8788 \
  --path /gmail-pubsub \
  --token <shared> \
  --hook-url http://127.0.0.1:18789/hooks/gmail \
  --hook-token OPENCLAW_HOOK_TOKEN \
  --include-body \
  --max-bytes 20000
```

नोट्स:

- `--token` पुश एंडपॉइंट (`x-gog-token` या `?token=`) की सुरक्षा करता है।
- `--hook-url` OpenClaw `/hooks/gmail` की ओर इशारा करता है (मैप्ड; आइसोलेटेड रन + मुख्य को सारांश)।
- `--include-body` और `--max-bytes` OpenClaw को भेजे जाने वाले बॉडी स्निपेट को नियंत्रित करते हैं।

अनुशंसित: `openclaw webhooks gmail run` उसी फ़्लो को रैप करता है और watch को स्वतः नवीनीकृत करता है।

## हैंडलर को एक्सपोज़ करें (उन्नत, असमर्थित)

यदि आपको non-Tailscale टनल की आवश्यकता है, तो इसे मैन्युअली वायर करें और पुश
सब्सक्रिप्शन में सार्वजनिक URL का उपयोग करें (असमर्थित, बिना गार्डरेल्स):

```bash
cloudflared tunnel --url http://127.0.0.1:8788 --no-autoupdate
```

जेनरेटेड URL को पुश एंडपॉइंट के रूप में उपयोग करें:

```bash
gcloud pubsub subscriptions create gog-gmail-watch-push \
  --topic gog-gmail-watch \
  --push-endpoint "https://<public-url>/gmail-pubsub?token=<shared>"
```

प्रोडक्शन: एक स्थिर HTTPS एंडपॉइंट का उपयोग करें और Pub/Sub OIDC JWT कॉन्फ़िगर करें, फिर चलाएँ:

```bash
gog gmail watch serve --verify-oidc --oidc-email <svc@...>
```

## परीक्षण

वॉच किए गए इनबॉक्स पर एक संदेश भेजें:

```bash
gog gmail send \
  --account openclaw@gmail.com \
  --to openclaw@gmail.com \
  --subject "watch test" \
  --body "ping"
```

watch स्थिति और इतिहास जाँचें:

```bash
gog gmail watch status --account openclaw@gmail.com
gog gmail history --account openclaw@gmail.com --since <historyId>
```

## समस्या-निवारण

- `Invalid topicName`: प्रोजेक्ट मिसमैच (टॉपिक OAuth क्लाइंट प्रोजेक्ट में नहीं है)।
- `User not authorized`: टॉपिक पर `roles/pubsub.publisher` अनुपस्थित।
- खाली संदेश: Gmail push केवल `historyId` प्रदान करता है; `gog gmail history` के माध्यम से फ़ेच करें।

## सफ़ाई

```bash
gog gmail watch stop --account openclaw@gmail.com
gcloud pubsub subscriptions delete gog-gmail-watch-push
gcloud pubsub topics delete gog-gmail-watch
```
