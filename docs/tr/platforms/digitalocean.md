---
summary: "DigitalOcean üzerinde OpenClaw (basit ücretli VPS seçeneği)"
read_when:
  - DigitalOcean üzerinde OpenClaw kurarken
  - OpenClaw için ucuz VPS barındırma ararken
title: "DigitalOcean"
---

# DigitalOcean üzerinde OpenClaw

## Amaç

DigitalOcean üzerinde **aylık $6** (ya da rezervasyonlu fiyatlandırma ile $4/ay) karşılığında kalıcı bir OpenClaw Gateway çalıştırmak.

Aylık $0 seçeneği istiyor ve ARM + sağlayıcıya özgü kurulumla uğraşmayı sorun etmiyorsanız, [Oracle Cloud kılavuzuna](/platforms/oracle) bakın.

## Maliyet Karşılaştırması (2026)

| Sağlayıcı    | Plan            | Özellikler                | Price/mo                                                       | Notlar                                     |
| ------------ | --------------- | ------------------------- | -------------------------------------------------------------- | ------------------------------------------ |
| Oracle Cloud | Always Free ARM | 4 OCPU’ya kadar, 24GB RAM | $0                                                             | ARM, sınırlı kapasite / kayıt tuhaflıkları |
| Hetzner      | CX22            | 2 vCPU, 4GB RAM           | €3.79 (~$4) | En ucuz ücretli seçenek                    |
| DigitalOcean | Basic           | 1 vCPU, 1GB RAM           | $6                                                             | Easy UI, good docs                         |
| Vultr        | Cloud Compute   | 1 vCPU, 1GB RAM           | $6                                                             | Çok sayıda lokasyon                        |
| Linode       | Nanode          | 1 vCPU, 1GB RAM           | $5                                                             | Artık Akamai’nin parçası                   |

**Bir sağlayıcı seçmek:**

- DigitalOcean: en basit UX + öngörülebilir kurulum (bu kılavuz)
- Hetzner: iyi fiyat/performans (bkz. [Hetzner kılavuzu](/install/hetzner))
- Oracle Cloud: aylık $0 olabilir, ancak daha nazlı ve yalnızca ARM (bkz. [Oracle kılavuzu](/platforms/oracle))

---

## Ön koşullar

- DigitalOcean hesabı ([$200 ücretsiz kredi ile kayıt](https://m.do.co/c/signup))
- SSH anahtar çifti (ya da parola ile kimlik doğrulamayı kullanma isteği)
- ~20 dakika

## 1. Droplet oluşturma

1. [DigitalOcean](https://cloud.digitalocean.com/) hesabınıza giriş yapın
2. **Create → Droplets**’e tıklayın
3. Şunları seçin:
   - **Region:** Size (ya da kullanıcılarınıza) en yakın
   - **Image:** Ubuntu 24.04 LTS
   - **Size:** Basic → Regular → **$6/ay** (1 vCPU, 1GB RAM, 25GB SSD)
   - **Authentication:** SSH anahtarı (önerilir) veya parola
4. **Create Droplet**’e tıklayın
5. IP adresini not edin

## 2) SSH ile bağlanma

```bash
ssh root@YOUR_DROPLET_IP
```

## 3. OpenClaw kurulumu

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

## 4. Onboarding’i çalıştırma

```bash
openclaw onboard --install-daemon
```

Sihirbaz sizi şu adımlardan geçirecek:

- Model kimlik doğrulaması (API anahtarları veya OAuth)
- Kanal kurulumu (Telegram, WhatsApp, Discord, vb.)
- Gateway belirteci (otomatik oluşturulur)
- Daemon kurulumu (systemd)

## 5. Gateway’i doğrulama

```bash
# Check status
openclaw status

# Check service
systemctl --user status openclaw-gateway.service

# View logs
journalctl --user -u openclaw-gateway.service -f
```

## 6. Gösterge Tablosuna erişim

Gateway varsayılan olarak loopback’e bağlanır. Control UI’ya erişmek için:

**Seçenek A: SSH tüneli (önerilir)**

```bash
# From your local machine
ssh -L 18789:localhost:18789 root@YOUR_DROPLET_IP

# Then open: http://localhost:18789
```

**Seçenek B: Tailscale Serve (HTTPS, yalnızca loopback)**

```bash
# On the droplet
curl -fsSL https://tailscale.com/install.sh | sh
tailscale up

# Configure Gateway to use Tailscale Serve
openclaw config set gateway.tailscale.mode serve
openclaw gateway restart
```

Açın: `https://<magicdns>/`

Notlar:

- Serve, Gateway’i loopback-only tutar ve Tailscale kimlik başlıklarıyla kimlik doğrular.
- Bunun yerine belirteç/parola zorunlu kılmak için `gateway.auth.allowTailscale: false` ayarlayın veya `gateway.auth.mode: "password"` kullanın.

**Seçenek C: Tailnet bind (Serve yok)**

```bash
openclaw config set gateway.bind tailnet
openclaw gateway restart
```

Açın: `http://<tailscale-ip>:18789` (belirteç gereklidir).

## 7. Kanallarınızı bağlayın

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

Diğer sağlayıcılar için [Channels](/channels) sayfasına bakın.

---

## 1GB RAM için optimizasyonlar

$6’lık droplet yalnızca 1GB RAM’e sahiptir. Sorunsuz çalışması için:

### Swap ekleyin (önerilir)

```bash
fallocate -l 2G /swapfile
chmod 600 /swapfile
mkswap /swapfile
swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab
```

### Daha hafif bir model kullanın

OOM hataları yaşıyorsanız şunları düşünün:

- Yerel modeller yerine API tabanlı modelleri (Claude, GPT) kullanmak
- `agents.defaults.model.primary`’u daha küçük bir modele ayarlamak

### Monitor memory

```bash
free -h
htop
```

---

## Persistence

Tüm durum şu dizinlerde bulunur:

- `~/.openclaw/` — yapılandırma, kimlik bilgileri, oturum verileri
- `~/.openclaw/workspace/` — çalışma alanı (SOUL.md, bellek, vb.)

Bunlar yeniden başlatmalardan etkilenmez. Düzenli olarak yedekleyin:

```bash
tar -czvf openclaw-backup.tar.gz ~/.openclaw ~/.openclaw/workspace
```

---

## Oracle Cloud Ücretsiz Alternatif

Oracle Cloud, burada yer alan tüm ücretli seçeneklerden belirgin şekilde daha güçlü **Always Free** ARM örnekleri sunar — aylık $0.

| Ne elde edersiniz    | Özellikler             |
| -------------------- | ---------------------- |
| **4 OCPU**           | ARM Ampere A1          |
| **24GB RAM**         | Fazlasıyla yeterli     |
| **200GB depolama**   | Blok birim             |
| **Süresiz ücretsiz** | Kredi kartı ücreti yok |

**Uyarılar:**

- Kayıt süreci sorunlu olabilir (başarısız olursa tekrar deneyin)
- ARM mimarisi — çoğu şey çalışır, ancak bazı ikili dosyalar ARM derlemeleri gerektirir

Tam kurulum kılavuzu için [Oracle Cloud](/platforms/oracle) sayfasına bakın. Kayıt ipuçları ve kayıt sürecindeki sorunları gidermek için bu [topluluk kılavuzuna](https://gist.github.com/rssnyder/51e3cfedd730e7dd5f4a816143b25dbd) bakın.

---

## Sorun Giderme

### Gateway başlamıyor

```bash
openclaw gateway status
openclaw doctor --non-interactive
journalctl -u openclaw --no-pager -n 50
```

### Port zaten kullanımda

```bash
lsof -i :18789
kill <PID>
```

### Bellek yetersiz

```bash
# Check memory
free -h

# Add more swap
# Or upgrade to $12/mo droplet (2GB RAM)
```

---

## Ayrıca Bakınız

- [Hetzner kılavuzu](/install/hetzner) — daha ucuz, daha güçlü
- [Docker kurulumu](/install/docker) — konteynerli kurulum
- [Tailscale](/gateway/tailscale) — güvenli uzaktan erişim
- [Yapılandırma](/gateway/configuration) — tam yapılandırma referansı
