---
summary: "Gateway, नोड्स और कैनवास होस्ट कैसे कनेक्ट होते हैं।"
read_when:
  - "आप Gateway नेटवर्किंग मॉडल का संक्षिप्त दृश्य चाहते हैं"
title: "नेटवर्क मॉडल"
x-i18n:
  source_path: gateway/network-model.md
  source_hash: e3508b884757ef19
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:49:15Z
---

अधिकांश संचालन Gateway (`openclaw gateway`) के माध्यम से प्रवाहित होते हैं, जो एक एकल दीर्घकालिक
प्रक्रिया है और चैनल कनेक्शनों तथा WebSocket नियंत्रण प्लेन का स्वामित्व रखती है।

## मुख्य नियम

- प्रति होस्ट एक Gateway की अनुशंसा की जाती है। यह WhatsApp Web सत्र का स्वामित्व रखने वाली एकमात्र प्रक्रिया है। रेस्क्यू बॉट्स या कड़ी आइसोलेशन के लिए, अलग-अलग प्रोफ़ाइल और पोर्ट के साथ कई gateways चलाएँ। देखें [Multiple gateways](/gateway/multiple-gateways)।
- पहले लूपबैक: Gateway WS का डिफ़ॉल्ट `ws://127.0.0.1:18789` है। विज़ार्ड डिफ़ॉल्ट रूप से gateway टोकन उत्पन्न करता है, यहाँ तक कि लूपबैक के लिए भी। tailnet एक्सेस के लिए, `openclaw gateway --bind tailnet --token ...` चलाएँ क्योंकि non-loopback बाइंड्स के लिए टोकन आवश्यक होते हैं।
- नोड्स आवश्यकता अनुसार LAN, tailnet, या SSH पर Gateway WS से कनेक्ट होते हैं। लेगेसी TCP ब्रिज अप्रचलित है।
- कैनवास होस्ट `canvasHost.port` पर एक HTTP फ़ाइल सर्वर है (डिफ़ॉल्ट `18793`), जो नोड WebViews के लिए `/__openclaw__/canvas/` परोसता है। देखें [Gateway configuration](/gateway/configuration) (`canvasHost`)।
- दूरस्थ उपयोग सामान्यतः SSH टनल या tailnet VPN होता है। देखें [Remote access](/gateway/remote) और [Discovery](/gateway/discovery)।
