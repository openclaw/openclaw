---
summary: "Oracle Cloud पर OpenClaw (Always Free ARM)"
read_when:
  - Oracle Cloud पर OpenClaw सेटअप करना
  - OpenClaw के लिए कम-लागत VPS होस्टिंग की तलाश
  - छोटे सर्वर पर 24/7 OpenClaw चाहते हैं
title: "Oracle Cloud"
---

# Oracle Cloud (OCI) पर OpenClaw

## लक्ष्य

Oracle Cloud के **Always Free** ARM टियर पर एक स्थायी OpenClaw Gateway चलाना।

Oracle का फ्री टियर OpenClaw के लिए एक अच्छा विकल्प हो सकता है (खासकर यदि आपके पास पहले से OCI खाता है), लेकिन इसमें कुछ समझौते हैं:

- ARM आर्किटेक्चर (अधिकांश चीज़ें काम करती हैं, लेकिन कुछ बाइनरी केवल x86 हो सकती हैं)
- क्षमता और साइनअप कभी-कभी अनिश्चित हो सकते हैं

## लागत तुलना (2026)

| प्रदाता      | योजना           | स्पेसिफिकेशन            | मूल्य/माह            | टिप्पणियाँ               |
| ------------ | --------------- | ----------------------- | -------------------- | ------------------------ |
| Oracle Cloud | Always Free ARM | अधिकतम 4 OCPU, 24GB RAM | $0                   | ARM, सीमित क्षमता        |
| Hetzner      | CX22            | 2 vCPU, 4GB RAM         | ~ $4 | सबसे सस्ता पेड विकल्प    |
| DigitalOcean | Basic           | 1 vCPU, 1GB RAM         | $6                   | आसान UI, अच्छे दस्तावेज़ |
| Vultr        | Cloud Compute   | 1 vCPU, 1GB RAM         | $6                   | कई लोकेशन                |
| Linode       | Nanode          | 1 vCPU, 1GB RAM         | $5                   | अब Akamai का हिस्सा      |

---

## पूर्वापेक्षाएँ

- Oracle Cloud खाता ([signup](https://www.oracle.com/cloud/free/)) — यदि समस्या आए तो [community signup guide](https://gist.github.com/rssnyder/51e3cfedd730e7dd5f4a816143b25dbd) देखें
- Tailscale खाता (निःशुल्क: [tailscale.com](https://tailscale.com))
- ~30 मिनट

## 1. OCI इंस्टेंस बनाएँ

1. [Oracle Cloud Console](https://cloud.oracle.com/) में लॉग इन करें
2. **Compute → Instances → Create Instance** पर जाएँ
3. विन्यास करें:
   - **Name:** `openclaw`
   - **Image:** Ubuntu 24.04 (aarch64)
   - **Shape:** `VM.Standard.A1.Flex` (Ampere ARM)
   - **OCPUs:** 2 (या अधिकतम 4)
   - **Memory:** 12 GB (या अधिकतम 24 GB)
   - **Boot volume:** 50 GB (200 GB तक निःशुल्क)
   - **SSH key:** अपनी पब्लिक कुंजी जोड़ें
4. **Create** पर क्लिक करें
5. पब्लिक IP पता नोट करें

**Tip:** If instance creation fails with "Out of capacity", try a different availability domain or retry later. Free tier capacity is limited.

## 2. कनेक्ट करें और अपडेट करें

```bash
# Connect via public IP
ssh ubuntu@YOUR_PUBLIC_IP

# Update system
sudo apt update && sudo apt upgrade -y
sudo apt install -y build-essential
```

**टिप्पणी:** ARM पर कुछ निर्भरताओं के संकलन के लिए `build-essential` आवश्यक है।

## 3. उपयोगकर्ता और होस्टनेम विन्यस्त करें

```bash
# Set hostname
sudo hostnamectl set-hostname openclaw

# Set password for ubuntu user
sudo passwd ubuntu

# Enable lingering (keeps user services running after logout)
sudo loginctl enable-linger ubuntu
```

## 4. Tailscale इंस्टॉल करें

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up --ssh --hostname=openclaw
```

यह Tailscale SSH सक्षम करता है, ताकि आप अपने tailnet पर किसी भी डिवाइस से `ssh openclaw` के माध्यम से कनेक्ट कर सकें — पब्लिक IP की आवश्यकता नहीं।

सत्यापित करें:

```bash
tailscale status
```

**अब से, Tailscale के माध्यम से कनेक्ट करें:** `ssh ubuntu@openclaw` (या Tailscale IP का उपयोग करें)।

## 5. OpenClaw इंस्टॉल करें

```bash
curl -fsSL https://openclaw.ai/install.sh | bash
source ~/.bashrc
```

जब पूछा जाए “How do you want to hatch your bot?”, तो **“Do this later”** चुनें।

> टिप्पणी: यदि ARM-नेटिव बिल्ड समस्याएँ आएँ, तो Homebrew पर जाने से पहले सिस्टम पैकेजों (जैसे `sudo apt install -y build-essential`) से शुरुआत करें।

## 6. Gateway विन्यस्त करें (loopback + टोकन प्रमाणीकरण) और Tailscale Serve सक्षम करें

डिफ़ॉल्ट के रूप में टोकन ऑथ का उपयोग करें। यह पूर्वानुमेय है और किसी भी “insecure auth” कंट्रोल UI फ़्लैग की आवश्यकता से बचाता है।

```bash
# Keep the Gateway private on the VM
openclaw config set gateway.bind loopback

# Require auth for the Gateway + Control UI
openclaw config set gateway.auth.mode token
openclaw doctor --generate-gateway-token

# Expose over Tailscale Serve (HTTPS + tailnet access)
openclaw config set gateway.tailscale.mode serve
openclaw config set gateway.trustedProxies '["127.0.0.1"]'

systemctl --user restart openclaw-gateway
```

## 7. सत्यापित करें

```bash
# Check version
openclaw --version

# Check daemon status
systemctl --user status openclaw-gateway

# Check Tailscale Serve
tailscale serve status

# Test local response
curl http://localhost:18789
```

## 8. VCN सुरक्षा कड़ी करें

अब जब सब कुछ काम कर रहा है, तो Tailscale को छोड़कर सभी ट्रैफ़िक को ब्लॉक करने के लिए VCN को लॉक डाउन करें। OCI का Virtual Cloud Network नेटवर्क एज पर फ़ायरवॉल की तरह काम करता है — ट्रैफ़िक आपके इंस्टेंस तक पहुँचने से पहले ही ब्लॉक हो जाता है।

1. OCI Console में **Networking → Virtual Cloud Networks** पर जाएँ
2. अपना VCN क्लिक करें → **Security Lists** → Default Security List
3. सभी इनग्रेस नियम **हटा दें**, सिवाय:
   - `0.0.0.0/0 UDP 41641` (Tailscale)
4. डिफ़ॉल्ट ईग्रेस नियम बनाए रखें (सभी आउटबाउंड की अनुमति)

यह नेटवर्क एज पर पोर्ट 22 पर SSH, HTTP, HTTPS और बाकी सब कुछ ब्लॉक कर देता है। अब से, आप केवल Tailscale के माध्यम से ही कनेक्ट कर सकते हैं।

---

## Control UI तक पहुँचें

अपने Tailscale नेटवर्क पर किसी भी डिवाइस से:

```
https://openclaw.<tailnet-name>.ts.net/
```

`<tailnet-name>` को अपने tailnet नाम से बदलें (जो `tailscale status` में दिखाई देता है)।

SSH टनल की आवश्यकता नहीं है। Tailscale प्रदान करता है:

- HTTPS एन्क्रिप्शन (स्वचालित प्रमाणपत्र)
- Tailscale पहचान के माध्यम से प्रमाणीकरण
- आपके tailnet पर किसी भी डिवाइस से पहुँच (लैपटॉप, फ़ोन, आदि)

---

## सुरक्षा: VCN + Tailscale (अनुशंसित आधार)

VCN लॉक डाउन (केवल UDP 41641 खुला) और Gateway को loopback से बाइंड करने के साथ, आपको मज़बूत defense-in-depth मिलता है: सार्वजनिक ट्रैफ़िक नेटवर्क एज पर ब्लॉक हो जाता है, और प्रशासनिक पहुँच आपके tailnet के माध्यम से होती है।

यह सेटअप अक्सर इंटरनेट-व्यापी SSH brute force को रोकने के लिए अतिरिक्त होस्ट-आधारित फ़ायरवॉल नियमों की _आवश्यकता_ को समाप्त कर देता है — लेकिन फिर भी आपको OS को अपडेट रखना चाहिए, `openclaw security audit` चलाना चाहिए, और यह सत्यापित करना चाहिए कि आप गलती से पब्लिक इंटरफ़ेस पर लिसन नहीं कर रहे हैं।

### पहले से संरक्षित क्या है

| पारंपरिक कदम     | आवश्यक?       | क्यों                                                                       |
| ---------------- | ------------- | --------------------------------------------------------------------------- |
| UFW फ़ायरवॉल     | नहीं          | VCN ट्रैफ़िक को इंस्टेंस तक पहुँचने से पहले ब्लॉक करता है                   |
| fail2ban         | नहीं          | यदि पोर्ट 22 VCN पर ब्लॉक है तो brute force नहीं                            |
| sshd हार्डनिंग   | नहीं          | Tailscale SSH, sshd का उपयोग नहीं करता                                      |
| root लॉगिन अक्षम | नहीं          | Tailscale सिस्टम उपयोगकर्ताओं की बजाय Tailscale पहचान का उपयोग करता है      |
| केवल SSH कुंजी   | नहीं          | Tailscale आपके tailnet के माध्यम से प्रमाणीकरण करता है                      |
| IPv6 हार्डनिंग   | आमतौर पर नहीं | आपके VCN/सबनेट सेटिंग्स पर निर्भर; वास्तव में क्या असाइन/एक्सपोज़ है जाँचें |

### अभी भी अनुशंसित

- **क्रेडेंशियल अनुमतियाँ:** `chmod 700 ~/.openclaw`
- **सुरक्षा ऑडिट:** `openclaw security audit`
- **सिस्टम अपडेट:** `sudo apt update && sudo apt upgrade` नियमित रूप से
- **Tailscale मॉनिटर करें:** [Tailscale admin console](https://login.tailscale.com/admin) में डिवाइस की समीक्षा करें

### सुरक्षा स्थिति सत्यापित करें

```bash
# Confirm no public ports listening
sudo ss -tlnp | grep -v '127.0.0.1\|::1'

# Verify Tailscale SSH is active
tailscale status | grep -q 'offers: ssh' && echo "Tailscale SSH active"

# Optional: disable sshd entirely
sudo systemctl disable --now ssh
```

---

## वैकल्पिक: SSH टनल

यदि Tailscale Serve काम नहीं कर रहा है, तो SSH टनल का उपयोग करें:

```bash
# From your local machine (via Tailscale)
ssh -L 18789:127.0.0.1:18789 ubuntu@openclaw
```

फिर `http://localhost:18789` खोलें।

---

## समस्या-निवारण

### इंस्टेंस निर्माण विफल (“Out of capacity”)

फ्री टियर ARM इंस्टेंस लोकप्रिय हैं। आजमाएँ:

- अलग availability domain
- ऑफ-पीक समय में पुनः प्रयास (सुबह जल्दी)
- shape चुनते समय “Always Free” फ़िल्टर का उपयोग करें

### Tailscale कनेक्ट नहीं हो रहा

```bash
# Check status
sudo tailscale status

# Re-authenticate
sudo tailscale up --ssh --hostname=openclaw --reset
```

### Gateway शुरू नहीं हो रहा

```bash
openclaw gateway status
openclaw doctor --non-interactive
journalctl --user -u openclaw-gateway -n 50
```

### Control UI तक नहीं पहुँच पा रहे

```bash
# Verify Tailscale Serve is running
tailscale serve status

# Check gateway is listening
curl http://localhost:18789

# Restart if needed
systemctl --user restart openclaw-gateway
```

### ARM बाइनरी समस्याएँ

कुछ टूल्स के पास ARM बिल्ड नहीं हो सकते हैं। जाँच करें:

```bash
uname -m  # Should show aarch64
```

अधिकांश npm पैकेज ठीक काम करते हैं। बाइनरीज़ के लिए, `linux-arm64` या `aarch64` रिलीज़ देखें।

---

## स्थायित्व

सभी स्टेट यहाँ रहती है:

- `~/.openclaw/` — विन्यास, क्रेडेंशियल्स, सत्र डेटा
- `~/.openclaw/workspace/` — वर्कस्पेस (SOUL.md, मेमोरी, आर्टिफ़ैक्ट्स)

समय-समय पर बैकअप लें:

```bash
tar -czvf openclaw-backup.tar.gz ~/.openclaw ~/.openclaw/workspace
```

---

## यह भी देखें

- [Gateway remote access](/gateway/remote) — अन्य रिमोट एक्सेस पैटर्न
- [Tailscale integration](/gateway/tailscale) — पूर्ण Tailscale दस्तावेज़
- [Gateway configuration](/gateway/configuration) — सभी विन्यास विकल्प
- [DigitalOcean guide](/platforms/digitalocean) — यदि आप पेड + आसान साइनअप चाहते हैं
- [Hetzner guide](/install/hetzner) — Docker-आधारित विकल्प
