---
summary: "Ansible, Tailscale VPN ve güvenlik duvarı yalıtımı ile otomatikleştirilmiş, güçlendirilmiş OpenClaw kurulumu"
read_when:
  - Güvenlik güçlendirmesiyle otomatik sunucu dağıtımı istiyorsanız
  - VPN erişimi olan, güvenlik duvarıyla yalıtılmış bir kurulum gerekiyorsa
  - Uzak Debian/Ubuntu sunucularına dağıtım yapıyorsanız
title: "Ansible"
---

# Ansible Kurulumu

OpenClaw’ı üretim sunucularına dağıtmanın önerilen yolu, **[openclaw-ansible](https://github.com/openclaw/openclaw-ansible)** aracılığıyladır — güvenlik öncelikli mimariye sahip, otomatik bir kurulum aracıdır.

## Hızlı Başlangıç

Tek komutla kurulum:

```bash
curl -fsSL https://raw.githubusercontent.com/openclaw/openclaw-ansible/main/install.sh | bash
```

> **📦 Tam kılavuz: [github.com/openclaw/openclaw-ansible](https://github.com/openclaw/openclaw-ansible)**
>
> openclaw-ansible deposu, Ansible dağıtımı için tek doğruluk kaynağıdır. Bu sayfa hızlı bir genel bakış sunar.

## Neler Kazanırsınız

- 🔒 **Güvenlik duvarı öncelikli güvenlik**: UFW + Docker yalıtımı (yalnızca SSH + Tailscale erişilebilir)
- 🔐 **Tailscale VPN**: Hizmetleri herkese açık hale getirmeden güvenli uzaktan erişim
- 🐳 **Docker**: Yalıtılmış sandbox konteynerleri, yalnızca localhost bağlamaları
- 🛡️ **Derinlemesine savunma**: 4 katmanlı güvenlik mimarisi
- 🚀 **Tek komutlu kurulum**: Dakikalar içinde eksiksiz dağıtım
- 🔧 **Systemd entegrasyonu**: Güçlendirme ile önyüklemede otomatik başlatma

## Gereksinimler

- **İşletim Sistemi**: Debian 11+ veya Ubuntu 20.04+
- **Erişim**: Root veya sudo yetkileri
- **Ağ**: Paket kurulumu için internet bağlantısı
- **Ansible**: 2.14+ (hızlı başlangıç betiği tarafından otomatik kurulur)

## Kurulum sonrası betik sizi şu konularda yönlendirecek:

Ansible playbook’u şunları kurar ve yapılandırır:

1. **Tailscale** (güvenli uzaktan erişim için mesh VPN)
2. **UFW güvenlik duvarı** (yalnızca SSH + Tailscale portları)
3. **Docker CE + Compose V2** (ajan sandbox’ları için)
4. **Node.js 22.x + pnpm** (çalışma zamanı bağımlılıkları)
5. **OpenClaw** (host tabanlı, konteyner içinde değil)
6. **Systemd servisi** (güvenlik güçlendirmesiyle otomatik başlatma)

Not: Gateway **doğrudan ana makine üzerinde** (Docker içinde değil) çalışır; ancak ajan sandbox’ları yalıtım için Docker kullanır. Ayrıntılar için [Sandboxing](/gateway/sandboxing) bölümüne bakın.

## Kurulum Sonrası Ayarlar

Kurulum tamamlandıktan sonra openclaw kullanıcısına geçin:

```bash
sudo -i -u openclaw
```

Bun yaşam döngüsü betikleri (varsayılan olarak engellenmiştir)

1. **Onboarding sihirbazı**: OpenClaw ayarlarını yapılandırma
2. **Sağlayıcı girişi**: WhatsApp/Telegram/Discord/Signal bağlama
3. **Gateway testi**: Kurulumu doğrulama
4. **Tailscale kurulumu**: VPN mesh’inize bağlanma

### Hızlı komutlar

```bash
# Check service status
sudo systemctl status openclaw

# View live logs
sudo journalctl -u openclaw -f

# Restart gateway
sudo systemctl restart openclaw

# Provider login (run as openclaw user)
sudo -i -u openclaw
openclaw channels login
```

## Güvenlik Mimarisi

### 4 Katmanlı Savunma

1. **Güvenlik Duvarı (UFW)**: Yalnızca SSH (22) + Tailscale (41641/udp) herkese açık
2. **VPN (Tailscale)**: Gateway yalnızca VPN mesh üzerinden erişilebilir
3. **Docker Yalıtımı**: DOCKER-USER iptables zinciri dış portların açılmasını engeller
4. **Systemd Güçlendirmesi**: NoNewPrivileges, PrivateTmp, ayrıcalıksız kullanıcı

### Doğrulama

Harici saldırı yüzeyini test edin:

```bash
nmap -p- YOUR_SERVER_IP
```

**Yalnızca 22 numaralı portun** (SSH) açık olduğunu göstermelidir. Diğer tüm hizmetler (gateway, Docker) kilitlidir.

### Docker Kullanılabilirliği

Docker, gateway’in kendisini çalıştırmak için değil, **ajan sandbox’ları** (yalıtılmış araç çalıştırma) için kurulur. Gateway yalnızca localhost’a bağlanır ve Tailscale VPN üzerinden erişilebilir.

Sandbox yapılandırması için [Multi-Agent Sandbox & Tools](/tools/multi-agent-sandbox-tools) bölümüne bakın.

## Manuel Kurulum

Otomasyon üzerinde manuel denetim tercih ediyorsanız:

```bash
# 1. Install prerequisites
sudo apt update && sudo apt install -y ansible git

# 2. Clone repository
git clone https://github.com/openclaw/openclaw-ansible.git
cd openclaw-ansible

# 3. Install Ansible collections
ansible-galaxy collection install -r requirements.yml

# 4. Run playbook
./run-playbook.sh

# Or run directly (then manually execute /tmp/openclaw-setup.sh after)
# ansible-playbook playbook.yml --ask-become-pass
```

## OpenClaw Güncelleme

Ansible yükleyicisi, OpenClaw’ı manuel güncellemeler için ayarlar. Standart güncelleme akışı için [Updating](/install/updating) bölümüne bakın.

Ansible playbook’unu yeniden çalıştırmak için (ör. yapılandırma değişiklikleri):

```bash
cd openclaw-ansible
./run-playbook.sh
```

Not: Bu işlem idempotenttir ve birden fazla kez güvenle çalıştırılabilir.

## Sorun Giderme

### Güvenlik duvarı bağlantımı engelliyor

Erişiminiz kilitlendiyse:

- Önce Tailscale VPN üzerinden erişebildiğinizden emin olun
- SSH erişimine (22 numaralı port) her zaman izin verilir
- Gateway tasarım gereği **yalnızca** Tailscale üzerinden erişilebilirdir

### Servis başlamıyor

```bash
# Check logs
sudo journalctl -u openclaw -n 100

# Verify permissions
sudo ls -la /opt/openclaw

# Test manual start
sudo -i -u openclaw
cd ~/openclaw
pnpm start
```

### Docker sandbox sorunları

```bash
# Verify Docker is running
sudo systemctl status docker

# Check sandbox image
sudo docker images | grep openclaw-sandbox

# Build sandbox image if missing
cd /opt/openclaw/openclaw
sudo -u openclaw ./scripts/sandbox-setup.sh
```

### Sağlayıcı girişi başarısız

`openclaw` kullanıcısı olarak çalıştığınızdan emin olun:

```bash
sudo -i -u openclaw
openclaw channels login
```

## Gelişmiş Yapılandırma

Ayrıntılı güvenlik mimarisi ve sorun giderme için:

- [Security Architecture](https://github.com/openclaw/openclaw-ansible/blob/main/docs/security.md)
- [Technical Details](https://github.com/openclaw/openclaw-ansible/blob/main/docs/architecture.md)
- [Troubleshooting Guide](https://github.com/openclaw/openclaw-ansible/blob/main/docs/troubleshooting.md)

## İlgili

- [openclaw-ansible](https://github.com/openclaw/openclaw-ansible) — tam dağıtım kılavuzu
- [Docker](/install/docker) — konteynerleştirilmiş gateway kurulumu
- [Sandboxing](/gateway/sandboxing) — ajan sandbox yapılandırması
- [Multi-Agent Sandbox & Tools](/tools/multi-agent-sandbox-tools) — ajan başına yalıtım
