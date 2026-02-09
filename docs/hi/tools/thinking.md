---
summary: "/think + /verbose के लिए निर्देश सिंटैक्स और वे मॉडल की तर्क-प्रक्रिया को कैसे प्रभावित करते हैं"
read_when:
  - सोचने या verbose निर्देशों के पार्सिंग या डिफ़ॉल्ट्स को समायोजित करते समय
title: "सोच के स्तर"
---

# सोच के स्तर (/think निर्देश)

## यह क्या करता है

- किसी भी इनबाउंड बॉडी में इनलाइन निर्देश: `/t <level>`, `/think:<level>`, या `/thinking <level>`।
- स्तर (उपनाम): `off | minimal | low | medium | high | xhigh` (केवल GPT-5.2 + Codex मॉडल)
  - minimal → “think”
  - low → “think hard”
  - medium → “think harder”
  - high → “ultrathink” (अधिकतम बजट)
  - xhigh → “ultrathink+” (केवल GPT-5.2 + Codex मॉडल)
  - `x-high`, `x_high`, `extra-high`, `extra high`, और `extra_high` का मैप `xhigh` से होता है।
  - `highest`, `max` का मैप `high` से होता है।
- प्रदाता नोट्स:
  - Z.AI (`zai/*`) only supports binary thinking (`on`/`off`). Any non-`off` level is treated as `on` (mapped to `low`).

## रिज़ॉल्यूशन क्रम

1. संदेश पर इनलाइन निर्देश (केवल उसी संदेश पर लागू)।
2. सत्र ओवरराइड (केवल-निर्देश संदेश भेजकर सेट किया गया)।
3. वैश्विक डिफ़ॉल्ट (विन्यास में `agents.defaults.thinkingDefault`)।
4. फ़ॉलबैक: तर्क-क्षमता वाले मॉडलों के लिए low; अन्यथा off।

## सत्र डिफ़ॉल्ट सेट करना

- ऐसा संदेश भेजें जो **केवल** निर्देश हो (व्हाइटस्पेस अनुमत), उदाहरण के लिए `/think:medium` या `/t high`।
- यह वर्तमान सत्र के लिए बना रहता है (डिफ़ॉल्ट रूप से प्रति-प्रेषक); `/think:off` या सत्र निष्क्रिय रीसेट से साफ़ हो जाता है।
- Confirmation reply is sent (`Thinking level set to high.` / `Thinking disabled.`). If the level is invalid (e.g. `/thinking big`), the command is rejected with a hint and the session state is left unchanged.
- वर्तमान सोच स्तर देखने के लिए बिना आर्ग्युमेंट के `/think` (या `/think:`) भेजें।

## एजेंट द्वारा अनुप्रयोग

- **Embedded Pi**: रिज़ॉल्व किया गया स्तर इन-प्रोसेस Pi एजेंट रनटाइम को पास किया जाता है।

## Verbose निर्देश (/verbose या /v)

- स्तर: `on` (minimal) | `full` | `off` (डिफ़ॉल्ट)।
- केवल-निर्देश संदेश सत्र verbose को टॉगल करता है और `Verbose logging enabled.` / `Verbose logging disabled.` के साथ उत्तर देता है; अमान्य स्तर स्थिति बदले बिना संकेत लौटाते हैं।
- `/verbose off` एक स्पष्ट सत्र ओवरराइड संग्रहीत करता है; Sessions UI में `inherit` चुनकर इसे साफ़ करें।
- इनलाइन निर्देश केवल उसी संदेश को प्रभावित करता है; अन्यथा सत्र/वैश्विक डिफ़ॉल्ट लागू होते हैं।
- वर्तमान verbose स्तर देखने के लिए बिना आर्ग्युमेंट के `/verbose` (या `/verbose:`) भेजें।
- When verbose is on, agents that emit structured tool results (Pi, other JSON agents) send each tool call back as its own metadata-only message, prefixed with `<emoji> <tool-name>: <arg>` when available (path/command). These tool summaries are sent as soon as each tool starts (separate bubbles), not as streaming deltas.
- When verbose is `full`, tool outputs are also forwarded after completion (separate bubble, truncated to a safe length). If you toggle `/verbose on|full|off` while a run is in-flight, subsequent tool bubbles honor the new setting.

## तर्क की दृश्यता (/reasoning)

- स्तर: `on|off|stream`।
- केवल-निर्देश संदेश यह टॉगल करता है कि उत्तरों में थिंकिंग ब्लॉक्स दिखाए जाएँ या नहीं।
- सक्षम होने पर, तर्क एक **अलग संदेश** के रूप में `Reasoning:` प्रीफ़िक्स के साथ भेजा जाता है।
- `stream` (केवल Telegram): उत्तर जनरेट होने के दौरान तर्क को Telegram ड्राफ्ट बबल में स्ट्रीम करता है, फिर बिना तर्क के अंतिम उत्तर भेजता है।
- उपनाम: `/reason`।
- वर्तमान तर्क स्तर देखने के लिए बिना आर्ग्युमेंट के `/reasoning` (या `/reasoning:`) भेजें।

## संबंधित

- Elevated मोड के दस्तावेज़ [Elevated mode](/tools/elevated) में उपलब्ध हैं।

## हार्टबीट्स

- Heartbeat probe body is the configured heartbeat prompt (default: `Read HEARTBEAT.md if it exists (workspace context). Follow it strictly. Do not infer or repeat old tasks from prior chats. If nothing needs attention, reply HEARTBEAT_OK.`). Inline directives in a heartbeat message apply as usual (but avoid changing session defaults from heartbeats).
- Heartbeat delivery defaults to the final payload only. To also send the separate `Reasoning:` message (when available), set `agents.defaults.heartbeat.includeReasoning: true` or per-agent `agents.list[].heartbeat.includeReasoning: true`.

## वेब चैट UI

- वेब चैट थिंकिंग सेलेक्टर पेज लोड होने पर इनबाउंड सत्र स्टोर/विन्यास से सत्र के संग्रहीत स्तर को मिरर करता है।
- किसी अन्य स्तर का चयन केवल अगले संदेश पर लागू होता है (`thinkingOnce`)। भेजने के बाद, सेलेक्टर वापस संग्रहीत सत्र स्तर पर स्नैप हो जाता है।
- सत्र डिफ़ॉल्ट बदलने के लिए पहले की तरह `/think:<level>` निर्देश भेजें; अगली रीलोड के बाद सेलेक्टर उसे दर्शाएगा।
