---
summary: "mac ऐप में Voice Wake और push-to-talk मोड्स तथा रूटिंग विवरण"
read_when:
  - Voice wake या PTT पाथवे पर काम करते समय
title: "Voice Wake"
---

# Voice Wake & Push-to-Talk

## मोड्स

- **Wake-word mode** (default): always-on Speech recognizer waits for trigger tokens (`swabbleTriggerWords`). On match it starts capture, shows the overlay with partial text, and auto-sends after silence.
- **Push-to-talk (Right Option hold)**: hold the right Option key to capture immediately—no trigger needed. The overlay appears while held; releasing finalizes and forwards after a short delay so you can tweak text.

## रनटाइम व्यवहार (wake-word)

- Speech recognizer `VoiceWakeRuntime` में रहता है।
- Trigger only fires when there’s a **meaningful pause** between the wake word and the next word (~0.55s gap). The overlay/chime can start on the pause even before the command begins.
- मौन विंडो: जब भाषण चल रहा हो तो 2.0s, और यदि केवल ट्रिगर सुना गया हो तो 5.0s।
- हार्ड स्टॉप: अनियंत्रित सत्रों को रोकने के लिए 120s।
- सत्रों के बीच डिबाउंस: 350ms।
- ओवरले `VoiceWakeOverlayController` के माध्यम से कमिटेड/वोलेटाइल रंगों के साथ संचालित होता है।
- भेजने के बाद, अगला ट्रिगर सुनने के लिए recognizer साफ़-सुथरे ढंग से पुनः शुरू होता है।

## लाइफ़साइकल इनवेरिएंट्स

- यदि Voice Wake सक्षम है और अनुमतियाँ दी गई हैं, तो wake-word recognizer को सुनते रहना चाहिए (स्पष्ट push-to-talk कैप्चर के दौरान को छोड़कर)।
- ओवरले की दृश्यता (X बटन से मैनुअल डिसमिस सहित) कभी भी recognizer के पुनः शुरू होने में बाधा नहीं बननी चाहिए।

## स्टिकी ओवरले विफलता मोड (पिछला)

पहले, यदि ओवरले दिखाई देते हुए अटक जाता था और आप उसे मैन्युअल रूप से बंद करते थे, तो Voice Wake “मरा हुआ” प्रतीत हो सकता था क्योंकि रनटाइम का रीस्टार्ट प्रयास ओवरले की दृश्यता से अवरुद्ध हो सकता था और कोई बाद का रीस्टार्ट शेड्यूल नहीं होता था।

हार्डनिंग:

- Wake रनटाइम रीस्टार्ट अब ओवरले की दृश्यता से अवरुद्ध नहीं होता।
- ओवरले डिसमिस पूर्ण होने पर `VoiceSessionCoordinator` के माध्यम से `VoiceWakeRuntime.refresh(...)` ट्रिगर होता है, इसलिए मैनुअल X-डिसमिस हमेशा सुनना पुनः शुरू करता है।

## Push-to-talk विवरण

- Hotkey detection uses a global `.flagsChanged` monitor for **right Option** (`keyCode 61` + `.option`). We only observe events (no swallowing).
- कैप्चर पाइपलाइन `VoicePushToTalk` में रहती है: Speech तुरंत शुरू होती है, आंशिक परिणाम ओवरले में स्ट्रीम होते हैं, और रिलीज़ पर `VoiceWakeForwarder` कॉल होता है।
- जब push-to-talk शुरू होता है, तो दोहरे ऑडियो टैप से बचने के लिए हम wake-word रनटाइम को पॉज़ करते हैं; रिलीज़ के बाद यह स्वतः पुनः शुरू हो जाता है।
- अनुमतियाँ: Microphone + Speech आवश्यक; इवेंट्स देखने के लिए Accessibility/Input Monitoring की स्वीकृति चाहिए।
- बाहरी कीबोर्ड: कुछ में right Option अपेक्षित रूप से उपलब्ध नहीं होता—यदि उपयोगकर्ता मिस की रिपोर्ट करें तो एक फ़ॉलबैक शॉर्टकट प्रदान करें।

## उपयोगकर्ता-समक्ष सेटिंग्स

- **Voice Wake** टॉगल: wake-word रनटाइम सक्षम करता है।
- **Hold Cmd+Fn to talk**: enables the push-to-talk monitor. Disabled on macOS < 26.
- भाषा और माइक पिकर, लाइव लेवल मीटर, ट्रिगर-वर्ड तालिका, टेस्टर (केवल स्थानीय; फ़ॉरवर्ड नहीं करता)।
- माइक पिकर डिवाइस डिस्कनेक्ट होने पर अंतिम चयन को सुरक्षित रखता है, डिस्कनेक्टेड संकेत दिखाता है, और लौटने तक अस्थायी रूप से सिस्टम डिफ़ॉल्ट पर फ़ॉलबैक करता है।
- **Sounds**: chimes on trigger detect and on send; defaults to the macOS “Glass” system sound. You can pick any `NSSound`-loadable file (e.g. MP3/WAV/AIFF) for each event or choose **No Sound**.

## फ़ॉरवर्डिंग व्यवहार

- जब Voice Wake सक्षम होता है, तो ट्रांसक्रिप्ट्स सक्रिय gateway/agent को फ़ॉरवर्ड किए जाते हैं (mac ऐप के शेष भाग में उपयोग किए जाने वाले समान लोकल बनाम रिमोट मोड के साथ)।
- Replies are delivered to the **last-used main provider** (WhatsApp/Telegram/Discord/WebChat). If delivery fails, the error is logged and the run is still visible via WebChat/session logs.

## फ़ॉरवर्डिंग पेलोड

- `VoiceWakeForwarder.prefixedTranscript(_:)` prepends the machine hint before sending. Shared between wake-word and push-to-talk paths.

## त्वरित सत्यापन

- push-to-talk चालू करें, Cmd+Fn दबाए रखें, बोलें, छोड़ें: ओवरले को आंशिक परिणाम दिखाने चाहिए और फिर भेजना चाहिए।
- दबाए रखने के दौरान, मेन्यू-बार के कान बड़े बने रहने चाहिए (`triggerVoiceEars(ttl:nil)` का उपयोग करता है); रिलीज़ के बाद वे घट जाते हैं।
