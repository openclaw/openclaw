---
summary: "Bonjour/mDNS डिस्कवरी + डिबगिंग (Gateway बीकन, क्लाइंट्स, और सामान्य विफलता मोड)"
read_when:
  - macOS/iOS पर Bonjour डिस्कवरी समस्याओं का डिबग करते समय
  - mDNS सेवा प्रकार, TXT रिकॉर्ड, या डिस्कवरी UX बदलते समय
title: "Bonjour डिस्कवरी"
x-i18n:
  source_path: gateway/bonjour.md
  source_hash: 6f1d676ded5a500c
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:49:22Z
---

# Bonjour / mDNS डिस्कवरी

OpenClaw Bonjour (mDNS / DNS‑SD) का उपयोग **केवल‑LAN सुविधा** के रूप में करता है ताकि
एक सक्रिय Gateway (WebSocket एंडपॉइंट) खोजा जा सके। यह best‑effort है और
SSH या Tailnet‑आधारित कनेक्टिविटी का **स्थानापन्न नहीं** है।

## Tailscale पर वाइड‑एरिया Bonjour (Unicast DNS‑SD)

यदि नोड और Gateway अलग‑अलग नेटवर्क पर हैं, तो मल्टीकास्ट mDNS
सीमा पार नहीं करेगा। आप **unicast DNS‑SD**
("Wide‑Area Bonjour") पर स्विच करके Tailscale के माध्यम से वही डिस्कवरी UX बनाए रख सकते हैं।

उच्च‑स्तरीय चरण:

1. Gateway होस्ट पर एक DNS सर्वर चलाएँ (Tailnet के माध्यम से पहुँचा जा सकने योग्य)।
2. एक समर्पित ज़ोन के अंतर्गत `_openclaw-gw._tcp` के लिए DNS‑SD रिकॉर्ड प्रकाशित करें
   (उदाहरण: `openclaw.internal.`)।
3. Tailscale **split DNS** कॉन्फ़िगर करें ताकि आपका चुना हुआ डोमेन
   क्लाइंट्स (iOS सहित) के लिए उसी DNS सर्वर के माध्यम से रेज़ॉल्व हो।

OpenClaw किसी भी डिस्कवरी डोमेन का समर्थन करता है; `openclaw.internal.` केवल एक उदाहरण है।
iOS/Android नोड्स `local.` और आपके कॉन्फ़िगर किए गए वाइड‑एरिया डोमेन—दोनों को ब्राउज़ करते हैं।

### Gateway विन्यास (अनुशंसित)

```json5
{
  gateway: { bind: "tailnet" }, // tailnet-only (recommended)
  discovery: { wideArea: { enabled: true } }, // enables wide-area DNS-SD publishing
}
```

### एक‑बार DNS सर्वर सेटअप (Gateway होस्ट)

```bash
openclaw dns setup --apply
```

यह CoreDNS इंस्टॉल करता है और इसे इस प्रकार कॉन्फ़िगर करता है:

- केवल Gateway के Tailscale इंटरफ़ेस पर पोर्ट 53 पर सुनता है
- आपकी चुनी हुई डोमेन (उदाहरण: `openclaw.internal.`) को `~/.openclaw/dns/<domain>.db` से सर्व करता है

Tailnet‑कनेक्टेड मशीन से सत्यापित करें:

```bash
dns-sd -B _openclaw-gw._tcp openclaw.internal.
dig @<TAILNET_IPV4> -p 53 _openclaw-gw._tcp.openclaw.internal PTR +short
```

### Tailscale DNS सेटिंग्स

Tailscale एडमिन कंसोल में:

- Gateway के Tailnet IP (UDP/TCP 53) की ओर संकेत करने वाला एक नेमसर्वर जोड़ें।
- split DNS जोड़ें ताकि आपकी डिस्कवरी डोमेन उसी नेमसर्वर का उपयोग करे।

एक बार क्लाइंट्स Tailnet DNS स्वीकार कर लें, तो iOS नोड्स मल्टीकास्ट के बिना
आपकी डिस्कवरी डोमेन में `_openclaw-gw._tcp` ब्राउज़ कर सकते हैं।

### Gateway लिस्नर सुरक्षा (अनुशंसित)

Gateway WS पोर्ट (डिफ़ॉल्ट `18789`) डिफ़ॉल्ट रूप से loopback से बाइंड होता है। LAN/Tailnet
एक्सेस के लिए, स्पष्ट रूप से बाइंड करें और प्रमाणीकरण सक्षम रखें।

केवल‑Tailnet सेटअप के लिए:

- `~/.openclaw/openclaw.json` में `gateway.bind: "tailnet"` सेट करें।
- Gateway को पुनः प्रारंभ करें (या macOS मेनूबार ऐप को रीस्टार्ट करें)।

## क्या विज्ञापित होता है

केवल Gateway ही `_openclaw-gw._tcp` विज्ञापित करता है।

## सेवा प्रकार

- `_openclaw-gw._tcp` — Gateway ट्रांसपोर्ट बीकन (macOS/iOS/Android नोड्स द्वारा उपयोग किया जाता है)।

## TXT कुंजियाँ (गैर‑गुप्त संकेत)

UI फ़्लो को सुविधाजनक बनाने के लिए Gateway छोटे गैर‑गुप्त संकेत विज्ञापित करता है:

- `role=gateway`
- `displayName=<friendly name>`
- `lanHost=<hostname>.local`
- `gatewayPort=<port>` (Gateway WS + HTTP)
- `gatewayTls=1` (केवल तब जब TLS सक्षम हो)
- `gatewayTlsSha256=<sha256>` (केवल तब जब TLS सक्षम हो और फ़िंगरप्रिंट उपलब्ध हो)
- `canvasPort=<port>` (केवल तब जब कैनवास होस्ट सक्षम हो; डिफ़ॉल्ट `18793`)
- `sshPort=<port>` (यदि ओवरराइड न किया गया हो तो डिफ़ॉल्ट 22)
- `transport=gateway`
- `cliPath=<path>` (वैकल्पिक; रन करने योग्य `openclaw` एंट्रीपॉइंट का पूर्ण पथ)
- `tailnetDns=<magicdns>` (वैकल्पिक संकेत जब Tailnet उपलब्ध हो)

## macOS पर डिबगिंग

उपयोगी बिल्ट‑इन टूल्स:

- इंस्टेंस ब्राउज़ करें:

  ```bash
  dns-sd -B _openclaw-gw._tcp local.
  ```

- एक इंस्टेंस रेज़ॉल्व करें (`<instance>` को बदलें):

  ```bash
  dns-sd -L "<instance>" _openclaw-gw._tcp local.
  ```

यदि ब्राउज़िंग काम करती है लेकिन रेज़ॉल्व विफल होता है, तो आमतौर पर यह LAN नीति या
mDNS रेज़ॉल्वर समस्या होती है।

## Gateway लॉग्स में डिबगिंग

Gateway एक रोलिंग लॉग फ़ाइल लिखता है (स्टार्टअप पर
`gateway log file: ...` के रूप में प्रिंट होता है)। `bonjour:` लाइनों को देखें, विशेष रूप से:

- `bonjour: advertise failed ...`
- `bonjour: ... name conflict resolved` / `hostname conflict resolved`
- `bonjour: watchdog detected non-announced service ...`

## iOS नोड पर डिबगिंग

iOS नोड `NWBrowser` का उपयोग करके `_openclaw-gw._tcp` की खोज करता है।

लॉग कैप्चर करने के लिए:

- Settings → Gateway → Advanced → **Discovery Debug Logs**
- Settings → Gateway → Advanced → **Discovery Logs** → पुनरुत्पादन करें → **Copy**

लॉग में ब्राउज़र स्थिति संक्रमण और परिणाम‑सेट परिवर्तनों का विवरण होता है।

## सामान्य विफलता मोड

- **Bonjour नेटवर्क पार नहीं करता**: Tailnet या SSH का उपयोग करें।
- **मल्टीकास्ट अवरुद्ध**: कुछ Wi‑Fi नेटवर्क mDNS को अक्षम करते हैं।
- **स्लीप / इंटरफ़ेस बदलाव**: macOS अस्थायी रूप से mDNS परिणाम छोड़ सकता है; पुनः प्रयास करें।
- **ब्राउज़ काम करता है लेकिन रेज़ॉल्व विफल**: मशीन नाम सरल रखें (इमोजी या
  विराम‑चिह्न से बचें), फिर Gateway को रीस्टार्ट करें। सेवा इंस्टेंस नाम
  होस्ट नाम से व्युत्पन्न होता है, इसलिए अत्यधिक जटिल नाम कुछ रेज़ॉल्वरों को भ्रमित कर सकते हैं।

## एस्केप किए गए इंस्टेंस नाम (`\032`)

Bonjour/DNS‑SD अक्सर सेवा इंस्टेंस नामों में बाइट्स को दशमलव `\DDD`
क्रमों के रूप में एस्केप करता है (उदाहरण: स्पेस `\032` बन जाते हैं)।

- यह प्रोटोकॉल स्तर पर सामान्य है।
- UI को प्रदर्शन के लिए डिकोड करना चाहिए (iOS `BonjourEscapes.decode` का उपयोग करता है)।

## अक्षम करना / विन्यास

- `OPENCLAW_DISABLE_BONJOUR=1` विज्ञापन को अक्षम करता है (लेगेसी: `OPENCLAW_DISABLE_BONJOUR`)।
- `~/.openclaw/openclaw.json` में `gateway.bind` Gateway बाइंड मोड को नियंत्रित करता है।
- `OPENCLAW_SSH_PORT` TXT में विज्ञापित SSH पोर्ट को ओवरराइड करता है (लेगेसी: `OPENCLAW_SSH_PORT`)।
- `OPENCLAW_TAILNET_DNS` TXT में MagicDNS संकेत प्रकाशित करता है (लेगेसी: `OPENCLAW_TAILNET_DNS`)।
- `OPENCLAW_CLI_PATH` विज्ञापित CLI पथ को ओवरराइड करता है (लेगेसी: `OPENCLAW_CLI_PATH`)।

## संबंधित दस्तावेज़

- डिस्कवरी नीति और ट्रांसपोर्ट चयन: [Discovery](/gateway/discovery)
- नोड पेयरिंग + अनुमोदन: [Gateway pairing](/gateway/pairing)
