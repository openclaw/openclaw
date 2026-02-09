---
summary: "`openclaw browser` के लिए CLI संदर्भ (प्रोफ़ाइल, टैब, क्रियाएँ, एक्सटेंशन रिले)"
read_when:
  - आप `openclaw browser` का उपयोग करते हैं और सामान्य कार्यों के उदाहरण चाहते हैं
  - आप किसी नोड होस्ट के माध्यम से दूसरी मशीन पर चल रहे ब्राउज़र को नियंत्रित करना चाहते हैं
  - आप Chrome एक्सटेंशन रिले का उपयोग करना चाहते हैं (टूलबार बटन के माध्यम से attach/detach)
title: "ब्राउज़र"
---

# `openclaw browser`

OpenClaw के ब्राउज़र कंट्रोल सर्वर का प्रबंधन करें और ब्राउज़र क्रियाएँ चलाएँ (टैब, स्नैपशॉट, स्क्रीनशॉट, नेविगेशन, क्लिक, टाइपिंग)।

संबंधित:

- Browser tool + API: [Browser tool](/tools/browser)
- Chrome extension relay: [Chrome extension](/tools/chrome-extension)

## Common flags

- `--url <gatewayWsUrl>`: Gateway WebSocket URL (डिफ़ॉल्ट रूप से विन्यास से)।
- `--token <token>`: Gateway टोकन (यदि आवश्यक हो)।
- `--timeout <ms>`: अनुरोध टाइमआउट (ms)।
- `--browser-profile <name>`: ब्राउज़र प्रोफ़ाइल चुनें (डिफ़ॉल्ट विन्यास से)।
- `--json`: मशीन-पठनीय आउटपुट (जहाँ समर्थित हो)।

## त्वरित प्रारंभ (स्थानीय)

```bash
openclaw browser --browser-profile chrome tabs
openclaw browser --browser-profile openclaw start
openclaw browser --browser-profile openclaw open https://example.com
openclaw browser --browser-profile openclaw snapshot
```

## प्रोफ़ाइल

प्रोफाइल नामित ब्राउज़र रूटिंग कॉन्फ़िग्स होते हैं। व्यवहार में:

- `openclaw`: समर्पित OpenClaw-प्रबंधित Chrome इंस्टेंस लॉन्च/अटैच करता है (अलग-थलग user data dir)।
- `chrome`: Chrome एक्सटेंशन रिले के माध्यम से आपके मौजूदा Chrome टैब नियंत्रित करता है।

```bash
openclaw browser profiles
openclaw browser create-profile --name work --color "#FF5A36"
openclaw browser delete-profile --name work
```

किसी विशिष्ट प्रोफ़ाइल का उपयोग करें:

```bash
openclaw browser --browser-profile work tabs
```

## टैब

```bash
openclaw browser tabs
openclaw browser open https://docs.openclaw.ai
openclaw browser focus <targetId>
openclaw browser close <targetId>
```

## स्नैपशॉट / स्क्रीनशॉट / क्रियाएँ

स्नैपशॉट:

```bash
openclaw browser snapshot
```

स्क्रीनशॉट:

```bash
openclaw browser screenshot
```

नेविगेट/क्लिक/टाइप (ref-आधारित UI स्वचालन):

```bash
openclaw browser navigate https://example.com
openclaw browser click <ref>
openclaw browser type <ref> "hello"
```

## Chrome एक्सटेंशन रिले (टूलबार बटन के माध्यम से attach)

यह मोड एजेंट को किसी मौजूदा Chrome टैब को नियंत्रित करने देता है जिसे आप मैन्युअल रूप से attach करते हैं (यह स्वतः attach नहीं करता)।

अनपैक्ड एक्सटेंशन को एक स्थिर पथ पर इंस्टॉल करें:

```bash
openclaw browser extension install
openclaw browser extension path
```

फिर Chrome → `chrome://extensions` → “Developer mode” सक्षम करें → “Load unpacked” → मुद्रित फ़ोल्डर चुनें।

पूर्ण मार्गदर्शिका: [Chrome extension](/tools/chrome-extension)

## रिमोट ब्राउज़र नियंत्रण (node host प्रॉक्सी)

यदि Gateway ब्राउज़र से अलग मशीन पर चलता है, तो उस मशीन पर **नोड होस्ट** चलाएँ जहाँ Chrome/Brave/Edge/Chromium हो। Gateway उस नोड पर ब्राउज़र क्रियाओं को प्रॉक्सी करेगा (अलग ब्राउज़र कंट्रोल सर्वर की आवश्यकता नहीं)।

स्वचालित रूटिंग को नियंत्रित करने के लिए `gateway.nodes.browser.mode` का उपयोग करें और यदि कई नोड जुड़े हों तो किसी विशिष्ट नोड को पिन करने के लिए `gateway.nodes.browser.node` का उपयोग करें।

सुरक्षा + रिमोट सेटअप: [Browser tool](/tools/browser), [Remote access](/gateway/remote), [Tailscale](/gateway/tailscale), [Security](/gateway/security)
