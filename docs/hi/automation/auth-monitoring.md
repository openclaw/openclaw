---
summary: "मॉडल प्रदाताओं के लिए OAuth की समाप्ति की निगरानी करें"
read_when:
  - प्रमाणीकरण समाप्ति की निगरानी या अलर्ट सेट करते समय
  - Claude Code / Codex OAuth रिफ्रेश जाँचों का स्वचालन करते समय
title: "प्रमाणीकरण निगरानी"
---

# प्रमाणीकरण निगरानी

OpenClaw `openclaw models status` के माध्यम से OAuth expiry health को उजागर करता है। इसे automation और alerting के लिए उपयोग करें; फोन workflows के लिए scripts वैकल्पिक अतिरिक्त हैं।

## अनुशंसित: CLI जाँच (पोर्टेबल)

```bash
openclaw models status --check
```

एग्ज़िट कोड्स:

- `0`: ठीक
- `1`: समाप्त या अनुपलब्ध क्रेडेंशियल्स
- `2`: शीघ्र समाप्त (24 घंटे के भीतर)

यह cron/systemd में काम करता है और किसी अतिरिक्त स्क्रिप्ट की आवश्यकता नहीं होती।

## वैकल्पिक स्क्रिप्ट्स (ops / फ़ोन वर्कफ़्लो)

ये `scripts/` के अंतर्गत रहते हैं और **वैकल्पिक** हैं। ये gateway host पर SSH access मानते हैं और systemd + Termux के लिए ट्यून किए गए हैं।

- `scripts/claude-auth-status.sh` अब `openclaw models status --json` को
  सत्य का स्रोत मानता है (यदि CLI उपलब्ध न हो तो सीधे फ़ाइल रीड पर फ़ॉलबैक करता है),
  इसलिए टाइमर्स के लिए `PATH` पर `openclaw` रखें।
- `scripts/auth-monitor.sh`: cron/systemd टाइमर लक्ष्य; अलर्ट भेजता है (ntfy या फ़ोन)।
- `scripts/systemd/openclaw-auth-monitor.{service,timer}`: systemd यूज़र टाइमर।
- `scripts/claude-auth-status.sh`: Claude Code + OpenClaw प्रमाणीकरण जाँचकर्ता (full/json/simple)।
- `scripts/mobile-reauth.sh`: SSH के माध्यम से निर्देशित पुनः‑प्रमाणीकरण फ़्लो।
- `scripts/termux-quick-auth.sh`: वन‑टैप विजेट स्थिति + प्रमाणीकरण URL खोलें।
- `scripts/termux-auth-widget.sh`: पूर्ण निर्देशित विजेट फ़्लो।
- `scripts/termux-sync-widget.sh`: Claude Code क्रेड्स → OpenClaw समन्वय।

यदि आपको फ़ोन स्वचालन या systemd टाइमर्स की आवश्यकता नहीं है, तो इन स्क्रिप्ट्स को छोड़ दें।
