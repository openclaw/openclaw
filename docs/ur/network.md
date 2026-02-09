---
summary: "نیٹ ورک ہب: گیٹ وے سرفیسز، جوڑی بنانا، ڈسکوری، اور سکیورٹی"
read_when:
  - آپ کو نیٹ ورک آرکیٹیکچر اور سکیورٹی کا جائزہ درکار ہو
  - آپ local بمقابلہ tailnet رسائی یا pairing کی خرابیوں کا ازالہ کر رہے ہوں
  - آپ نیٹ ورکنگ دستاویزات کی مستند فہرست چاہتے ہوں
title: "نیٹ ورک"
---

# نیٹ ورک ہب

یہ ہب اُن بنیادی دستاویزات کو جوڑتا ہے جو بتاتی ہیں کہ OpenClaw
localhost، LAN، اور tailnet کے ذریعے ڈیوائسز کو کیسے کنیکٹ کرتا ہے، جوڑی بناتا ہے، اور محفوظ رکھتا ہے۔

## بنیادی ماڈل

- [Gateway architecture](/concepts/architecture)
- [Gateway protocol](/gateway/protocol)
- [Gateway runbook](/gateway)
- [Web surfaces + bind modes](/web)

## pairing + شناخت

- [Pairing overview (DM + nodes)](/channels/pairing)
- [Gateway-owned node pairing](/gateway/pairing)
- [Devices CLI (pairing + token rotation)](/cli/devices)
- [Pairing CLI (DM approvals)](/cli/pairing)

مقامی اعتماد:

- مقامی کنیکشنز (loopback یا گیٹ وے ہوسٹ کا اپنا tailnet پتہ) کو
  pairing کے لیے خودکار طور پر منظور کیا جا سکتا ہے تاکہ ایک ہی ہوسٹ پر UX ہموار رہے۔
- غیر مقامی tailnet/LAN کلائنٹس کے لیے اب بھی صریح pairing منظوری درکار ہوتی ہے۔

## ڈسکوری + ٹرانسپورٹس

- [Discovery & transports](/gateway/discovery)
- [Bonjour / mDNS](/gateway/bonjour)
- [Remote access (SSH)](/gateway/remote)
- [Tailscale](/gateway/tailscale)

## نوڈز + ٹرانسپورٹس

- [Nodes overview](/nodes)
- [Bridge protocol (legacy nodes)](/gateway/bridge-protocol)
- [Node runbook: iOS](/platforms/ios)
- [Node runbook: Android](/platforms/android)

## سکیورٹی

- [Security overview](/gateway/security)
- [Gateway config reference](/gateway/configuration)
- [Troubleshooting](/gateway/troubleshooting)
- [Doctor](/gateway/doctor)
