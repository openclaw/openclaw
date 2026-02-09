---
summary: "OpenClaw के लिए VPS होस्टिंग हब (Oracle/Fly/Hetzner/GCP/exe.dev)"
read_when:
  - आप Gateway को क्लाउड में चलाना चाहते हैं
  - आपको VPS/होस्टिंग गाइड्स का एक त्वरित मानचित्र चाहिए
title: "VPS होस्टिंग"
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
- 48. **AWS (EC2/Lightsail/free tier)**: यह भी अच्छी तरह काम करता है। 49. वीडियो गाइड:
      [https://x.com/techfrenAJ/status/2014934471095812547](https://x.com/techfrenAJ/status/2014934471095812547)

## क्लाउड सेटअप कैसे काम करते हैं

- **Gateway VPS पर चलता है** और state + workspace का स्वामी होता है।
- आप अपने लैपटॉप/फ़ोन से **Control UI** या **Tailscale/SSH** के माध्यम से कनेक्ट करते हैं।
- VPS को सत्य का स्रोत मानें और state + workspace का **बैकअप** लें।
- 50. सुरक्षित डिफ़ॉल्ट: Gateway को loopback पर रखें और SSH टनल या Tailscale Serve के माध्यम से एक्सेस करें।
      If you bind to `lan`/`tailnet`, require `gateway.auth.token` or `gateway.auth.password`.

दूरस्थ एक्सेस: [Gateway remote](/gateway/remote)  
प्लैटफ़ॉर्म्स हब: [Platforms](/platforms)

## VPS के साथ nodes का उपयोग

You can keep the Gateway in the cloud and pair **nodes** on your local devices
(Mac/iOS/Android/headless). Nodes provide local screen/camera/canvas and `system.run`
capabilities while the Gateway stays in the cloud.

डॉक्स: [Nodes](/nodes), [Nodes CLI](/cli/nodes)
