---
summary: "Windows (WSL2) desteği + yardımcı uygulama durumu"
read_when:
  - Windows üzerinde OpenClaw kurarken
  - Windows yardımcı uygulamasının durumunu arıyor
title: "Windows (WSL2)"
---

# Windows (WSL2)

Windows üzerinde OpenClaw, **WSL2 üzerinden** (Ubuntu önerilir) kullanılması tavsiye edilir. CLI + Gateway Linux içinde çalışır; bu da çalışma zamanını tutarlı tutar ve araçların çok daha uyumlu olmasını sağlar (Node/Bun/pnpm, Linux ikilileri, Skills). Yerel Windows daha zorlayıcı olabilir. WSL2 size tam Linux deneyimini sunar — tek komutla kurulum: `wsl --install`.

Yerel Windows yardımcı uygulamaları planlanmaktadır.

## Yükleme (WSL2)

- [Başlarken](/start/getting-started) (WSL içinde kullanın)
- [Yükleme ve güncellemeler](/install/updating)
- Resmî WSL2 kılavuzu (Microsoft): [https://learn.microsoft.com/windows/wsl/install](https://learn.microsoft.com/windows/wsl/install)

## Gateway

- [Gateway runbook](/gateway)
- [Yapılandırma](/gateway/configuration)

## Gateway hizmeti kurulumu (CLI)

WSL2 içinde:

```
openclaw onboard --install-daemon
```

Veya:

```
openclaw gateway install
```

Veya:

```
openclaw configure
```

İstendiğinde **Gateway service** seçin.

Onarma/taşıma:

```
openclaw doctor
```

## Gelişmiş: WSL hizmetlerini LAN üzerinden açma (portproxy)

WSL’nin kendi sanal ağı vardır. Başka bir makinenin **WSL içinde** çalışan bir hizmete
(SSH, yerel bir TTS sunucusu veya Gateway) erişmesi gerekiyorsa, bir Windows portunu
geçerli WSL IP’sine yönlendirmeniz gerekir. WSL IP’si yeniden başlatmalardan sonra
değişir; bu nedenle yönlendirme kuralını yenilemeniz gerekebilir.

Örnek (PowerShell **Yönetici olarak**):

```powershell
$Distro = "Ubuntu-24.04"
$ListenPort = 2222
$TargetPort = 22

$WslIp = (wsl -d $Distro -- hostname -I).Trim().Split(" ")[0]
if (-not $WslIp) { throw "WSL IP not found." }

netsh interface portproxy add v4tov4 listenaddress=0.0.0.0 listenport=$ListenPort `
  connectaddress=$WslIp connectport=$TargetPort
```

Windows Güvenlik Duvarı’ndan porta izin verin (tek seferlik):

```powershell
New-NetFirewallRule -DisplayName "WSL SSH $ListenPort" -Direction Inbound `
  -Protocol TCP -LocalPort $ListenPort -Action Allow
```

WSL yeniden başlatmalarından sonra portproxy’yi yenileyin:

```powershell
netsh interface portproxy delete v4tov4 listenport=$ListenPort listenaddress=0.0.0.0 | Out-Null
netsh interface portproxy add v4tov4 listenport=$ListenPort listenaddress=0.0.0.0 `
  connectaddress=$WslIp connectport=$TargetPort | Out-Null
```

Notlar:

- Başka bir makineden SSH, **Windows ana makinesi IP’sini** hedefler (örnek: `ssh user@windows-host -p 2222`).
- Uzak düğümler **erişilebilir** bir Gateway URL’sine işaret etmelidir (`127.0.0.1` değil); doğrulamak için
  `openclaw status --all` kullanın.
- LAN erişimi için `listenaddress=0.0.0.0` kullanın; `127.0.0.1` yalnızca yerel tutar.
- Bunun otomatik olmasını istiyorsanız, oturum açılışında yenileme adımını
  çalıştıracak bir Zamanlanmış Görev kaydedin.

## Adım adım WSL2 kurulumu

### 1. WSL2 + Ubuntu’yu kurun

PowerShell’i açın (Yönetici):

```powershell
wsl --install
# Or pick a distro explicitly:
wsl --list --online
wsl --install -d Ubuntu-24.04
```

Windows isterse yeniden başlatın.

### 2. systemd’yi etkinleştirin (gateway kurulumu için gereklidir)

WSL terminalinizde:

```bash
sudo tee /etc/wsl.conf >/dev/null <<'EOF'
[boot]
systemd=true
EOF
```

Ardından PowerShell’den:

```powershell
wsl --shutdown
```

Ubuntu’yu yeniden açın, ardından doğrulayın:

```bash
systemctl --user status
```

### 3. OpenClaw’ı kurun (WSL içinde)

WSL içinde Linux Başlarken akışını izleyin:

```bash
git clone https://github.com/openclaw/openclaw.git
cd openclaw
pnpm install
pnpm ui:build # auto-installs UI deps on first run
pnpm build
openclaw onboard
```

Tam kılavuz: [Başlarken](/start/getting-started)

## Windows yardımcı uygulaması

Henüz bir Windows yardımcı uygulamamız yok. Bunu hayata geçirmek için katkıda bulunmak
isterseniz katkılar memnuniyetle karşılanır.
