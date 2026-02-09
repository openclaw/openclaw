---
summary: "Zalo बॉट समर्थन स्थिति, क्षमताएँ और विन्यास"
read_when:
  - Zalo सुविधाओं या वेबहुक्स पर काम करते समय
title: "Zalo"
---

# Zalo (Bot API)

Status: experimental. Direct messages only; groups coming soon per Zalo docs.

## आवश्यक प्लगइन

Zalo एक प्लगइन के रूप में उपलब्ध है और कोर इंस्टॉल में शामिल नहीं है।

- CLI के माध्यम से इंस्टॉल करें: `openclaw plugins install @openclaw/zalo`
- या ऑनबोर्डिंग के दौरान **Zalo** चुनें और इंस्टॉल प्रॉम्प्ट की पुष्टि करें
- विवरण: [Plugins](/tools/plugin)

## त्वरित सेटअप (शुरुआती)

1. Zalo प्लगइन इंस्टॉल करें:
   - सोर्स चेकआउट से: `openclaw plugins install ./extensions/zalo`
   - npm से (यदि प्रकाशित हो): `openclaw plugins install @openclaw/zalo`
   - या ऑनबोर्डिंग में **Zalo** चुनें और इंस्टॉल प्रॉम्प्ट की पुष्टि करें
2. टोकन सेट करें:
   - Env: `ZALO_BOT_TOKEN=...`
   - या config: `channels.zalo.botToken: "..."`.
3. Gateway को पुनः प्रारंभ करें (या ऑनबोर्डिंग पूर्ण करें)।
4. DM एक्सेस डिफ़ॉल्ट रूप से pairing है; पहली बार संपर्क पर pairing कोड स्वीकृत करें।

न्यूनतम विन्यास:

```json5
{
  channels: {
    zalo: {
      enabled: true,
      botToken: "12345689:abc-xyz",
      dmPolicy: "pairing",
    },
  },
}
```

## यह क्या है

Zalo is a Vietnam-focused messaging app; its Bot API lets the Gateway run a bot for 1:1 conversations.
It is a good fit for support or notifications where you want deterministic routing back to Zalo.

- Gateway के स्वामित्व वाला Zalo Bot API चैनल।
- निश्चित रूटिंग: उत्तर Zalo पर ही वापस जाते हैं; मॉडल चैनल नहीं चुनता।
- DMs एजेंट के मुख्य सत्र को साझा करते हैं।
- समूह अभी समर्थित नहीं हैं (Zalo दस्तावेज़ों में “coming soon” कहा गया है)।

## सेटअप (त्वरित मार्ग)

### 1. बॉट टोकन बनाएँ (Zalo Bot Platform)

1. [https://bot.zaloplatforms.com](https://bot.zaloplatforms.com) पर जाएँ और साइन इन करें।
2. नया बॉट बनाएँ और उसकी सेटिंग्स कॉन्फ़िगर करें।
3. बॉट टोकन कॉपी करें (फ़ॉर्मैट: `12345689:abc-xyz`)।

### 2) टोकन कॉन्फ़िगर करें (env या config)

उदाहरण:

```json5
{
  channels: {
    zalo: {
      enabled: true,
      botToken: "12345689:abc-xyz",
      dmPolicy: "pairing",
    },
  },
}
```

Env विकल्प: `ZALO_BOT_TOKEN=...` (केवल डिफ़ॉल्ट अकाउंट के लिए काम करता है)।

मल्टी-अकाउंट समर्थन: प्रति-अकाउंट टोकन और वैकल्पिक `name` के साथ `channels.zalo.accounts` का उपयोग करें।

3. Gateway को पुनः आरंभ करें। Zalo starts when a token is resolved (env or config).
4. DM access defaults to pairing. Approve the code when the bot is first contacted.

## यह कैसे काम करता है (व्यवहार)

- इनबाउंड संदेशों को मीडिया प्लेसहोल्डर्स के साथ साझा चैनल एनवेलप में सामान्यीकृत किया जाता है।
- उत्तर हमेशा उसी Zalo चैट पर वापस रूट होते हैं।
- डिफ़ॉल्ट रूप से लॉन्ग-पोलिंग; `channels.zalo.webhookUrl` के साथ वेबहुक मोड उपलब्ध है।

## सीमाएँ

- आउटबाउंड टेक्स्ट को 2000 अक्षरों में विभाजित किया जाता है (Zalo API सीमा)।
- मीडिया डाउनलोड/अपलोड `channels.zalo.mediaMaxMb` द्वारा सीमित हैं (डिफ़ॉल्ट 5)।
- 2000 अक्षर सीमा के कारण स्ट्रीमिंग कम उपयोगी होने से डिफ़ॉल्ट रूप से ब्लॉक है।

## प्रवेश नियंत्रण (DMs)

### DM एक्सेस

- डिफ़ॉल्ट: `channels.zalo.dmPolicy = "pairing"`। अज्ञात प्रेषकों को एक पेयरिंग कोड मिलता है; स्वीकृति तक संदेश अनदेखे रहते हैं (कोड 1 घंटे बाद समाप्त हो जाते हैं)।
- स्वीकृति के तरीके:
  - `openclaw pairing list zalo`
  - `openclaw pairing approve zalo <CODE>`
- Pairing is the default token exchange. Details: [Pairing](/channels/pairing)
- `channels.zalo.allowFrom` संख्यात्मक यूज़र आईडी स्वीकार करता है (यूज़रनेम लुकअप उपलब्ध नहीं)।

## लॉन्ग-पोलिंग बनाम वेबहुक

- डिफ़ॉल्ट: लॉन्ग-पोलिंग (सार्वजनिक URL की आवश्यकता नहीं)।
- वेबहुक मोड: `channels.zalo.webhookUrl` और `channels.zalo.webhookSecret` सेट करें।
  - वेबहुक सीक्रेट 8–256 अक्षरों का होना चाहिए।
  - वेबहुक URL को HTTPS का उपयोग करना चाहिए।
  - Zalo सत्यापन के लिए `X-Bot-Api-Secret-Token` हेडर के साथ इवेंट भेजता है।
  - Gateway HTTP वेबहुक अनुरोधों को `channels.zalo.webhookPath` पर हैंडल करता है (डिफ़ॉल्ट रूप से वेबहुक URL पाथ)।

**टिप्पणी:** Zalo API दस्तावेज़ों के अनुसार getUpdates (polling) और वेबहुक परस्पर अनन्य हैं।

## समर्थित संदेश प्रकार

- **टेक्स्ट संदेश**: 2000 अक्षर विभाजन के साथ पूर्ण समर्थन।
- **छवि संदेश**: इनबाउंड छवियों को डाउनलोड और प्रोसेस करना; `sendPhoto` के माध्यम से छवियाँ भेजना।
- **स्टिकर्स**: लॉग किए जाते हैं लेकिन पूरी तरह प्रोसेस नहीं होते (कोई एजेंट प्रतिक्रिया नहीं)।
- **असमर्थित प्रकार**: लॉग किए जाते हैं (जैसे, संरक्षित उपयोगकर्ताओं से संदेश)।

## क्षमताएँ

| फीचर                               | स्थिति                                                          |
| ---------------------------------- | --------------------------------------------------------------- |
| डायरेक्ट मैसेज                     | ✅ समर्थित                                                       |
| समूह                               | ❌ जल्द आ रहा है (Zalo दस्तावेज़ों के अनुसार) |
| मीडिया (छवियाँ) | ✅ समर्थित                                                       |
| रिएक्शंस                           | ❌ समर्थित नहीं                                                  |
| थ्रेड्स                            | ❌ समर्थित नहीं                                                  |
| पोल्स                              | ❌ समर्थित नहीं                                                  |
| नेटिव कमांड्स                      | ❌ समर्थित नहीं                                                  |
| स्ट्रीमिंग                         | ⚠️ ब्लॉक (2000 अक्षर सीमा)                   |

## डिलीवरी लक्ष्य (CLI/cron)

- लक्ष्य के रूप में चैट आईडी का उपयोग करें।
- उदाहरण: `openclaw message send --channel zalo --target 123456789 --message "hi"`।

## समस्या-निवारण

**बॉट प्रतिक्रिया नहीं देता:**

- जाँचें कि टोकन वैध है: `openclaw channels status --probe`
- सत्यापित करें कि प्रेषक स्वीकृत है (pairing या allowFrom)
- Gateway लॉग्स जाँचें: `openclaw logs --follow`

**वेबहुक को इवेंट्स नहीं मिल रहे:**

- सुनिश्चित करें कि वेबहुक URL HTTPS का उपयोग करता है
- सत्यापित करें कि सीक्रेट टोकन 8–256 अक्षरों का है
- पुष्टि करें कि Gateway HTTP एंडपॉइंट कॉन्फ़िगर किए गए पाथ पर पहुँच योग्य है
- जाँचें कि getUpdates polling चल नहीं रहा (दोनों परस्पर अनन्य हैं)

## विन्यास संदर्भ (Zalo)

पूर्ण विन्यास: [Configuration](/gateway/configuration)

प्रदाता विकल्प:

- `channels.zalo.enabled`: चैनल स्टार्टअप सक्षम/अक्षम करें।
- `channels.zalo.botToken`: Zalo Bot Platform से बॉट टोकन।
- `channels.zalo.tokenFile`: फ़ाइल पाथ से टोकन पढ़ें।
- `channels.zalo.dmPolicy`: `pairing | allowlist | open | disabled` (डिफ़ॉल्ट: pairing)।
- `channels.zalo.allowFrom`: DM allowlist (user IDs). `open` requires `"*"`. The wizard will ask for numeric IDs.
- `channels.zalo.mediaMaxMb`: इनबाउंड/आउटबाउंड मीडिया सीमा (MB, डिफ़ॉल्ट 5)।
- `channels.zalo.webhookUrl`: वेबहुक मोड सक्षम करें (HTTPS आवश्यक)।
- `channels.zalo.webhookSecret`: वेबहुक सीक्रेट (8–256 अक्षर)।
- `channels.zalo.webhookPath`: Gateway HTTP सर्वर पर वेबहुक पाथ।
- `channels.zalo.proxy`: API अनुरोधों के लिए प्रॉक्सी URL।

मल्टी-अकाउंट विकल्प:

- `channels.zalo.accounts.<id>.botToken`: per-account token.
- `channels.zalo.accounts.<id>.tokenFile`: per-account token file.
- `channels.zalo.accounts.<id>``.name`: प्रदर्शित नाम।
- `channels.zalo.accounts.<id>``.enabled`: खाते को सक्षम/अक्षम करें।
- `channels.zalo.accounts.<id>``.dmPolicy`: प्रति-खाता DM नीति।
- `channels.zalo.accounts.<id>``.allowFrom`: प्रति-खाता अनुमति सूची।
- `channels.zalo.accounts.<id>``.webhookUrl`: प्रति-खाता वेबहुक URL।
- `channels.zalo.accounts.<id>``.webhookSecret`: प्रति-खाता वेबहुक सीक्रेट।
- `channels.zalo.accounts.<id>``.webhookPath`: प्रति-खाता वेबहुक पथ।
- `channels.zalo.accounts.<id>``.proxy`: प्रति-खाता प्रॉक्सी URL।
