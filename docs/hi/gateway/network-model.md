---
summary: "Gateway, नोड्स और कैनवास होस्ट कैसे कनेक्ट होते हैं।"
read_when:
  - आप Gateway नेटवर्किंग मॉडल का संक्षिप्त दृश्य चाहते हैं
title: "नेटवर्क मॉडल"
---

अधिकांश संचालन Gateway (`openclaw gateway`) के माध्यम से प्रवाहित होते हैं, जो एक एकल दीर्घकालिक
प्रक्रिया है और चैनल कनेक्शनों तथा WebSocket नियंत्रण प्लेन का स्वामित्व रखती है।

## मुख्य नियम

- प्रति होस्ट एक Gateway की अनुशंसा की जाती है। यह WhatsApp Web सत्र का स्वामित्व रखने की अनुमति प्राप्त एकमात्र प्रक्रिया है। रेस्क्यू बॉट्स या सख़्त आइसोलेशन के लिए, अलग-अलग प्रोफ़ाइल और पोर्ट के साथ कई gateways चलाएँ। [Multiple gateways](/gateway/multiple-gateways) देखें।
- पहले लूपबैक: Gateway WS का डिफ़ॉल्ट `ws://127.0.0.1:18789` है। विज़ार्ड डिफ़ॉल्ट रूप से एक gateway टोकन बनाता है, यहाँ तक कि लूपबैक के लिए भी। tailnet एक्सेस के लिए, `openclaw gateway --bind tailnet --token ...` चलाएँ क्योंकि non-loopback binds के लिए टोकन आवश्यक होते हैं।
- Nodes आवश्यकता अनुसार LAN, tailnet, या SSH के माध्यम से Gateway WS से कनेक्ट होते हैं। लेगेसी TCP ब्रिज अप्रचलित (deprecated) है।
- Canvas host `canvasHost.port` (डिफ़ॉल्ट `18793`) पर एक HTTP फ़ाइल सर्वर है, जो node WebViews के लिए `/__openclaw__/canvas/` सर्व करता है। [Gateway configuration](/gateway/configuration) (`canvasHost`) देखें।
- रिमोट उपयोग सामान्यतः SSH टनल या tailnet VPN होता है। [Remote access](/gateway/remote) और [Discovery](/gateway/discovery) देखें।
