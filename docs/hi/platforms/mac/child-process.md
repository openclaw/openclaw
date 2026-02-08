---
summary: "macOS पर Gateway जीवनचक्र (launchd)"
read_when:
  - Gateway जीवनचक्र के साथ mac ऐप का एकीकरण
title: "Gateway जीवनचक्र"
x-i18n:
  source_path: platforms/mac/child-process.md
  source_hash: 9b910f574b723bc1
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:49:28Z
---

# macOS पर Gateway जीवनचक्र

macOS ऐप डिफ़ॉल्ट रूप से **launchd के माध्यम से Gateway का प्रबंधन** करता है और
Gateway को child process के रूप में स्पॉन नहीं करता। यह पहले कॉन्फ़िगर किए गए
पोर्ट पर पहले से चल रहे Gateway से जुड़ने का प्रयास करता है; यदि कोई उपलब्ध नहीं
होता, तो यह बाहरी `openclaw` CLI के माध्यम से launchd सेवा सक्षम करता है
(कोई एम्बेडेड रनटाइम नहीं)। इससे लॉगिन पर विश्वसनीय ऑटो‑स्टार्ट और क्रैश होने पर
रीस्टार्ट सुनिश्चित होता है।

Child‑process मोड (ऐप द्वारा सीधे Gateway स्पॉन करना) वर्तमान में **प्रयोग में
नहीं** है। यदि आपको UI के साथ अधिक कड़ा संयोजन चाहिए, तो Gateway को टर्मिनल में
मैन्युअली चलाएँ।

## डिफ़ॉल्ट व्यवहार (launchd)

- ऐप प्रति‑उपयोगकर्ता LaunchAgent इंस्टॉल करता है, जिसका लेबल `bot.molt.gateway` होता है
  (या `--profile`/`OPENCLAW_PROFILE` का उपयोग करते समय `bot.molt.<profile>`;
  लेगेसी `com.openclaw.*` समर्थित है)।
- जब Local मोड सक्षम होता है, ऐप सुनिश्चित करता है कि LaunchAgent लोड हो और
  आवश्यकता होने पर Gateway शुरू करता है।
- लॉग्स launchd Gateway लॉग पथ पर लिखे जाते हैं (Debug Settings में दिखाई देते हैं)।

सामान्य कमांड:

```bash
launchctl kickstart -k gui/$UID/bot.molt.gateway
launchctl bootout gui/$UID/bot.molt.gateway
```

नामित प्रोफ़ाइल चलाते समय लेबल को `bot.molt.<profile>` से बदलें।

## Unsigned dev builds

`scripts/restart-mac.sh --no-sign` तेज़ स्थानीय बिल्ड्स के लिए है जब आपके पास
साइनिंग कुंजियाँ नहीं होतीं। launchd को unsigned relay बाइनरी की ओर
संकेत करने से रोकने के लिए, यह:

- `~/.openclaw/disable-launchagent` लिखता है।

`scripts/restart-mac.sh` के signed रन, यदि मार्कर मौजूद हो, तो इस ओवरराइड को साफ़ कर देते हैं।
मैन्युअल रूप से रीसेट करने के लिए:

```bash
rm ~/.openclaw/disable-launchagent
```

## Attach-only मोड

macOS ऐप को **कभी भी launchd इंस्टॉल या प्रबंधित न करने** के लिए मजबूर करने हेतु,
इसे `--attach-only` (या `--no-launchd`) के साथ लॉन्च करें। यह `~/.openclaw/disable-launchagent`
सेट करता है, ताकि ऐप केवल पहले से चल रहे Gateway से ही जुड़े। आप Debug Settings
में भी यही व्यवहार टॉगल कर सकते हैं।

## Remote मोड

Remote मोड कभी भी स्थानीय Gateway शुरू नहीं करता। ऐप दूरस्थ होस्ट तक SSH टनल
का उपयोग करता है और उसी टनल के माध्यम से कनेक्ट करता है।

## हम launchd को क्यों प्राथमिकता देते हैं

- लॉगिन पर ऑटो‑स्टार्ट।
- बिल्ट‑इन रीस्टार्ट/KeepAlive सेमांटिक्स।
- पूर्वानुमेय लॉग्स और सुपरविजन।

यदि भविष्य में फिर से किसी वास्तविक child‑process मोड की आवश्यकता होती है, तो
इसे एक अलग, स्पष्ट केवल‑डेव मोड के रूप में प्रलेखित किया जाना चाहिए।
