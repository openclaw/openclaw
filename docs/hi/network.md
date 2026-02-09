---
summary: "नेटवर्क हब: Gateway सतहें, पेयरिंग, डिस्कवरी और सुरक्षा"
read_when:
  - आपको नेटवर्क आर्किटेक्चर और सुरक्षा का अवलोकन चाहिए
  - आप local बनाम tailnet एक्सेस या पेयरिंग का डिबग कर रहे हैं
  - आप नेटवर्किंग दस्तावेज़ों की आधिकारिक सूची चाहते हैं
title: "नेटवर्क"
---

# नेटवर्क हब

यह हब उन मुख्य दस्तावेज़ों को जोड़ता है जो बताते हैं कि OpenClaw
localhost, LAN और tailnet पर उपकरणों को कैसे जोड़ता, पेयर करता और सुरक्षित करता है।

## कोर मॉडल

- [Gateway आर्किटेक्चर](/concepts/architecture)
- [Gateway प्रोटोकॉल](/gateway/protocol)
- [Gateway रनबुक](/gateway)
- [वेब सतहें + बाइंड मोड](/web)

## पेयरिंग + पहचान

- [पेयरिंग अवलोकन (DM + नोड्स)](/channels/pairing)
- [Gateway-स्वामित्व वाले नोड की पेयरिंग](/gateway/pairing)
- [डिवाइस CLI (पेयरिंग + टोकन रोटेशन)](/cli/devices)
- [पेयरिंग CLI (DM अनुमोदन)](/cli/pairing)

स्थानीय भरोसा:

- स्थानीय कनेक्शन (loopback या Gateway होस्ट का अपना tailnet पता)
  को समान-होस्ट UX को सहज रखने के लिए पेयरिंग हेतु स्वतः अनुमोदित किया जा सकता है।
- गैर-स्थानीय tailnet/LAN क्लाइंट्स के लिए अब भी स्पष्ट पेयरिंग अनुमोदन आवश्यक है।

## डिस्कवरी + ट्रांसपोर्ट्स

- [डिस्कवरी और ट्रांसपोर्ट्स](/gateway/discovery)
- [Bonjour / mDNS](/gateway/bonjour)
- [दूरस्थ एक्सेस (SSH)](/gateway/remote)
- [Tailscale](/gateway/tailscale)

## नोड्स + ट्रांसपोर्ट्स

- [नोड्स अवलोकन](/nodes)
- [ब्रिज प्रोटोकॉल (लीगेसी नोड्स)](/gateway/bridge-protocol)
- [नोड रनबुक: iOS](/platforms/ios)
- [नोड रनबुक: Android](/platforms/android)

## सुरक्षा

- [सुरक्षा अवलोकन](/gateway/security)
- [Gateway विन्यास संदर्भ](/gateway/configuration)
- [समस्या-निवारण](/gateway/troubleshooting)
- [Doctor](/gateway/doctor)
