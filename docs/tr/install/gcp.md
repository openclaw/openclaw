---
summary: "Dayanıklı durumla GCP Compute Engine VM (Docker) üzerinde OpenClaw Gateway’i 7/24 çalıştırın"
read_when:
  - GCP üzerinde OpenClaw’ı 7/24 çalıştırmak istiyorsanız
  - Kendi VM’inizde üretim seviyesinde, her zaman açık bir Gateway istiyorsanız
  - Kalıcılık, ikililer ve yeniden başlatma davranışı üzerinde tam denetim istiyorsanız
title: "GCP"
---

# GCP Compute Engine üzerinde OpenClaw (Docker, Üretim VPS Rehberi)

## Amaç

Docker kullanarak GCP Compute Engine VM üzerinde, dayanıklı durum, görüntüye gömülü ikililer ve güvenli yeniden başlatma davranışıyla kalıcı bir OpenClaw Gateway çalıştırmak.

“Aylık ~$5-12 karşılığında OpenClaw 7/24” istiyorsanız, bu Google Cloud üzerinde güvenilir bir kurulumdur.
Fiyatlandırma makine türüne ve bölgeye göre değişir; iş yükünüze uyan en küçük VM’i seçin ve OOM’lara ulaşırsanız ölçekleyin.

## Ne yapıyoruz (basitçe)?

- Bir GCP projesi oluşturup faturalandırmayı etkinleştiriyoruz
- Bir Compute Engine VM oluşturuyoruz
- Docker’ı kuruyoruz (izole uygulama çalışma zamanı)
- OpenClaw Gateway’i Docker içinde başlatıyoruz
- Ana makinede `~/.openclaw` + `~/.openclaw/workspace` kalıcı hale getiriyoruz (yeniden başlatma/yeniden derleme sonrasında da korunur)
- Dizüstü bilgisayarınızdan bir SSH tüneli üzerinden Control UI’a erişiyoruz

Gateway’e şu yollarla erişilebilir:

- Dizüstü bilgisayarınızdan SSH port yönlendirmesi
- Güvenlik duvarını ve belirteçleri kendiniz yönetiyorsanız doğrudan port açma

Bu rehber GCP Compute Engine üzerinde Debian kullanır.
Ubuntu da çalışır; paketleri buna göre eşleyin.
Genel Docker akışı için [Docker](/install/docker) sayfasına bakın.

---

## Hızlı yol (deneyimli operatörler)

1. GCP projesi oluşturun + Compute Engine API’yi etkinleştirin
2. Compute Engine VM oluşturun (e2-small, Debian 12, 20GB)
3. VM’e SSH ile bağlanın
4. Docker’ı kurun
5. OpenClaw deposunu klonlayın
6. Kalıcı ana makine dizinlerini oluşturun
7. `.env` ve `docker-compose.yml` yapılandırın
8. Gerekli ikilileri görüntüye gömün, derleyin ve başlatın

---

## Gereksinimler

- GCP hesabı (e2-micro için ücretsiz katman uygun)
- gcloud CLI kurulu (veya Cloud Console kullanın)
- Dizüstü bilgisayarınızdan SSH erişimi
- SSH + kopyala/yapıştır konusunda temel rahatlık
- ~20–30 dakika
- Docker ve Docker Compose
- Model kimlik doğrulama bilgileri
- İsteğe bağlı sağlayıcı kimlik bilgileri
  - WhatsApp QR
  - Telegram bot belirteci
  - Gmail OAuth

---

## 1. gcloud CLI’yi kurun (veya Console kullanın)

**Seçenek A: gcloud CLI** (otomasyon için önerilir)

Kurulum: [https://cloud.google.com/sdk/docs/install](https://cloud.google.com/sdk/docs/install)

Başlatın ve kimlik doğrulayın:

```bash
gcloud init
gcloud auth login
```

**Seçenek B: Cloud Console**

Tüm adımlar web arayüzü üzerinden yapılabilir: [https://console.cloud.google.com](https://console.cloud.google.com)

---

## 2. Bir GCP projesi oluşturun

**CLI:**

```bash
gcloud projects create my-openclaw-project --name="OpenClaw Gateway"
gcloud config set project my-openclaw-project
```

Faturalandırmayı etkinleştirin: [https://console.cloud.google.com/billing](https://console.cloud.google.com/billing) (Compute Engine için gereklidir).

Compute Engine API’yi etkinleştirin:

```bash
gcloud services enable compute.googleapis.com
```

**Console:**

1. IAM & Admin > Create Project’e gidin
2. Adlandırın ve oluşturun
3. Proje için faturalandırmayı etkinleştirin
4. APIs & Services > Enable APIs > “Compute Engine API” arayın > Enable

---

## 3. VM’i oluşturun

**Makine türleri:**

| Ana makine hacim bağlaması | Özellikler                                      | Maliyet                 | Notlar                   |
| -------------------------- | ----------------------------------------------- | ----------------------- | ------------------------ |
| e2-small                   | 2 vCPU, 2GB RAM                                 | ~$12/ay | Önerilir                 |
| e2-micro                   | 2 vCPU (paylaşımlı), 1GB RAM | Ücretsiz katman uygun   | Yük altında OOM olabilir |

**CLI:**

```bash
gcloud compute instances create openclaw-gateway \
  --zone=us-central1-a \
  --machine-type=e2-small \
  --boot-disk-size=20GB \
  --image-family=debian-12 \
  --image-project=debian-cloud
```

**Console:**

1. Compute Engine > VM instances > Create instance
2. Ad: `openclaw-gateway`
3. Bölge: `us-central1`, Bölge (Zone): `us-central1-a`
4. Makine türü: `e2-small`
5. Önyükleme diski: Debian 12, 20GB
6. Oluştur

---

## 4. VM’e SSH ile bağlanın

**CLI:**

```bash
gcloud compute ssh openclaw-gateway --zone=us-central1-a
```

**Console:**

Compute Engine panosunda VM’in yanındaki “SSH” düğmesine tıklayın.

Not: VM oluşturulduktan sonra SSH anahtarlarının yayılması 1–2 dakika sürebilir. Bağlantı reddedilirse bekleyin ve tekrar deneyin.

---

## 5. Docker’ı kurun (VM üzerinde)

```bash
sudo apt-get update
sudo apt-get install -y git curl ca-certificates
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER
```

Grup değişikliğinin etkili olması için çıkış yapıp tekrar giriş yapın:

```bash
exit
```

Ardından tekrar SSH ile bağlanın:

```bash
gcloud compute ssh openclaw-gateway --zone=us-central1-a
```

Doğrulayın:

```bash
docker --version
docker compose version
```

---

## 6. OpenClaw deposunu klonlayın

```bash
git clone https://github.com/openclaw/openclaw.git
cd openclaw
```

Bu rehber, ikili kalıcılığını garanti etmek için özel bir görüntü derleyeceğinizi varsayar.

---

## 7. Kalıcı ana makine dizinlerini oluşturun

Docker konteynerleri geçicidir.
Uzun ömürlü tüm durum ana makinede yaşamalıdır.

```bash
mkdir -p ~/.openclaw
mkdir -p ~/.openclaw/workspace
```

---

## 8. Ortam değişkenlerini yapılandırın

Depo kök dizininde `.env` oluşturun.

```bash
OPENCLAW_IMAGE=openclaw:latest
OPENCLAW_GATEWAY_TOKEN=change-me-now
OPENCLAW_GATEWAY_BIND=lan
OPENCLAW_GATEWAY_PORT=18789

OPENCLAW_CONFIG_DIR=/home/$USER/.openclaw
OPENCLAW_WORKSPACE_DIR=/home/$USER/.openclaw/workspace

GOG_KEYRING_PASSWORD=change-me-now
XDG_CONFIG_HOME=/home/node/.openclaw
```

Güçlü gizli anahtarlar üretin:

```bash
openssl rand -hex 32
```

**Bu dosyayı commit etmeyin.**

---

## 9. Docker Compose yapılandırması

`docker-compose.yml` oluşturun veya güncelleyin.

```yaml
services:
  openclaw-gateway:
    image: ${OPENCLAW_IMAGE}
    build: .
    restart: unless-stopped
    env_file:
      - .env
    environment:
      - HOME=/home/node
      - NODE_ENV=production
      - TERM=xterm-256color
      - OPENCLAW_GATEWAY_BIND=${OPENCLAW_GATEWAY_BIND}
      - OPENCLAW_GATEWAY_PORT=${OPENCLAW_GATEWAY_PORT}
      - OPENCLAW_GATEWAY_TOKEN=${OPENCLAW_GATEWAY_TOKEN}
      - GOG_KEYRING_PASSWORD=${GOG_KEYRING_PASSWORD}
      - XDG_CONFIG_HOME=${XDG_CONFIG_HOME}
      - PATH=/home/linuxbrew/.linuxbrew/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
    volumes:
      - ${OPENCLAW_CONFIG_DIR}:/home/node/.openclaw
      - ${OPENCLAW_WORKSPACE_DIR}:/home/node/.openclaw/workspace
    ports:
      # Recommended: keep the Gateway loopback-only on the VM; access via SSH tunnel.
      # To expose it publicly, remove the `127.0.0.1:` prefix and firewall accordingly.
      - "127.0.0.1:${OPENCLAW_GATEWAY_PORT}:18789"

      # Optional: only if you run iOS/Android nodes against this VM and need Canvas host.
      # If you expose this publicly, read /gateway/security and firewall accordingly.
      # - "18793:18793"
    command:
      [
        "node",
        "dist/index.js",
        "gateway",
        "--bind",
        "${OPENCLAW_GATEWAY_BIND}",
        "--port",
        "${OPENCLAW_GATEWAY_PORT}",
      ]
```

---

## 10. Gerekli ikilileri görüntüye gömün (kritik)

Çalışan bir konteynerin içine ikili kurmak bir tuzaktır.
Çalışma zamanında kurulan her şey yeniden başlatmada kaybolur.

Skills tarafından gereken tüm harici ikililer görüntü derleme zamanında kurulmalıdır.

Aşağıdaki örnekler yalnızca üç yaygın ikiliyi gösterir:

- Gmail erişimi için `gog`
- Google Places için `goplaces`
- WhatsApp için `wacli`

Bunlar örnektir, eksiksiz bir liste değildir.
Aynı deseni kullanarak istediğiniz kadar ikili kurabilirsiniz.

Daha sonra ek ikililere bağlı yeni skills eklerseniz şunları yapmalısınız:

1. Dockerfile’ı güncelleyin
2. Görüntüyü yeniden derleyin
3. Konteynerleri yeniden başlatın

**Örnek Dockerfile**

```dockerfile
FROM node:22-bookworm

RUN apt-get update && apt-get install -y socat && rm -rf /var/lib/apt/lists/*

# Example binary 1: Gmail CLI
RUN curl -L https://github.com/steipete/gog/releases/latest/download/gog_Linux_x86_64.tar.gz \
  | tar -xz -C /usr/local/bin && chmod +x /usr/local/bin/gog

# Example binary 2: Google Places CLI
RUN curl -L https://github.com/steipete/goplaces/releases/latest/download/goplaces_Linux_x86_64.tar.gz \
  | tar -xz -C /usr/local/bin && chmod +x /usr/local/bin/goplaces

# Example binary 3: WhatsApp CLI
RUN curl -L https://github.com/steipete/wacli/releases/latest/download/wacli_Linux_x86_64.tar.gz \
  | tar -xz -C /usr/local/bin && chmod +x /usr/local/bin/wacli

# Add more binaries below using the same pattern

WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY ui/package.json ./ui/package.json
COPY scripts ./scripts

RUN corepack enable
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm build
RUN pnpm ui:install
RUN pnpm ui:build

ENV NODE_ENV=production

CMD ["node","dist/index.js"]
```

---

## 11. Derleyin ve başlatın

```bash
docker compose build
docker compose up -d openclaw-gateway
```

İkilileri doğrulayın:

```bash
docker compose exec openclaw-gateway which gog
docker compose exec openclaw-gateway which goplaces
docker compose exec openclaw-gateway which wacli
```

Beklenen çıktı:

```
/usr/local/bin/gog
/usr/local/bin/goplaces
/usr/local/bin/wacli
```

---

## 12. Gateway’i doğrulayın

```bash
docker compose logs -f openclaw-gateway
```

Başarılı:

```
[gateway] listening on ws://0.0.0.0:18789
```

---

## 13. Dizüstü bilgisayarınızdan erişim

Gateway portunu yönlendirmek için bir SSH tüneli oluşturun:

```bash
gcloud compute ssh openclaw-gateway --zone=us-central1-a -- -L 18789:127.0.0.1:18789
```

Tarayıcınızda açın:

`http://127.0.0.1:18789/`

Gateway belirtecinizi yapıştırın.

---

## Neler nerede kalıcı (tek doğruluk kaynağı)

OpenClaw Docker içinde çalışır, ancak Docker tek doğruluk kaynağı değildir.
Uzun ömürlü tüm durum yeniden başlatmalara, yeniden derlemelere ve yeniden başlatmalara dayanmalıdır.

| Bileşen                                     | Konum                             | Kalıcılık mekanizması      | Notlar                                     |
| ------------------------------------------- | --------------------------------- | -------------------------- | ------------------------------------------ |
| Gateway yapılandırması                      | `/home/node/.openclaw/`           | Ana makine hacim bağlaması | `openclaw.json`, belirteçler dahil         |
| Model kimlik profilleri                     | `/home/node/.openclaw/`           | Ana makine hacim bağlaması | OAuth belirteçleri, API anahtarları        |
| Skill yapılandırmaları                      | `/home/node/.openclaw/skills/`    | Ana makine hacim bağlaması | Skill düzeyi durum                         |
| concepts/agent-workspace.md | `/home/node/.openclaw/workspace/` | Ana makine hacim bağlaması | Kod ve ajan artefaktları                   |
| WhatsApp oturumu                            | `/home/node/.openclaw/`           | Harici ikili dosyalar      | QR girişini korur                          |
| Gmail anahtarlığı                           | `/home/node/.openclaw/`           | Ana makine hacmi + parola  | `GOG_KEYRING_PASSWORD` gerektirir          |
| Derleme zamanında imaja gömülmelidir        | `/usr/local/bin/`                 | Docker görüntüsü           | Node çalışma zamanı                        |
| Çalışma zamanında kurmayın                  | Konteyner dosya sistemi           | Docker görüntüsü           | Her derlemede yeniden oluşturulur          |
| OS paketleri                                | Konteyner dosya sistemi           | Docker görüntüsü           | Gerekli ikili dosyaları imajın içine gömün |
| Docker konteyneri                           | Geçicidir                         | Yeniden başlatılabilir     | Yok edilmesi güvenlidir                    |

---

## Güncellemeler

VM üzerindeki OpenClaw’ı güncellemek için:

```bash
cd ~/openclaw
git pull
docker compose build
docker compose up -d
```

---

## Sorun Giderme

**SSH bağlantısı reddedildi**

VM oluşturulduktan sonra SSH anahtarlarının yayılması 1–2 dakika sürebilir. Bekleyin ve tekrar deneyin.

**OS Login sorunları**

OS Login profilinizi kontrol edin:

```bash
gcloud compute os-login describe-profile
```

Hesabınızın gerekli IAM izinlerine sahip olduğundan emin olun (Compute OS Login veya Compute OS Admin Login).

**Bellek yetersiz (OOM)**

e2-micro kullanıyor ve OOM yaşıyorsanız e2-small veya e2-medium’a yükseltin:

```bash
# Stop the VM first
gcloud compute instances stop openclaw-gateway --zone=us-central1-a

# Change machine type
gcloud compute instances set-machine-type openclaw-gateway \
  --zone=us-central1-a \
  --machine-type=e2-small

# Start the VM
gcloud compute instances start openclaw-gateway --zone=us-central1-a
```

---

## Hizmet hesapları (güvenlik için en iyi uygulama)

Kişisel kullanım için varsayılan kullanıcı hesabınız yeterlidir.

Otomasyon veya CI/CD ardışık düzenleri için, en az ayrıcalıklarla özel bir hizmet hesabı oluşturun:

1. Bir hizmet hesabı oluşturun:

   ```bash
   gcloud iam service-accounts create openclaw-deploy \
     --display-name="OpenClaw Deployment"
   ```

2. Compute Instance Admin rolünü verin (veya daha dar kapsamlı özel bir rol):

   ```bash
   gcloud projects add-iam-policy-binding my-openclaw-project \
     --member="serviceAccount:openclaw-deploy@my-openclaw-project.iam.gserviceaccount.com" \
     --role="roles/compute.instanceAdmin.v1"
   ```

Otomasyon için Owner rolünü kullanmaktan kaçının. En az ayrıcalık ilkesini uygulayın.

IAM rolleri hakkında ayrıntılar için [https://cloud.google.com/iam/docs/understanding-roles](https://cloud.google.com/iam/docs/understanding-roles) sayfasına bakın.

---

## Sonraki adımlar

- Mesajlaşma kanallarını kurun: [Channels](/channels)
- Yerel cihazları düğüm olarak eşleyin: [Nodes](/nodes)
- Gateway’i yapılandırın: [Gateway configuration](/gateway/configuration)
