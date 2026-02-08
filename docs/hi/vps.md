---
summary: "OpenClaw के लिए VPS होस्टिंग हब (Oracle/Fly/Hetzner/GCP/exe.dev)"
read_when:
  - आप Gateway को क्लाउड में चलाना चाहते हैं
  - आपको VPS/होस्टिंग गाइड्स का एक त्वरित मानचित्र चाहिए
title: "VPS होस्टिंग"
x-i18n:
  source_path: vps.md
  source_hash: 96593a1550b56040
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:49:44Z
---

# VPS होस्टिंग

यह हब समर्थित VPS/होस्टिंग गाइड्स के लिंक देता है और यह समझाता है कि क्लाउड
डिप्लॉयमेंट उच्च स्तर पर कैसे काम करते हैं।

## प्रदाता चुनें

- **Railway** (वन‑क्लिक + ब्राउज़र सेटअप): [Railway](/install/railway)
- **Northflank** (वन‑क्लिक + ब्राउज़र सेटअप): [Northflank](/install/northflank)
- **Oracle Cloud (Always Free)**: [Oracle](/platforms/oracle) — $0/माह (Always Free, ARM; क्षमता/साइन‑अप कभी‑कभी जटिल हो सकता है)
- **Fly.io**: [Fly.io](/install/fly)
- **Hetzner (Docker)**: [Hetzner](/install/hetzner)
- **GCP (Compute Engine)**: [GCP](/install/gcp)
- **exe.dev** (VM + HTTPS प्रॉक्सी): [exe.dev](/install/exe-dev)
- **AWS (EC2/Lightsail/free tier)**: यह भी अच्छी तरह काम करता है। वीडियो गाइड:
  [https://x.com/techfrenAJ/status/2014934471095812547](https://x.com/techfrenAJ/status/2014934471095812547)

## क्लाउड सेटअप कैसे काम करते हैं

- **Gateway VPS पर चलता है** और state + workspace का स्वामी होता है।
- आप अपने लैपटॉप/फ़ोन से **Control UI** या **Tailscale/SSH** के माध्यम से कनेक्ट करते हैं।
- VPS को सत्य का स्रोत मानें और state + workspace का **बैकअप** लें।
- डिफ़ॉल्ट रूप से सुरक्षित: Gateway को loopback पर रखें और SSH टनल या Tailscale Serve के माध्यम से एक्सेस करें।
  यदि आप `lan`/`tailnet` से bind करते हैं, तो `gateway.auth.token` या `gateway.auth.password` की आवश्यकता रखें।

दूरस्थ एक्सेस: [Gateway remote](/gateway/remote)  
प्लैटफ़ॉर्म्स हब: [Platforms](/platforms)

## VPS के साथ nodes का उपयोग

आप Gateway को क्लाउड में रख सकते हैं और अपने स्थानीय डिवाइसों
(Mac/iOS/Android/headless) पर **nodes** जोड़ सकते हैं। Nodes स्थानीय स्क्रीन/कैमरा/कैनवास और `system.run`
क्षमताएँ प्रदान करते हैं, जबकि Gateway क्लाउड में ही रहता है।

डॉक्स: [Nodes](/nodes), [Nodes CLI](/cli/nodes)
