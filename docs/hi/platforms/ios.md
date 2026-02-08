---
summary: "iOS नोड ऐप: Gateway से कनेक्ट करना, पेयरिंग, कैनवास, और समस्या-निवारण"
read_when:
  - iOS नोड को पेयर या पुनः कनेक्ट करते समय
  - स्रोत से iOS ऐप चलाते समय
  - Gateway डिस्कवरी या कैनवास कमांड्स का डिबग करते समय
title: "iOS ऐप"
x-i18n:
  source_path: platforms/ios.md
  source_hash: 692eebdc82e4bb8d
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:49:29Z
---

# iOS ऐप (नोड)

उपलब्धता: आंतरिक प्रीव्यू। iOS ऐप अभी सार्वजनिक रूप से वितरित नहीं है।

## यह क्या करता है

- WebSocket के माध्यम से Gateway से कनेक्ट होता है (LAN या tailnet)।
- नोड क्षमताएँ उपलब्ध कराता है: कैनवास, स्क्रीन स्नैपशॉट, कैमरा कैप्चर, लोकेशन, टॉक मोड, वॉयस वेक।
- `node.invoke` कमांड्स प्राप्त करता है और नोड स्थिति इवेंट्स रिपोर्ट करता है।

## आवश्यकताएँ

- Gateway किसी अन्य डिवाइस पर चल रहा हो (macOS, Linux, या WSL2 के माध्यम से Windows)।
- नेटवर्क पथ:
  - Bonjour के माध्यम से वही LAN, **या**
  - यूनिकास्ट DNS-SD के माध्यम से Tailnet (उदाहरण डोमेन: `openclaw.internal.`), **या**
  - मैनुअल होस्ट/पोर्ट (फ़ॉलबैक)।

## त्वरित प्रारंभ (पेयर + कनेक्ट)

1. Gateway शुरू करें:

```bash
openclaw gateway --port 18789
```

2. iOS ऐप में, Settings खोलें और खोजा गया Gateway चुनें (या Manual Host सक्षम करें और होस्ट/पोर्ट दर्ज करें)।

3. Gateway होस्ट पर पेयरिंग अनुरोध को स्वीकृत करें:

```bash
openclaw nodes pending
openclaw nodes approve <requestId>
```

4. कनेक्शन सत्यापित करें:

```bash
openclaw nodes status
openclaw gateway call node.list --params "{}"
```

## डिस्कवरी पथ

### Bonjour (LAN)

Gateway, `local.` पर `_openclaw-gw._tcp` का विज्ञापन करता है। iOS ऐप इन्हें स्वचालित रूप से सूचीबद्ध करता है।

### Tailnet (क्रॉस-नेटवर्क)

यदि mDNS अवरुद्ध है, तो एक यूनिकास्ट DNS-SD ज़ोन का उपयोग करें (एक डोमेन चुनें; उदाहरण: `openclaw.internal.`) और Tailscale स्प्लिट DNS।
CoreDNS उदाहरण के लिए [Bonjour](/gateway/bonjour) देखें।

### मैनुअल होस्ट/पोर्ट

Settings में **Manual Host** सक्षम करें और Gateway होस्ट + पोर्ट दर्ज करें (डिफ़ॉल्ट `18789`)।

## कैनवास + A2UI

iOS नोड एक WKWebView कैनवास रेंडर करता है। इसे संचालित करने के लिए `node.invoke` का उपयोग करें:

```bash
openclaw nodes invoke --node "iOS Node" --command canvas.navigate --params '{"url":"http://<gateway-host>:18793/__openclaw__/canvas/"}'
```

टिप्पणियाँ:

- Gateway कैनवास होस्ट `/__openclaw__/canvas/` और `/__openclaw__/a2ui/` प्रदान करता है।
- जब कैनवास होस्ट URL का विज्ञापन होता है, तो iOS नोड कनेक्ट होने पर स्वचालित रूप से A2UI पर नेविगेट करता है।
- `canvas.navigate` और `{"url":""}` के साथ बिल्ट-इन स्कैफ़ोल्ड पर वापस लौटें।

### कैनवास eval / स्नैपशॉट

```bash
openclaw nodes invoke --node "iOS Node" --command canvas.eval --params '{"javaScript":"(() => { const {ctx} = window.__openclaw; ctx.clearRect(0,0,innerWidth,innerHeight); ctx.lineWidth=6; ctx.strokeStyle=\"#ff2d55\"; ctx.beginPath(); ctx.moveTo(40,40); ctx.lineTo(innerWidth-40, innerHeight-40); ctx.stroke(); return \"ok\"; })()"}'
```

```bash
openclaw nodes invoke --node "iOS Node" --command canvas.snapshot --params '{"maxWidth":900,"format":"jpeg"}'
```

## वॉयस वेक + टॉक मोड

- वॉयस वेक और टॉक मोड Settings में उपलब्ध हैं।
- iOS बैकग्राउंड ऑडियो को निलंबित कर सकता है; ऐप सक्रिय न होने पर वॉयस फीचर्स को सर्वोत्तम-प्रयास के रूप में मानें।

## सामान्य त्रुटियाँ

- `NODE_BACKGROUND_UNAVAILABLE`: iOS ऐप को फ़ोरग्राउंड में लाएँ (कैनवास/कैमरा/स्क्रीन कमांड्स के लिए यह आवश्यक है)।
- `A2UI_HOST_NOT_CONFIGURED`: Gateway ने कैनवास होस्ट URL का विज्ञापन नहीं किया; [Gateway configuration](/gateway/configuration) में `canvasHost` जाँचें।
- पेयरिंग प्रॉम्प्ट कभी दिखाई नहीं देता: `openclaw nodes pending` चलाएँ और मैन्युअली स्वीकृत करें।
- पुनः इंस्टॉल के बाद पुनः कनेक्ट विफल: Keychain पेयरिंग टोकन साफ़ हो गया था; नोड को फिर से पेयर करें।

## संबंधित दस्तावेज़

- [Pairing](/gateway/pairing)
- [Discovery](/gateway/discovery)
- [Bonjour](/gateway/bonjour)
