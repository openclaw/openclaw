---
summary: "DigitalOcean पर OpenClaw (सरल सशुल्क VPS विकल्प)"
read_when:
  - DigitalOcean पर OpenClaw सेटअप कर रहे हों
  - OpenClaw के लिए सस्ता VPS होस्टिंग ढूँढ रहे हों
title: "DigitalOcean"
---

# DigitalOcean पर OpenClaw

## लक्ष्य

DigitalOcean पर **$6/माह** (या आरक्षित मूल्य निर्धारण के साथ $4/माह) में एक स्थायी OpenClaw Gateway चलाना।

यदि आप $0/माह का विकल्प चाहते हैं और ARM + प्रदाता-विशिष्ट सेटअप से आपको आपत्ति नहीं है, तो [Oracle Cloud गाइड](/platforms/oracle) देखें।

## लागत तुलना (2026)

| प्रदाता      | प्लान           | स्पेक्स                 | मूल्य/माह                                                      | टिप्पणियाँ                         |
| ------------ | --------------- | ----------------------- | -------------------------------------------------------------- | ---------------------------------- |
| Oracle Cloud | Always Free ARM | अधिकतम 4 OCPU, 24GB RAM | $0                                                             | ARM, सीमित क्षमता / साइनअप अड़चनें |
| Hetzner      | CX22            | 2 vCPU, 4GB RAM         | €3.79 (~$4) | सबसे सस्ता सशुल्क विकल्प           |
| DigitalOcean | Basic           | 1 vCPU, 1GB RAM         | $6                                                             | आसान UI, अच्छे दस्तावेज़           |
| Vultr        | Cloud Compute   | 1 vCPU, 1GB RAM         | $6                                                             | कई लोकेशन                          |
| Linode       | Nanode          | 1 vCPU, 1GB RAM         | $5                                                             | अब Akamai का हिस्सा                |

**प्रदाता चुनना:**

- DigitalOcean: सबसे सरल UX + पूर्वानुमेय सेटअप (यह गाइड)
- Hetzner: अच्छा मूल्य/प्रदर्शन (देखें [Hetzner गाइड](/install/hetzner))
- Oracle Cloud: $0/माह हो सकता है, लेकिन अधिक झंझटदार और केवल ARM (देखें [Oracle गाइड](/platforms/oracle))

---

## पूर्वापेक्षाएँ

- DigitalOcean खाता ([$200 मुफ्त क्रेडिट के साथ साइनअप](https://m.do.co/c/signup))
- SSH कुंजी जोड़ी (या पासवर्ड प्रमाणीकरण उपयोग करने की इच्छा)
- ~20 मिनट

## 1. Droplet बनाएँ

1. [DigitalOcean](https://cloud.digitalocean.com/) में लॉग इन करें
2. **Create → Droplets** पर क्लिक करें
3. चुनें:
   - **Region:** आपके (या आपके उपयोगकर्ताओं) के सबसे निकट
   - **Image:** Ubuntu 24.04 LTS
   - **Size:** Basic → Regular → **$6/माह** (1 vCPU, 1GB RAM, 25GB SSD)
   - **Authentication:** SSH कुंजी (अनुशंसित) या पासवर्ड
4. **Create Droplet** पर क्लिक करें
5. IP पता नोट करें

## 2) SSH के माध्यम से कनेक्ट करें

```bash
ssh root@YOUR_DROPLET_IP
```

## 3. OpenClaw इंस्टॉल करें

```bash
# Update system
apt update && apt upgrade -y

# Install Node.js 22
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt install -y nodejs

# Install OpenClaw
curl -fsSL https://openclaw.ai/install.sh | bash

# Verify
openclaw --version
```

## 4. ऑनबोर्डिंग चलाएँ

```bash
openclaw onboard --install-daemon
```

विज़ार्ड आपको इन चरणों से गुज़ारेगा:

- मॉडल प्रमाणीकरण (API कुंजियाँ या OAuth)
- चैनल सेटअप (Telegram, WhatsApp, Discord, आदि)
- Gateway टोकन (स्वतः जनरेट)
- डेमन इंस्टॉलेशन (systemd)

## 5. Gateway सत्यापित करें

```bash
# Check status
openclaw status

# Check service
systemctl --user status openclaw-gateway.service

# View logs
journalctl --user -u openclaw-gateway.service -f
```

## 6. डैशबोर्ड तक पहुँचें

The gateway binds to loopback by default. To access the Control UI:

**विकल्प A: SSH टनल (अनुशंसित)**

```bash
# From your local machine
ssh -L 18789:localhost:18789 root@YOUR_DROPLET_IP

# Then open: http://localhost:18789
```

**विकल्प B: Tailscale Serve (HTTPS, केवल loopback)**

```bash
# On the droplet
curl -fsSL https://tailscale.com/install.sh | sh
tailscale up

# Configure Gateway to use Tailscale Serve
openclaw config set gateway.tailscale.mode serve
openclaw gateway restart
```

खोलें: `https://<magicdns>/`

टिप्पणियाँ:

- Serve Gateway को केवल loopback तक सीमित रखता है और Tailscale पहचान हेडर के माध्यम से प्रमाणीकरण करता है।
- इसके बजाय टोकन/पासवर्ड की आवश्यकता के लिए, `gateway.auth.allowTailscale: false` सेट करें या `gateway.auth.mode: "password"` उपयोग करें।

**विकल्प C: Tailnet bind (Serve के बिना)**

```bash
openclaw config set gateway.bind tailnet
openclaw gateway restart
```

खोलें: `http://<tailscale-ip>:18789` (टोकन आवश्यक)।

## 7. अपने चैनल कनेक्ट करें

### Telegram

```bash
openclaw pairing list telegram
openclaw pairing approve telegram <CODE>
```

### WhatsApp

```bash
openclaw channels login whatsapp
# Scan QR code
```

अन्य प्रदाताओं के लिए [Channels](/channels) देखें।

---

## 1GB RAM के लिए अनुकूलन

The $6 droplet only has 1GB RAM. To keep things running smoothly:

### Swap जोड़ें (अनुशंसित)

```bash
fallocate -l 2G /swapfile
chmod 600 /swapfile
mkswap /swapfile
swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab
```

### हल्का मॉडल उपयोग करें

यदि आपको OOM समस्याएँ आ रही हैं, तो विचार करें:

- लोकल मॉडलों के बजाय API-आधारित मॉडल (Claude, GPT) का उपयोग
- `agents.defaults.model.primary` को छोटे मॉडल पर सेट करना

### मेमोरी मॉनिटर करें

```bash
free -h
htop
```

---

## स्थायित्व

सभी स्टेट यहाँ रहती है:

- `~/.openclaw/` — विन्यास, क्रेडेंशियल्स, सत्र डेटा
- `~/.openclaw/workspace/` — वर्कस्पेस (SOUL.md, मेमोरी, आदि)

ये reboots के बाद भी बने रहते हैं। Back them up periodically:

```bash
tar -czvf openclaw-backup.tar.gz ~/.openclaw ~/.openclaw/workspace
```

---

## Oracle Cloud का मुफ्त विकल्प

Oracle Cloud **Always Free** ARM इंस्टेंस प्रदान करता है, जो यहाँ दिए गए किसी भी सशुल्क विकल्प से काफ़ी अधिक शक्तिशाली हैं — $0/माह में।

| आपको क्या मिलता है | स्पेक्स                      |
| ------------------ | ---------------------------- |
| **4 OCPUs**        | ARM Ampere A1                |
| **24GB RAM**       | आवश्यकता से अधिक             |
| **200GB स्टोरेज**  | ब्लॉक वॉल्यूम                |
| **हमेशा मुफ्त**    | कोई क्रेडिट कार्ड शुल्क नहीं |

**सीमाएँ:**

- साइनअप कभी-कभी झंझटदार हो सकता है (असफल हो तो पुनः प्रयास करें)
- ARM आर्किटेक्चर — अधिकांश चीज़ें काम करती हैं, लेकिन कुछ बाइनरीज़ को ARM बिल्ड चाहिए

For the full setup guide, see [Oracle Cloud](/platforms/oracle). For signup tips and troubleshooting the enrollment process, see this [community guide](https://gist.github.com/rssnyder/51e3cfedd730e7dd5f4a816143b25dbd).

---

## समस्या-निवारण

### Gateway शुरू नहीं हो रहा

```bash
openclaw gateway status
openclaw doctor --non-interactive
journalctl -u openclaw --no-pager -n 50
```

### पोर्ट पहले से उपयोग में है

```bash
lsof -i :18789
kill <PID>
```

### मेमोरी समाप्त

```bash
# Check memory
free -h

# Add more swap
# Or upgrade to $12/mo droplet (2GB RAM)
```

---

## यह भी देखें

- [Hetzner गाइड](/install/hetzner) — सस्ता, अधिक शक्तिशाली
- [Docker इंस्टॉल](/install/docker) — कंटेनर-आधारित सेटअप
- [Tailscale](/gateway/tailscale) — सुरक्षित रिमोट एक्सेस
- [Configuration](/gateway/configuration) — पूर्ण विन्यास संदर्भ
