---
summary: "OpenClaw (macOS ऐप) के लिए पहली‑बार ऑनबोर्डिंग प्रवाह"
read_when:
  - macOS ऑनबोर्डिंग सहायक का डिज़ाइन करते समय
  - प्रमाणीकरण या पहचान सेटअप लागू करते समय
title: "ऑनबोर्डिंग (macOS ऐप)"
sidebarTitle: "Onboarding: macOS App"
x-i18n:
  source_path: start/onboarding.md
  source_hash: 45f912067527158f
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:49:46Z
---

# ऑनबोर्डिंग (macOS ऐप)

यह दस्तावेज़ **वर्तमान** पहली‑बार ऑनबोर्डिंग प्रवाह का वर्णन करता है। लक्ष्य एक
सुचारु “दिन 0” अनुभव है: Gateway कहाँ चलेगा यह चुनें, प्रमाणीकरण से कनेक्ट करें,
विज़ार्ड चलाएँ, और एजेंट को स्वयं बूटस्ट्रैप करने दें।

<Steps>
<Step title="macOS चेतावनी स्वीकृत करें">
<Frame>
<img src="/assets/macos-onboarding/01-macos-warning.jpeg" alt="" />
</Frame>
</Step>
<Step title="स्थानीय नेटवर्क खोज की अनुमति दें">
<Frame>
<img src="/assets/macos-onboarding/02-local-networks.jpeg" alt="" />
</Frame>
</Step>
<Step title="स्वागत और सुरक्षा सूचना">
<Frame caption="प्रदर्शित सुरक्षा सूचना पढ़ें और उसके अनुसार निर्णय लें">
<img src="/assets/macos-onboarding/03-security-notice.png" alt="" />
</Frame>
</Step>
<Step title="स्थानीय बनाम दूरस्थ">
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
**Gateway प्रमाणीकरण सुझाव:**
- विज़ार्ड अब loopback के लिए भी एक **टोकन** बनाता है, इसलिए स्थानीय WS क्लाइंट्स को प्रमाणीकरण करना होगा।
- यदि आप प्रमाणीकरण अक्षम करते हैं, तो कोई भी स्थानीय प्रक्रिया कनेक्ट हो सकती है; इसका उपयोग केवल पूरी तरह विश्वसनीय मशीनों पर करें।
- बहु‑मशीन पहुँच या non‑loopback बाइंड्स के लिए **टोकन** का उपयोग करें।
</Tip>
</Step>
<Step title="अनुमतियाँ">
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
<Step title="ऑनबोर्डिंग चैट (समर्पित सत्र)">
  सेटअप के बाद, ऐप एक समर्पित ऑनबोर्डिंग चैट सत्र खोलता है ताकि एजेंट स्वयं का परिचय
  दे सके और अगले चरणों का मार्गदर्शन कर सके। यह पहली‑बार के मार्गदर्शन को आपकी सामान्य
  बातचीत से अलग रखता है। पहली एजेंट रन के दौरान Gateway होस्ट पर क्या होता है, इसके लिए
  [Bootstrapping](/start/bootstrapping) देखें।
</Step>
</Steps>
