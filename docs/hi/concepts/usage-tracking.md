---
summary: "उपयोग ट्रैकिंग सतहें और क्रेडेंशियल आवश्यकताएँ"
read_when:
  - आप प्रदाता उपयोग/कोटा सतहों को वायर कर रहे हों
  - आपको उपयोग ट्रैकिंग व्यवहार या प्रमाणीकरण आवश्यकताओं की व्याख्या करनी हो
title: "उपयोग ट्रैकिंग"
---

# उपयोग ट्रैकिंग

## यह क्या है

- प्रदाता के उपयोग/कोटा को सीधे उनके उपयोग एंडपॉइंट्स से प्राप्त करता है।
- कोई अनुमानित लागत नहीं; केवल प्रदाता द्वारा रिपोर्ट की गई समय-खिड़कियाँ।

## यह कहाँ दिखाई देता है

- 4. चैट्स में `/status`: emoji‑rich status card जिसमें session tokens + अनुमानित लागत (केवल API key) दिखती है। 5. Provider usage उपलब्ध होने पर **current model provider** के लिए दिखाई जाती है।
- चैट्स में `/usage off|tokens|full`: प्रति‑प्रतिक्रिया उपयोग फ़ुटर (OAuth केवल टोकन दिखाता है)।
- चैट्स में `/usage cost`: OpenClaw सत्र लॉग्स से संकलित स्थानीय लागत सारांश।
- CLI: `openclaw status --usage` प्रति‑प्रदाता का पूर्ण ब्रेकडाउन प्रिंट करता है।
- CLI: `openclaw channels list` प्रदाता विन्यास के साथ वही उपयोग स्नैपशॉट प्रिंट करता है (`--no-usage` का उपयोग करके छोड़ें)।
- macOS मेनू बार: Context के अंतर्गत “Usage” अनुभाग (केवल उपलब्ध होने पर)।

## प्रदाता + क्रेडेंशियल

- **Anthropic (Claude)**: auth profiles में OAuth टोकन।
- **GitHub Copilot**: auth profiles में OAuth टोकन।
- **Gemini CLI**: auth profiles में OAuth टोकन।
- **Antigravity**: auth profiles में OAuth टोकन।
- **OpenAI Codex**: auth profiles में OAuth टोकन (उपस्थित होने पर accountId का उपयोग)।
- **MiniMax**: API key (coding plan key; `MINIMAX_CODE_PLAN_KEY` या `MINIMAX_API_KEY`); 5‑घंटे की coding plan विंडो का उपयोग करता है।
- **z.ai**: env/config/auth store के माध्यम से API key।

यदि कोई मेल खाता OAuth/API क्रेडेंशियल मौजूद नहीं है, तो उपयोग छिपा रहता है।
