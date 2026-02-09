---
summary: "Windows (WSL2) समर्थन + सहचर ऐप की स्थिति"
read_when:
  - Windows पर OpenClaw इंस्टॉल करते समय
  - Windows सहचर ऐप की स्थिति खोजते समय
title: "Windows (WSL2)"
---

# Windows (WSL2)

Windows पर OpenClaw की सिफ़ारिश **WSL2 के माध्यम से** की जाती है (Ubuntu अनुशंसित)। CLI + Gateway Linux के अंदर चलते हैं, जो रनटाइम को सुसंगत रखता है और टूलिंग को कहीं अधिक संगत बनाता है (Node/Bun/pnpm, Linux बाइनरीज़, स्किल्स)। नेटिव Windows अधिक चुनौतीपूर्ण हो सकता है। WSL2 आपको पूरा Linux अनुभव देता है — इंस्टॉल करने के लिए एक कमांड: `wsl --install`।

नेटिव Windows सहचर ऐप्स की योजना बनाई गई है।

## इंस्टॉल (WSL2)

- [आरंभ करें](/start/getting-started) (WSL के भीतर उपयोग करें)
- [इंस्टॉल और अपडेट्स](/install/updating)
- आधिकारिक WSL2 गाइड (Microsoft): [https://learn.microsoft.com/windows/wsl/install](https://learn.microsoft.com/windows/wsl/install)

## Gateway

- [Gateway रनबुक](/gateway)
- [विन्यास](/gateway/configuration)

## Gateway सेवा इंस्टॉल (CLI)

WSL2 के भीतर:

```
openclaw onboard --install-daemon
```

या:

```
openclaw gateway install
```

या:

```
openclaw configure
```

प्रॉम्प्ट आने पर **Gateway सेवा** चुनें।

मरम्मत/माइग्रेट:

```
openclaw doctor
```

## उन्नत: LAN पर WSL सेवाओं को एक्सपोज़ करें (portproxy)

WSL का अपना अलग वर्चुअल नेटवर्क होता है। यदि किसी अन्य मशीन को **WSL के अंदर** चल रही किसी सेवा (SSH, लोकल TTS सर्वर, या Gateway) तक पहुँचना है, तो आपको Windows पोर्ट को वर्तमान WSL IP पर फ़ॉरवर्ड करना होगा। रीस्टार्ट के बाद WSL IP बदल जाता है, इसलिए आपको फ़ॉरवर्डिंग नियम को रिफ़्रेश करना पड़ सकता है।

उदाहरण (PowerShell **एडमिनिस्ट्रेटर के रूप में**):

```powershell
$Distro = "Ubuntu-24.04"
$ListenPort = 2222
$TargetPort = 22

$WslIp = (wsl -d $Distro -- hostname -I).Trim().Split(" ")[0]
if (-not $WslIp) { throw "WSL IP not found." }

netsh interface portproxy add v4tov4 listenaddress=0.0.0.0 listenport=$ListenPort `
  connectaddress=$WslIp connectport=$TargetPort
```

Windows Firewall के माध्यम से पोर्ट को अनुमति दें (एक बार):

```powershell
New-NetFirewallRule -DisplayName "WSL SSH $ListenPort" -Direction Inbound `
  -Protocol TCP -LocalPort $ListenPort -Action Allow
```

WSL रीस्टार्ट के बाद portproxy को रिफ़्रेश करें:

```powershell
netsh interface portproxy delete v4tov4 listenport=$ListenPort listenaddress=0.0.0.0 | Out-Null
netsh interface portproxy add v4tov4 listenport=$ListenPort listenaddress=0.0.0.0 `
  connectaddress=$WslIp connectport=$TargetPort | Out-Null
```

टिप्पणियाँ:

- किसी अन्य मशीन से SSH करते समय लक्ष्य **Windows होस्ट IP** होता है (उदाहरण: `ssh user@windows-host -p 2222`)।
- रिमोट नोड्स को **पहुँच योग्य** Gateway URL की ओर इंगित करना चाहिए ( `127.0.0.1` नहीं ); पुष्टि के लिए
  `openclaw status --all` का उपयोग करें।
- LAN एक्सेस के लिए `listenaddress=0.0.0.0` का उपयोग करें; `127.0.0.1` इसे केवल लोकल रखता है।
- यदि आप इसे स्वचालित चाहते हैं, तो लॉगिन पर रिफ़्रेश
  चरण चलाने के लिए एक Scheduled Task रजिस्टर करें।

## चरण-दर-चरण WSL2 इंस्टॉल

### 1. WSL2 + Ubuntu इंस्टॉल करें

PowerShell (Admin) खोलें:

```powershell
wsl --install
# Or pick a distro explicitly:
wsl --list --online
wsl --install -d Ubuntu-24.04
```

यदि Windows पूछे तो रीबूट करें।

### 2. systemd सक्षम करें (gateway इंस्टॉल के लिए आवश्यक)

अपने WSL टर्मिनल में:

```bash
sudo tee /etc/wsl.conf >/dev/null <<'EOF'
[boot]
systemd=true
EOF
```

फिर PowerShell से:

```powershell
wsl --shutdown
```

Ubuntu को पुनः खोलें, फिर सत्यापित करें:

```bash
systemctl --user status
```

### 3. OpenClaw इंस्टॉल करें (WSL के भीतर)

WSL के भीतर Linux के लिए आरंभ करें फ़्लो का पालन करें:

```bash
git clone https://github.com/openclaw/openclaw.git
cd openclaw
pnpm install
pnpm ui:build # auto-installs UI deps on first run
pnpm build
openclaw onboard
```

पूर्ण गाइड: [आरंभ करें](/start/getting-started)

## Windows सहचर ऐप

हमारे पास अभी Windows कंपेनियन ऐप नहीं है। यदि आप इसे संभव बनाने के लिए योगदान देना चाहते हैं, तो योगदान का स्वागत है।
