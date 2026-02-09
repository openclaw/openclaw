---
summary: "Oracle Cloud (Always Free ARM) üzerinde OpenClaw"
read_when:
  - Oracle Cloud üzerinde OpenClaw kurulumu yaparken
  - OpenClaw için düşük maliyetli VPS barındırma ararken
  - Küçük bir sunucuda 7/24 OpenClaw istemek
title: "Oracle Cloud"
---

# Oracle Cloud (OCI) üzerinde OpenClaw

## Amaç

Oracle Cloud’un **Always Free** ARM katmanında kalıcı bir OpenClaw Gateway çalıştırmak.

Oracle’ın ücretsiz katmanı OpenClaw için iyi bir uyum olabilir (özellikle zaten bir OCI hesabınız varsa), ancak bazı ödünleşimleri vardır:

- ARM mimarisi (çoğu şey çalışır, ancak bazı ikililer yalnızca x86 olabilir)
- Kapasite ve kayıt süreci hassas olabilir

## Maliyet Karşılaştırması (2026)

| Sağlayıcı    | Plan            | Özellikler                | Aylık fiyat          | Notlar                          |
| ------------ | --------------- | ------------------------- | -------------------- | ------------------------------- |
| Oracle Cloud | Always Free ARM | 4 OCPU’ya kadar, 24GB RAM | $0                   | ARM, sınırlı kapasite           |
| Hetzner      | CX22            | 2 vCPU, 4GB RAM           | ~ $4 | En ucuz ücretli seçenek         |
| DigitalOcean | Basic           | 1 vCPU, 1GB RAM           | $6                   | Kolay arayüz, iyi dokümantasyon |
| Vultr        | Cloud Compute   | 1 vCPU, 1GB RAM           | $6                   | Birçok konum                    |
| Linode       | Nanode          | 1 vCPU, 1GB RAM           | $5                   | Artık Akamai’nin parçası        |

---

## Ön Koşullar

- Oracle Cloud hesabı ([kayıt](https://www.oracle.com/cloud/free/)) — sorun yaşarsanız [topluluk kayıt rehberi](https://gist.github.com/rssnyder/51e3cfedd730e7dd5f4a816143b25dbd)’ne bakın
- Tailscale hesabı ([tailscale.com](https://tailscale.com) üzerinden ücretsiz)
- ~30 dakika

## 1. Bir OCI Instance Oluşturun

1. [Oracle Cloud Console](https://cloud.oracle.com/)’a giriş yapın
2. **Compute → Instances → Create Instance** yolunu izleyin
3. Yapılandırın:
   - **Ad:** `openclaw`
   - **Image:** Ubuntu 24.04 (aarch64)
   - **Shape:** `VM.Standard.A1.Flex` (Ampere ARM)
   - **OCPU:** 2 (veya 4’e kadar)
   - **Bellek:** 12 GB (veya 24 GB’a kadar)
   - **Boot volume:** 50 GB (200 GB’a kadar ücretsiz)
   - **SSH anahtarı:** Genel anahtarınızı ekleyin
4. **Create**’e tıklayın
5. Genel IP adresini not edin

**İpucu:** Instance oluşturma “Out of capacity” hatasıyla başarısız olursa, farklı bir availability domain deneyin veya daha sonra tekrar deneyin. Ücretsiz katman kapasitesi sınırlıdır.

## 2. Bağlanın ve Güncelleyin

```bash
# Connect via public IP
ssh ubuntu@YOUR_PUBLIC_IP

# Update system
sudo apt update && sudo apt upgrade -y
sudo apt install -y build-essential
```

**Not:** Bazı bağımlılıkların ARM derlemesi için `build-essential` gereklidir.

## 3. Kullanıcı ve Hostname Yapılandırın

```bash
# Set hostname
sudo hostnamectl set-hostname openclaw

# Set password for ubuntu user
sudo passwd ubuntu

# Enable lingering (keeps user services running after logout)
sudo loginctl enable-linger ubuntu
```

## 4. Tailscale Kurulumu

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up --ssh --hostname=openclaw
```

Bu, Tailscale SSH’yi etkinleştirir; böylece tailnet’inizdeki herhangi bir cihazdan `ssh openclaw` ile bağlanabilirsiniz — genel IP gerekmez.

Doğrulayın:

```bash
tailscale status
```

**Bundan sonra Tailscale üzerinden bağlanın:** `ssh ubuntu@openclaw` (veya Tailscale IP’sini kullanın).

## 5. OpenClaw Kurulumu

```bash
curl -fsSL https://openclaw.ai/install.sh | bash
source ~/.bashrc
```

“Botunuzu nasıl hatch etmek istersiniz?” sorulduğunda **“Do this later”** seçeneğini seçin.

> Not: ARM-yerel derleme sorunlarıyla karşılaşırsanız, Homebrew’e yönelmeden önce sistem paketleriyle (ör. `sudo apt install -y build-essential`) başlayın.

## 6. Gateway Yapılandırması (loopback + token auth) ve Tailscale Serve’i Etkinleştirin

Varsayılan olarak token auth kullanın. Bu, öngörülebilirdir ve “insecure auth” Control UI bayraklarına ihtiyaç duymayı önler.

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

## 7. Doğrulama

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

## 8. VCN Güvenliğini Sıkılaştırın

Artık her şey çalıştığına göre, Tailscale dışındaki tüm trafiği engellemek için VCN’i kilitleyin. OCI’nin Virtual Cloud Network’ü ağ kenarında bir güvenlik duvarı gibi davranır — trafik instance’ınıza ulaşmadan önce engellenir.

1. OCI Console’da **Networking → Virtual Cloud Networks**’e gidin
2. VCN’inize tıklayın → **Security Lists** → Default Security List
3. Aşağıdakiler dışındaki tüm ingress kurallarını **kaldırın**:
   - `0.0.0.0/0 UDP 41641` (Tailscale)
4. Varsayılan egress kurallarını koruyun (tüm çıkışlara izin ver)

Bu, ağ kenarında 22 numaralı porttaki SSH’yi, HTTP, HTTPS ve diğer her şeyi engeller. Bundan sonra yalnızca Tailscale üzerinden bağlanabilirsiniz.

---

## Control UI’ye Erişim

Tailscale ağınızdaki herhangi bir cihazdan:

```
https://openclaw.<tailnet-name>.ts.net/
```

`<tailnet-name>` yerine tailnet adınızı yazın ( `tailscale status` içinde görünür).

SSH tüneline gerek yoktur. Tailscale şunları sağlar:

- HTTPS şifreleme (otomatik sertifikalar)
- Tailscale kimliği ile kimlik doğrulama
- Tailnet’inizdeki herhangi bir cihazdan erişim (dizüstü, telefon vb.)

---

## Güvenlik: VCN + Tailscale (önerilen temel)

VCN kilitliyken (yalnızca UDP 41641 açık) ve Gateway loopback’e bağlanmışken, güçlü bir savunma-derinliği elde edersiniz: genel trafik ağ kenarında engellenir ve yönetici erişimi tailnet’iniz üzerinden gerçekleşir.

Bu kurulum, İnternet genelindeki SSH brute force saldırılarını durdurmak için ekstra ana makine tabanlı güvenlik duvarı kurallarına olan _ihtiyacı_ çoğu zaman ortadan kaldırır — ancak yine de işletim sistemini güncel tutmalı, `openclaw security audit` çalıştırmalı ve yanlışlıkla genel arayüzlerde dinlemediğinizi doğrulamalısınız.

### Zaten Korunanlar

| Geleneksel Adım       | Gerekli mi?      | Neden                                                                                |
| --------------------- | ---------------- | ------------------------------------------------------------------------------------ |
| UFW firewall          | Hayır            | VCN, trafik instance’a ulaşmadan önce engeller                                       |
| fail2ban              | Hayır            | VCN’de 22 numaralı port kapalıysa brute force yok                                    |
| sshd sıkılaştırma     | Hayır            | Tailscale SSH, sshd kullanmaz                                                        |
| Root girişini kapatma | Hayır            | Tailscale, sistem kullanıcıları değil Tailscale kimliği kullanır                     |
| Yalnızca SSH anahtarı | Hayır            | Tailscale, tailnet’iniz üzerinden kimlik doğrular                                    |
| IPv6 sıkılaştırma     | Genellikle hayır | VCN/alt ağ ayarlarınıza bağlıdır; gerçekte neyin atandığını/açık olduğunu doğrulayın |

### Hâlâ Önerilenler

- **Kimlik bilgisi izinleri:** `chmod 700 ~/.openclaw`
- **Güvenlik denetimi:** `openclaw security audit`
- **Sistem güncellemeleri:** `sudo apt update && sudo apt upgrade` düzenli olarak
- **Tailscale’i izleme:** [Tailscale yönetici konsolu](https://login.tailscale.com/admin)’nda cihazları gözden geçirin

### Güvenlik Duruşunu Doğrulayın

```bash
# Confirm no public ports listening
sudo ss -tlnp | grep -v '127.0.0.1\|::1'

# Verify Tailscale SSH is active
tailscale status | grep -q 'offers: ssh' && echo "Tailscale SSH active"

# Optional: disable sshd entirely
sudo systemctl disable --now ssh
```

---

## Alternatif: SSH Tüneli

Tailscale Serve çalışmıyorsa, bir SSH tüneli kullanın:

```bash
# From your local machine (via Tailscale)
ssh -L 18789:127.0.0.1:18789 ubuntu@openclaw
```

Ardından `http://localhost:18789`’i açın.

---

## Sorun Giderme

### Instance oluşturma başarısız (“Out of capacity”)

Ücretsiz katman ARM instance’ları popülerdir. Şunları deneyin:

- Farklı bir availability domain
- Yoğun olmayan saatlerde tekrar deneyin (erken sabah)
- Shape seçerken “Always Free” filtresini kullanın

### Tailscale bağlanmıyor

```bash
# Check status
sudo tailscale status

# Re-authenticate
sudo tailscale up --ssh --hostname=openclaw --reset
```

### Gateway başlatılmıyor

```bash
openclaw gateway status
openclaw doctor --non-interactive
journalctl --user -u openclaw-gateway -n 50
```

### Control UI’ye erişemiyorum

```bash
# Verify Tailscale Serve is running
tailscale serve status

# Check gateway is listening
curl http://localhost:18789

# Restart if needed
systemctl --user restart openclaw-gateway
```

### ARM ikili sorunları

Bazı araçların ARM derlemeleri olmayabilir. Şunları kontrol edin:

```bash
uname -m  # Should show aarch64
```

Çoğu npm paketi sorunsuz çalışır. İkililer için `linux-arm64` veya `aarch64` sürümlerini arayın.

---

## Kalıcılık

Tüm durum şu dizinlerde bulunur:

- `~/.openclaw/` — yapılandırma, kimlik bilgileri, oturum verileri
- `~/.openclaw/workspace/` — çalışma alanı (SOUL.md, bellek, yapıtlar)

Periyodik olarak yedekleyin:

```bash
tar -czvf openclaw-backup.tar.gz ~/.openclaw ~/.openclaw/workspace
```

---

## Ayrıca Bakınız

- [Gateway uzaktan erişim](/gateway/remote) — diğer uzaktan erişim kalıpları
- [Tailscale entegrasyonu](/gateway/tailscale) — tam Tailscale dokümantasyonu
- [Gateway yapılandırması](/gateway/configuration) — tüm yapılandırma seçenekleri
- [DigitalOcean rehberi](/platforms/digitalocean) — ücretli + daha kolay kayıt
- [Hetzner rehberi](/install/hetzner) — Docker tabanlı alternatif
