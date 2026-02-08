---
summary: "WKWebView + कस्टम URL स्कीम के माध्यम से एम्बेड किया गया एजेंट‑नियंत्रित Canvas पैनल"
read_when:
  - macOS Canvas पैनल को लागू करते समय
  - विज़ुअल वर्कस्पेस के लिए एजेंट नियंत्रण जोड़ते समय
  - WKWebView Canvas लोड्स का डिबग करते समय
title: "Canvas"
x-i18n:
  source_path: platforms/mac/canvas.md
  source_hash: e39caa21542e839d
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:49:29Z
---

# Canvas (macOS ऐप)

macOS ऐप `WKWebView` का उपयोग करके एक एजेंट‑नियंत्रित **Canvas पैनल** एम्बेड करता है। यह
HTML/CSS/JS, A2UI, और छोटे इंटरैक्टिव
UI सरफेस के लिए एक हल्का विज़ुअल वर्कस्पेस है।

## Canvas कहाँ रहता है

Canvas की स्थिति Application Support के अंतर्गत संग्रहीत होती है:

- `~/Library/Application Support/OpenClaw/canvas/<session>/...`

Canvas पैनल उन फ़ाइलों को एक **कस्टम URL स्कीम** के माध्यम से परोसता है:

- `openclaw-canvas://<session>/<path>`

उदाहरण:

- `openclaw-canvas://main/` → `<canvasRoot>/main/index.html`
- `openclaw-canvas://main/assets/app.css` → `<canvasRoot>/main/assets/app.css`
- `openclaw-canvas://main/widgets/todo/` → `<canvasRoot>/main/widgets/todo/index.html`

यदि रूट पर कोई `index.html` मौजूद नहीं है, तो ऐप एक **बिल्ट‑इन स्कैफोल्ड पेज** दिखाता है।

## पैनल का व्यवहार

- बिना बॉर्डर का, आकार बदलने योग्य पैनल जो मेनू बार (या माउस कर्सर) के पास एंकर रहता है।
- प्रति सत्र आकार/स्थिति याद रखता है।
- स्थानीय Canvas फ़ाइलों में बदलाव होने पर स्वतः रीलोड होता है।
- एक समय में केवल एक Canvas पैनल दिखाई देता है (आवश्यकतानुसार सत्र स्विच किया जाता है)।

Canvas को Settings → **Allow Canvas** से अक्षम किया जा सकता है। अक्षम होने पर, canvas
node कमांड `CANVAS_DISABLED` लौटाते हैं।

## एजेंट API सतह

Canvas को **Gateway WebSocket** के माध्यम से एक्सपोज़ किया गया है, ताकि एजेंट:

- पैनल दिखा/छिपा सके
- किसी पथ या URL पर नेविगेट कर सके
- JavaScript का मूल्यांकन कर सके
- स्नैपशॉट इमेज कैप्चर कर सके

CLI उदाहरण:

```bash
openclaw nodes canvas present --node <id>
openclaw nodes canvas navigate --node <id> --url "/"
openclaw nodes canvas eval --node <id> --js "document.title"
openclaw nodes canvas snapshot --node <id>
```

नोट्स:

- `canvas.navigate` **स्थानीय canvas पथ**, `http(s)` URLs, और `file://` URLs स्वीकार करता है।
- यदि आप `"/"` पास करते हैं, तो Canvas स्थानीय स्कैफोल्ड या `index.html` दिखाता है।

## Canvas में A2UI

A2UI को Gateway canvas होस्ट द्वारा होस्ट किया जाता है और Canvas पैनल के अंदर रेंडर किया जाता है।
जब Gateway एक Canvas होस्ट का विज्ञापन करता है, तो macOS ऐप पहली बार खोलने पर
A2UI होस्ट पेज पर स्वतः नेविगेट करता है।

डिफ़ॉल्ट A2UI होस्ट URL:

```
http://<gateway-host>:18793/__openclaw__/a2ui/
```

### A2UI कमांड्स (v0.8)

Canvas वर्तमान में **A2UI v0.8** सर्वर→क्लाइंट संदेश स्वीकार करता है:

- `beginRendering`
- `surfaceUpdate`
- `dataModelUpdate`
- `deleteSurface`

`createSurface` (v0.9) समर्थित नहीं है।

CLI उदाहरण:

```bash
cat > /tmp/a2ui-v0.8.jsonl <<'EOFA2'
{"surfaceUpdate":{"surfaceId":"main","components":[{"id":"root","component":{"Column":{"children":{"explicitList":["title","content"]}}}},{"id":"title","component":{"Text":{"text":{"literalString":"Canvas (A2UI v0.8)"},"usageHint":"h1"}}},{"id":"content","component":{"Text":{"text":{"literalString":"If you can read this, A2UI push works."},"usageHint":"body"}}}]}}
{"beginRendering":{"surfaceId":"main","root":"root"}}
EOFA2

openclaw nodes canvas a2ui push --jsonl /tmp/a2ui-v0.8.jsonl --node <id>
```

त्वरित स्मोक:

```bash
openclaw nodes canvas a2ui push --node <id> --text "Hello from A2UI"
```

## Canvas से एजेंट रन ट्रिगर करना

Canvas डीप लिंक के माध्यम से नए एजेंट रन ट्रिगर कर सकता है:

- `openclaw://agent?...`

उदाहरण (JS में):

```js
window.location.href = "openclaw://agent?message=Review%20this%20design";
```

जब तक कोई वैध कुंजी प्रदान न की जाए, ऐप पुष्टि के लिए पूछता है।

## सुरक्षा नोट्स

- Canvas स्कीम डायरेक्टरी ट्रैवर्सल को ब्लॉक करती है; फ़ाइलें सत्र रूट के अंतर्गत ही होनी चाहिए।
- स्थानीय Canvas सामग्री एक कस्टम स्कीम का उपयोग करती है (किसी loopback सर्वर की आवश्यकता नहीं)।
- बाहरी `http(s)` URLs केवल तब अनुमति प्राप्त करते हैं जब स्पष्ट रूप से नेविगेट किया जाए।
