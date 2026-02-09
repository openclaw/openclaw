---
summary: "OpenClaw (macOS ऐप) के लिए पहली‑बार ऑनबोर्डिंग प्रवाह"
read_when:
  - macOS ऑनबोर्डिंग सहायक का डिज़ाइन करते समय
  - प्रमाणीकरण या पहचान सेटअप लागू करते समय
title: "ऑनबोर्डिंग (macOS ऐप)"
sidebarTitle: "Onboarding: macOS App"
---

# ऑनबोर्डिंग (macOS ऐप)

45. यह डॉक **वर्तमान** पहली‑बार रन होने वाले ऑनबोर्डिंग फ़्लो का वर्णन करता है। 46. लक्ष्य एक
    स्मूद “day 0” अनुभव है: जहाँ Gateway चलता है वह चुनें, auth कनेक्ट करें, विज़ार्ड चलाएँ, और एजेंट को खुद को बूटस्ट्रैप करने दें।

<Steps>
<Step title="Approve macOS warning">
<Frame>
<img src="/assets/macos-onboarding/01-macos-warning.jpeg" alt="" />
</Frame>
</Step>
<Step title="Approve find local networks">
<Frame>
<img src="/assets/macos-onboarding/02-local-networks.jpeg" alt="" />
</Frame>
</Step>
<Step title="Welcome and security notice">
<Frame caption="प्रदर्शित सुरक्षा सूचना पढ़ें और उसके अनुसार निर्णय लें">
<img src="/assets/macos-onboarding/03-security-notice.png" alt="" />
</Frame>
</Step>
<Step title="Local vs Remote">
<Frame>
<img src="/assets/macos-onboarding/04-choose-gateway.png" alt="" />
</Frame>

**Gateway** कहाँ चलता है?

- **यह Mac (केवल स्थानीय):** ऑनबोर्डिंग OAuth प्रवाह चला सकता है और क्रेडेंशियल
  स्थानीय रूप से लिख सकता है।
- **दूरस्थ (SSH/Tailnet के माध्यम से):** ऑनबोर्डिंग स्थानीय रूप से OAuth **नहीं** चलाता;
  क्रेडेंशियल Gateway होस्ट पर मौजूद होने चाहिए।
- **बाद में विन्यास करें:** सेटअप छोड़ें और ऐप को बिना विन्यास के छोड़ दें।

<Tip>
47. **Gateway auth tip:**
- अब विज़ार्ड लूपबैक के लिए भी एक **token** जनरेट करता है, इसलिए लोकल WS क्लाइंट्स को ऑथेंटिकेट करना होगा।
48. - अगर आप auth डिसेबल करते हैं, तो कोई भी लोकल प्रोसेस कनेक्ट कर सकता है; इसे सिर्फ़ पूरी तरह भरोसेमंद मशीनों पर ही इस्तेमाल करें।
49. - मल्टी‑मशीन एक्सेस या नॉन‑लूपबैक बाइंड्स के लिए **token** का उपयोग करें।
</Tip>
</Step>
<Step title="Permissions">
<Frame caption="चुनें कि आप OpenClaw को कौन‑सी अनुमतियाँ देना चाहते हैं">
<img src="/assets/macos-onboarding/05-permissions.png" alt="" />
</Frame>

ऑनबोर्डिंग निम्न के लिए आवश्यक TCC अनुमतियों का अनुरोध करता है:

- Automation (AppleScript)
- Notifications
- Accessibility
- Screen Recording
- Microphone
- Speech Recognition
- Camera
- Location

</Step>
<Step title="CLI">
  <Info>यह चरण वैकल्पिक है</Info>
  ऐप npm/pnpm के माध्यम से वैश्विक `openclaw` CLI स्थापित कर सकता है ताकि टर्मिनल
  वर्कफ़्लो और launchd कार्य तुरंत काम करें।
</Step>
<Step title="Onboarding Chat (dedicated session)">
  50. सेटअप के बाद, ऐप एक समर्पित ऑनबोर्डिंग चैट सेशन खोलता है ताकि एजेंट अपना परिचय दे सके और अगले चरणों का मार्गदर्शन कर सके। This keeps first‑run guidance separate
  from your normal conversation. See [Bootstrapping](/start/bootstrapping) for
  what happens on the gateway host during the first agent run.
</Step>
</Steps>
