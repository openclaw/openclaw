---
summary: "Raspberry Pi üzerinde OpenClaw (bütçe dostu, kendi kendine barındırılan kurulum)"
read_when:
  - Raspberry Pi üzerinde OpenClaw kurulumu
  - ARM cihazlarda OpenClaw çalıştırma
  - Ucuz, her zaman açık kişisel bir yapay zekâ oluşturma
title: "Raspberry Pi"
---

# Raspberry Pi üzerinde OpenClaw

## Amaç

Raspberry Pi üzerinde **~$35-80** tek seferlik maliyetle (aylık ücret yok) kalıcı, her zaman açık bir OpenClaw Gateway çalıştırmak.

Şunlar için idealdir:

- 7/24 kişisel yapay zeka asistanı
- Ev otomasyon merkezi
- Düşük güç tüketimli, her zaman erişilebilir Telegram/WhatsApp botu

## Donanım Gereksinimleri

| Pi Modeli       | RAM     | Çalışır mı? | Notlar                                |
| --------------- | ------- | ----------- | ------------------------------------- |
| **Pi 5**        | 4GB/8GB | ✅ En iyi    | En hızlı, önerilen                    |
| **Pi 4**        | 4GB     | ✅ İyi       | Çoğu kullanıcı için ideal             |
| **Pi 4**        | 2GB     | ✅ Uygun     | Çalışır, swap ekleyin                 |
| **Pi 4**        | 1GB     | ⚠️ Sıkı     | Swap ile mümkün, minimal yapılandırma |
| **Pi 3B+**      | 1GB     | ⚠️ Yavaş    | Çalışır ancak hantaldır               |
| **Pi Zero 2 W** | 512MB   | ❌           | Önerilmez                             |

**Minimum özellikler:** 1GB RAM, 1 çekirdek, 500MB disk  
**Önerilen:** 2GB+ RAM, 64-bit işletim sistemi, 16GB+ SD kart (veya USB SSD)

## İhtiyacınız Olanlar

- Raspberry Pi 4 veya 5 (2GB+ önerilir)
- MicroSD kart (16GB+) veya USB SSD (daha iyi performans)
- Güç adaptörü (resmi Pi PSU önerilir)
- Ağ bağlantısı (Ethernet veya WiFi)
- ~30 dakika

## 1. İşletim Sistemini Yazdırın

Başsız bir sunucu için masaüstüne gerek yok — **Raspberry Pi OS Lite (64-bit)** kullanın.

1. [Raspberry Pi Imager](https://www.raspberrypi.com/software/) indirin
2. OS seçin: **Raspberry Pi OS Lite (64-bit)**
3. Ön yapılandırma için dişli simgesine (⚙️) tıklayın:
   - Ana makine adını ayarlayın: `gateway-host`
   - SSH’yi etkinleştirin
   - Kullanıcı adı/parola belirleyin
   - WiFi’yi yapılandırın (Ethernet kullanmıyorsanız)
4. SD kartınıza / USB sürücünüze yazdırın
5. Pi’yi takın ve başlatın

## 2) SSH ile Bağlanın

```bash
ssh user@gateway-host
# or use the IP address
ssh user@192.168.x.x
```

## 3. Sistem Kurulumu

```bash
# Update system
sudo apt update && sudo apt upgrade -y

# Install essential packages
sudo apt install -y git curl build-essential

# Set timezone (important for cron/reminders)
sudo timedatectl set-timezone America/Chicago  # Change to your timezone
```

## 4. Node.js 22 Kurulumu (ARM64)

```bash
# Install Node.js via NodeSource
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs

# Verify
node --version  # Should show v22.x.x
npm --version
```

## 5. Swap Ekleyin (2GB veya daha az için önemli)

Swap, bellek yetersizliği (OOM) çökmelerini önler:

```bash
# Create 2GB swap file
sudo fallocate -l 2G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile

# Make permanent
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab

# Optimize for low RAM (reduce swappiness)
echo 'vm.swappiness=10' | sudo tee -a /etc/sysctl.conf
sudo sysctl -p
```

## 6. OpenClaw Kurulumu

### Seçenek A: Standart Kurulum (Önerilir)

```bash
curl -fsSL https://openclaw.ai/install.sh | bash
```

### Seçenek B: Hacklenebilir Kurulum (Kurcalamak için)

```bash
git clone https://github.com/openclaw/openclaw.git
cd openclaw
npm install
npm run build
npm link
```

Hacklenebilir kurulum, loglara ve koda doğrudan erişim sağlar — ARM’e özgü sorunları ayıklamak için kullanışlıdır.

## 7. Onboarding’i Çalıştırın

```bash
openclaw onboard --install-daemon
```

Sihirbazı takip edin:

1. **Gateway modu:** Yerel
2. **Kimlik doğrulama:** API anahtarları önerilir (başsız Pi’de OAuth nazlı olabilir)
3. **Kanallar:** Başlamak için Telegram en kolayıdır
4. **Daemon:** Evet (systemd)

## 8) Kurulumu Doğrulayın

```bash
# Check status
openclaw status

# Check service
sudo systemctl status openclaw

# View logs
journalctl -u openclaw -f
```

## 9. Panoya Erişim

Pi başsız olduğu için bir SSH tüneli kullanın:

```bash
# From your laptop/desktop
ssh -L 18789:localhost:18789 user@gateway-host

# Then open in browser
open http://localhost:18789
```

Ya da her zaman açık erişim için Tailscale kullanın:

```bash
# On the Pi
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up

# Update config
openclaw config set gateway.bind tailnet
sudo systemctl restart openclaw
```

---

## Performans İyileştirmeleri

### USB SSD Kullanın (Büyük İyileşme)

SD kartlar yavaştır ve çabuk yıpranır. USB SSD performansı ciddi ölçüde artırır:

```bash
# Check if booting from USB
lsblk
```

Kurulum için [Pi USB önyükleme kılavuzu](https://www.raspberrypi.com/documentation/computers/raspberry-pi.html#usb-mass-storage-boot)’na bakın.

### Bellek Kullanımını Azaltın

```bash
# Disable GPU memory allocation (headless)
echo 'gpu_mem=16' | sudo tee -a /boot/config.txt

# Disable Bluetooth if not needed
sudo systemctl disable bluetooth
```

### Kaynakları İzleyin

```bash
# Check memory
free -h

# Check CPU temperature
vcgencmd measure_temp

# Live monitoring
htop
```

---

## ARM’e Özgü Notlar

### İkili Uyumluluk

OpenClaw’ın çoğu özelliği ARM64 üzerinde çalışır; ancak bazı harici ikililer ARM derlemeleri gerektirebilir:

| Araç                                   | ARM64 Durumu | Notlar                              |
| -------------------------------------- | ------------ | ----------------------------------- |
| Node.js                | ✅            | Çok iyi çalışır                     |
| WhatsApp (Baileys)  | ✅            | Saf JS, sorun yok                   |
| Telegram                               | ✅            | Saf JS, sorun yok                   |
| gog (Gmail CLI)     | ⚠️           | ARM sürümü var mı kontrol edin      |
| Chromium (tarayıcı) | ✅            | `sudo apt install chromium-browser` |

Bir skill başarısız olursa, ikilisinin ARM derlemesi olup olmadığını kontrol edin. Birçok Go/Rust aracı vardır; bazıları yoktur.

### 32-bit vs 64-bit

**Her zaman 64-bit işletim sistemi kullanın.** Node.js ve birçok modern araç bunu gerektirir. Şununla kontrol edin:

```bash
uname -m
# Should show: aarch64 (64-bit) not armv7l (32-bit)
```

---

## Önerilen Model Kurulumu

Pi yalnızca Gateway olduğu için (modeller bulutta çalışır), API tabanlı modeller kullanın:

```json
{
  "agents": {
    "defaults": {
      "model": {
        "primary": "anthropic/claude-sonnet-4-20250514",
        "fallbacks": ["openai/gpt-4o-mini"]
      }
    }
  }
}
```

**Pi üzerinde yerel LLM çalıştırmayı denemeyin** — küçük modeller bile çok yavaştır. Ağır işi Claude/GPT’ye bırakın.

---

## Açılışta Otomatik Başlatma

Onboarding sihirbazı bunu ayarlar; doğrulamak için:

```bash
# Check service is enabled
sudo systemctl is-enabled openclaw

# Enable if not
sudo systemctl enable openclaw

# Start on boot
sudo systemctl start openclaw
```

---

## Sorun Giderme

### Bellek Yetersizliği (OOM)

```bash
# Check memory
free -h

# Add more swap (see Step 5)
# Or reduce services running on the Pi
```

### Yavaş Performans

- SD kart yerine USB SSD kullanın
- Kullanılmayan servisleri devre dışı bırakın: `sudo systemctl disable cups bluetooth avahi-daemon`
- CPU kısıtlamasını kontrol edin: `vcgencmd get_throttled` (şunu döndürmelidir: `0x0`)

### Servis Başlamıyor

```bash
# Check logs
journalctl -u openclaw --no-pager -n 100

# Common fix: rebuild
cd ~/openclaw  # if using hackable install
npm run build
sudo systemctl restart openclaw
```

### ARM İkili Sorunları

Bir skill “exec format error” ile başarısız olursa:

1. İkilinin ARM64 derlemesi olup olmadığını kontrol edin
2. Kaynaktan derlemeyi deneyin
3. Ya da ARM destekli bir Docker konteyneri kullanın

### WiFi Kopmaları

WiFi kullanan başsız Pi’ler için:

```bash
# Disable WiFi power management
sudo iwconfig wlan0 power off

# Make permanent
echo 'wireless-power off' | sudo tee -a /etc/network/interfaces
```

---

## Maliyet Karşılaştırması

| Kurulum                           | Tek Seferlik Maliyet | Aylık Maliyet            | Notlar                                             |
| --------------------------------- | -------------------- | ------------------------ | -------------------------------------------------- |
| **Pi 4 (2GB)** | ~$45 | $0                       | + güç (~$5/yıl) |
| **Pi 4 (4GB)** | ~$55 | $0                       | Önerilir                                           |
| **Pi 5 (4GB)** | ~$60 | $0                       | En iyi performans                                  |
| **Pi 5 (8GB)** | ~$80 | $0                       | Aşırı ama geleceğe hazır                           |
| DigitalOcean                      | $0                   | $6/ay                    | $72/yıl                                            |
| Hetzner                           | $0                   | €3.79/ay | ~$50/yıl                           |

**Başabaş:** Bir Pi, bulut VPS’e kıyasla ~6-12 ayda kendini amorti eder.

---

## Ayrıca Bakınız

- [Linux kılavuzu](/platforms/linux) — genel Linux kurulumu
- [DigitalOcean kılavuzu](/platforms/digitalocean) — bulut alternatifi
- [Hetzner kılavuzu](/install/hetzner) — Docker kurulumu
- [Tailscale](/gateway/tailscale) — uzaktan erişim
- [Nodes](/nodes) — dizüstü bilgisayarınızı/telefonunuzu Pi gateway’i ile eşleştirin
