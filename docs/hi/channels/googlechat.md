---
summary: "Google Chat ऐप समर्थन स्थिति, क्षमताएँ, और विन्यास"
read_when:
  - Google Chat चैनल सुविधाओं पर कार्य करते समय
title: "Google Chat"
x-i18n:
  source_path: channels/googlechat.md
  source_hash: 3d557dd25946ad11
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:49:05Z
---

# Google Chat (Chat API)

स्थिति: Google Chat API वेबहुक्स (केवल HTTP) के माध्यम से DMs + spaces के लिए तैयार।

## त्वरित सेटअप (शुरुआती)

1. एक Google Cloud प्रोजेक्ट बनाएँ और **Google Chat API** सक्षम करें।
   - यहाँ जाएँ: [Google Chat API Credentials](https://console.cloud.google.com/apis/api/chat.googleapis.com/credentials)
   - यदि API पहले से सक्षम नहीं है तो उसे सक्षम करें।
2. एक **Service Account** बनाएँ:
   - **Create Credentials** > **Service Account** पर क्लिक करें।
   - इसे कोई भी नाम दें (उदाहरण: `openclaw-chat`)।
   - अनुमतियाँ खाली छोड़ दें (**Continue** दबाएँ)।
   - पहुँच वाले principals खाली छोड़ दें (**Done** दबाएँ)।
3. **JSON Key** बनाएँ और डाउनलोड करें:
   - Service accounts की सूची में, अभी बनाए गए खाते पर क्लिक करें।
   - **Keys** टैब पर जाएँ।
   - **Add Key** > **Create new key** पर क्लिक करें।
   - **JSON** चुनें और **Create** दबाएँ।
4. डाउनलोड की गई JSON फ़ाइल को अपने Gateway होस्ट पर संग्रहीत करें (उदाहरण: `~/.openclaw/googlechat-service-account.json`)।
5. [Google Cloud Console Chat Configuration](https://console.cloud.google.com/apis/api/chat.googleapis.com/hangouts-chat) में एक Google Chat ऐप बनाएँ:
   - **Application info** भरें:
     - **App name**: (उदाहरण: `OpenClaw`)
     - **Avatar URL**: (उदाहरण: `https://openclaw.ai/logo.png`)
     - **Description**: (उदाहरण: `Personal AI Assistant`)
   - **Interactive features** सक्षम करें।
   - **Functionality** के अंतर्गत **Join spaces and group conversations** चुनें।
   - **Connection settings** के अंतर्गत **HTTP endpoint URL** चुनें।
   - **Triggers** के अंतर्गत **Use a common HTTP endpoint URL for all triggers** चुनें और इसे अपने Gateway के सार्वजनिक URL के बाद `/googlechat` जोड़कर सेट करें।
     - _सुझाव: अपने Gateway का सार्वजनिक URL खोजने के लिए `openclaw status` चलाएँ।_
   - **Visibility** के अंतर्गत **Make this Chat app available to specific people and groups in &lt;Your Domain&gt;** चुनें।
   - टेक्स्ट बॉक्स में अपना ईमेल पता दर्ज करें (उदाहरण: `user@example.com`)।
   - नीचे **Save** पर क्लिक करें।
6. **ऐप स्थिति सक्षम करें**:
   - सहेजने के बाद, **पृष्ठ को रीफ़्रेश करें**।
   - **App status** अनुभाग खोजें (आमतौर पर सहेजने के बाद ऊपर या नीचे होता है)।
   - स्थिति को **Live - available to users** में बदलें।
   - फिर से **Save** पर क्लिक करें।
7. Service account पथ + webhook audience के साथ OpenClaw को विन्यस्त करें:
   - Env: `GOOGLE_CHAT_SERVICE_ACCOUNT_FILE=/path/to/service-account.json`
   - या config: `channels.googlechat.serviceAccountFile: "/path/to/service-account.json"`।
8. webhook audience प्रकार + मान सेट करें (जो आपके Chat ऐप विन्यास से मेल खाता हो)।
9. Gateway प्रारंभ करें। Google Chat आपके webhook पथ पर POST करेगा।

## Google Chat में जोड़ें

जब Gateway चल रहा हो और आपका ईमेल visibility सूची में जोड़ा गया हो:

1. [Google Chat](https://chat.google.com/) पर जाएँ।
2. **Direct Messages** के पास **+** (प्लस) आइकन पर क्लिक करें।
3. खोज बार में (जहाँ आप सामान्यतः लोगों को जोड़ते हैं), Google Cloud Console में विन्यस्त किया गया **App name** टाइप करें।
   - **टिप्पणी:** यह बॉट "Marketplace" ब्राउज़ सूची में _दिखाई नहीं देगा_ क्योंकि यह एक निजी ऐप है। आपको इसे नाम से खोज करना होगा।
4. परिणामों में से अपने बॉट का चयन करें।
5. 1:1 बातचीत शुरू करने के लिए **Add** या **Chat** पर क्लिक करें।
6. सहायक को ट्रिगर करने के लिए "Hello" भेजें!

## सार्वजनिक URL (केवल वेबहुक)

Google Chat वेबहुक्स के लिए एक सार्वजनिक HTTPS endpoint आवश्यक है। सुरक्षा के लिए, **केवल `/googlechat` पथ को ही इंटरनेट पर एक्सपोज़ करें**। OpenClaw डैशबोर्ड और अन्य संवेदनशील endpoints को अपने निजी नेटवर्क पर रखें।

### विकल्प A: Tailscale Funnel (अनुशंसित)

निजी डैशबोर्ड के लिए Tailscale Serve और सार्वजनिक वेबहुक पथ के लिए Funnel का उपयोग करें। इससे `/` निजी रहता है और केवल `/googlechat` एक्सपोज़ होता है।

1. **जाँचें कि आपका Gateway किस पते से बाउंड है:**

   ```bash
   ss -tlnp | grep 18789
   ```

   IP पता नोट करें (उदाहरण: `127.0.0.1`, `0.0.0.0`, या आपका Tailscale IP जैसे `100.x.x.x`)।

2. **डैशबोर्ड को केवल tailnet के लिए एक्सपोज़ करें (पोर्ट 8443):**

   ```bash
   # If bound to localhost (127.0.0.1 or 0.0.0.0):
   tailscale serve --bg --https 8443 http://127.0.0.1:18789

   # If bound to Tailscale IP only (e.g., 100.106.161.80):
   tailscale serve --bg --https 8443 http://100.106.161.80:18789
   ```

3. **केवल वेबहुक पथ को सार्वजनिक रूप से एक्सपोज़ करें:**

   ```bash
   # If bound to localhost (127.0.0.1 or 0.0.0.0):
   tailscale funnel --bg --set-path /googlechat http://127.0.0.1:18789/googlechat

   # If bound to Tailscale IP only (e.g., 100.106.161.80):
   tailscale funnel --bg --set-path /googlechat http://100.106.161.80:18789/googlechat
   ```

4. **Funnel पहुँच के लिए नोड को अधिकृत करें:**
   यदि संकेत दिया जाए, तो आउटपुट में दिखाए गए प्राधिकरण URL पर जाएँ ताकि अपने tailnet नीति में इस नोड के लिए Funnel सक्षम किया जा सके।

5. **विन्यास सत्यापित करें:**

   ```bash
   tailscale serve status
   tailscale funnel status
   ```

आपका सार्वजनिक वेबहुक URL होगा:
`https://<node-name>.<tailnet>.ts.net/googlechat`

आपका निजी डैशबोर्ड केवल tailnet तक सीमित रहेगा:
`https://<node-name>.<tailnet>.ts.net:8443/`

Google Chat ऐप विन्यास में सार्वजनिक URL का उपयोग करें (बिना `:8443` के)।

> टिप्पणी: यह विन्यास रीबूट के बाद भी बना रहता है। बाद में इसे हटाने के लिए `tailscale funnel reset` और `tailscale serve reset` चलाएँ।

### विकल्प B: रिवर्स प्रॉक्सी (Caddy)

यदि आप Caddy जैसा रिवर्स प्रॉक्सी उपयोग करते हैं, तो केवल विशिष्ट पथ को प्रॉक्सी करें:

```caddy
your-domain.com {
    reverse_proxy /googlechat* localhost:18789
}
```

इस विन्यास के साथ, `your-domain.com/` पर आने वाला कोई भी अनुरोध अनदेखा किया जाएगा या 404 लौटाएगा, जबकि `your-domain.com/googlechat` सुरक्षित रूप से OpenClaw तक रूट किया जाएगा।

### विकल्प C: Cloudflare Tunnel

अपने टनल की ingress नियमों को केवल वेबहुक पथ रूट करने के लिए विन्यस्त करें:

- **Path**: `/googlechat` -> `http://localhost:18789/googlechat`
- **Default Rule**: HTTP 404 (Not Found)

## यह कैसे काम करता है

1. Google Chat Gateway को वेबहुक POST भेजता है। प्रत्येक अनुरोध में `Authorization: Bearer <token>` हेडर शामिल होता है।
2. OpenClaw टोकन को विन्यस्त `audienceType` + `audience` के विरुद्ध सत्यापित करता है:
   - `audienceType: "app-url"` → audience आपका HTTPS वेबहुक URL होता है।
   - `audienceType: "project-number"` → audience Cloud प्रोजेक्ट नंबर होता है।
3. संदेश space के अनुसार रूट किए जाते हैं:
   - DMs सत्र कुंजी `agent:<agentId>:googlechat:dm:<spaceId>` का उपयोग करते हैं।
   - Spaces सत्र कुंजी `agent:<agentId>:googlechat:group:<spaceId>` का उपयोग करते हैं।
4. DM पहुँच डिफ़ॉल्ट रूप से pairing होती है। अज्ञात प्रेषकों को pairing कोड मिलता है; इसे स्वीकृत करें:
   - `openclaw pairing approve googlechat <code>`
5. समूह spaces में डिफ़ॉल्ट रूप से @-mention आवश्यक होता है। यदि mention detection को ऐप के उपयोगकर्ता नाम की आवश्यकता हो, तो `botUser` का उपयोग करें।

## लक्ष्य

डिलीवरी और allowlists के लिए इन पहचानकर्ताओं का उपयोग करें:

- Direct messages: `users/<userId>` या `users/<email>` (ईमेल पते स्वीकार्य हैं)।
- Spaces: `spaces/<spaceId>`।

## विन्यास के मुख्य बिंदु

```json5
{
  channels: {
    googlechat: {
      enabled: true,
      serviceAccountFile: "/path/to/service-account.json",
      audienceType: "app-url",
      audience: "https://gateway.example.com/googlechat",
      webhookPath: "/googlechat",
      botUser: "users/1234567890", // optional; helps mention detection
      dm: {
        policy: "pairing",
        allowFrom: ["users/1234567890", "name@example.com"],
      },
      groupPolicy: "allowlist",
      groups: {
        "spaces/AAAA": {
          allow: true,
          requireMention: true,
          users: ["users/1234567890"],
          systemPrompt: "Short answers only.",
        },
      },
      actions: { reactions: true },
      typingIndicator: "message",
      mediaMaxMb: 20,
    },
  },
}
```

टिप्पणियाँ:

- Service account क्रेडेंशियल्स को `serviceAccount` (JSON स्ट्रिंग) के साथ inline भी पास किया जा सकता है।
- यदि `webhookPath` सेट नहीं है, तो डिफ़ॉल्ट वेबहुक पथ `/googlechat` होता है।
- Reactions `reactions` टूल और `channels action` के माध्यम से उपलब्ध हैं जब `actions.reactions` सक्षम हो।
- `typingIndicator` `none`, `message` (डिफ़ॉल्ट), और `reaction` का समर्थन करता है (reaction के लिए user OAuth आवश्यक है)।
- Attachments Chat API के माध्यम से डाउनलोड किए जाते हैं और media pipeline में संग्रहीत होते हैं (आकार सीमा `mediaMaxMb` द्वारा निर्धारित)।

## समस्या-निवारण

### 405 Method Not Allowed

यदि Google Cloud Logs Explorer में इस प्रकार की त्रुटियाँ दिखाई दें:

```
status code: 405, reason phrase: HTTP error response: HTTP/1.1 405 Method Not Allowed
```

इसका अर्थ है कि वेबहुक हैंडलर पंजीकृत नहीं है। सामान्य कारण:

1. **चैनल विन्यस्त नहीं**: आपके config में `channels.googlechat` अनुभाग अनुपस्थित है। जाँचें:

   ```bash
   openclaw config get channels.googlechat
   ```

   यदि यह "Config path not found" लौटाता है, तो विन्यास जोड़ें (देखें [Config highlights](#config-highlights))।

2. **प्लगइन सक्षम नहीं**: प्लगइन स्थिति जाँचें:

   ```bash
   openclaw plugins list | grep googlechat
   ```

   यदि यह "disabled" दिखाता है, तो अपने config में `plugins.entries.googlechat.enabled: true` जोड़ें।

3. **Gateway पुनः आरंभ नहीं किया गया**: config जोड़ने के बाद Gateway को पुनः आरंभ करें:

   ```bash
   openclaw gateway restart
   ```

सत्यापित करें कि चैनल चल रहा है:

```bash
openclaw channels status
# Should show: Google Chat default: enabled, configured, ...
```

### अन्य समस्याएँ

- प्रमाणीकरण त्रुटियों या missing audience config के लिए `openclaw channels status --probe` जाँचें।
- यदि कोई संदेश नहीं पहुँचता, तो Chat ऐप के वेबहुक URL + event subscriptions की पुष्टि करें।
- यदि mention gating उत्तरों को रोकता है, तो `botUser` को ऐप के user resource name पर सेट करें और `requireMention` सत्यापित करें।
- परीक्षण संदेश भेजते समय यह देखने के लिए `openclaw logs --follow` का उपयोग करें कि अनुरोध Gateway तक पहुँच रहे हैं या नहीं।

संबंधित दस्तावेज़:

- [Gateway configuration](/gateway/configuration)
- [Security](/gateway/security)
- [Reactions](/tools/reactions)
