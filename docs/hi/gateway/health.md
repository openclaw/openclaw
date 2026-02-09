---
summary: "चैनल कनेक्टिविटी के लिए स्वास्थ्य जाँच के चरण"
read_when:
  - WhatsApp चैनल स्वास्थ्य का निदान करते समय
title: "स्वास्थ्य जाँच"
---

# स्वास्थ्य जाँच (CLI)

अनुमान लगाए बिना चैनल कनेक्टिविटी सत्यापित करने के लिए संक्षिप्त मार्गदर्शिका।

## त्वरित जाँच

- `openclaw status` — स्थानीय सारांश: Gateway (गेटवे) की पहुँच/मोड, अपडेट संकेत, लिंक किए गए चैनल का प्रमाणीकरण आयु, सत्र + हालिया गतिविधि।
- `openclaw status --all` — पूर्ण स्थानीय निदान (केवल-पठन, रंगीन, डिबगिंग के लिए पेस्ट करना सुरक्षित)।
- `openclaw status --deep` — चल रहे Gateway (गेटवे) की भी जाँच करता है (समर्थित होने पर प्रति-चैनल प्रोब)।
- `openclaw health --json` — चल रहे Gateway (गेटवे) से पूर्ण स्वास्थ्य स्नैपशॉट माँगता है (केवल WS; कोई प्रत्यक्ष Baileys सॉकेट नहीं)।
- एजेंट को बुलाए बिना स्थिति उत्तर पाने के लिए WhatsApp/WebChat में `/status` को एक स्वतंत्र संदेश के रूप में भेजें।
- लॉग्स: `/tmp/openclaw/openclaw-*.log` को टेल करें और `web-heartbeat`, `web-reconnect`, `web-auto-reply`, `web-inbound` के लिए फ़िल्टर करें।

## गहन निदान

- डिस्क पर क्रेडेंशियल्स: `ls -l ~/.openclaw/credentials/whatsapp/<accountId>/creds.json` (mtime हालिया होना चाहिए)।
- Session store: `ls -l ~/.openclaw/agents/<agentId>/sessions/sessions.json` (path can be overridden in config). Count and recent recipients are surfaced via `status`.
- Relink flow: `openclaw channels logout && openclaw channels login --verbose` when status codes 409–515 or `loggedOut` appear in logs. (Note: the QR login flow auto-restarts once for status 515 after pairing.)

## जब कुछ विफल हो जाए

- `logged out` या स्थिति 409–515 → `openclaw channels logout` के साथ रिलिंक करें, फिर `openclaw channels login`।
- Gateway (गेटवे) अनुपलब्ध → इसे प्रारंभ करें: `openclaw gateway --port 18789` (यदि पोर्ट व्यस्त हो तो `--force` का उपयोग करें)।
- कोई इनबाउंड संदेश नहीं → पुष्टि करें कि लिंक किया गया फ़ोन ऑनलाइन है और प्रेषक अनुमत है (`channels.whatsapp.allowFrom`); समूह चैट के लिए, सुनिश्चित करें कि allowlist + मेंशन नियम मेल खाते हों (`channels.whatsapp.groups`, `agents.list[].groupChat.mentionPatterns`)।

## समर्पित "health" कमांड

`openclaw health --json` asks the running Gateway for its health snapshot (no direct channel sockets from the CLI). It reports linked creds/auth age when available, per-channel probe summaries, session-store summary, and a probe duration. It exits non-zero if the Gateway is unreachable or the probe fails/timeouts. Use `--timeout <ms>` to override the 10s default.
