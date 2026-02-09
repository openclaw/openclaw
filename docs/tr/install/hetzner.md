---
summary: "Dayanıklı durum ve yerleşik ikili dosyalarla OpenClaw Gateway’i ucuz bir Hetzner VPS’te (Docker) 7/24 çalıştırın"
read_when:
  - OpenClaw’un 7/24 bir bulut VPS’te (dizüstünüzde değil) çalışmasını istiyorsanız
  - Kendi VPS’inizde üretim seviyesinde, her zaman açık bir Gateway istiyorsanız
  - Kalıcılık, ikili dosyalar ve yeniden başlatma davranışı üzerinde tam kontrol istiyorsanız
  - OpenClaw’u Hetzner veya benzeri bir sağlayıcıda Docker ile çalıştırıyorsanız
title: "Hetzner"
---

# Hetzner Üzerinde OpenClaw (Docker, Üretim VPS Rehberi)

## Amaç

Docker kullanarak bir Hetzner VPS üzerinde, dayanıklı durum, yerleşik ikili dosyalar ve güvenli yeniden başlatma davranışıyla kalıcı bir OpenClaw Gateway çalıştırmak.

“~5$’a OpenClaw 7/24” istiyorsanız, bu en basit ve güvenilir kurulumdur.
Hetzner fiyatları değişir; en küçük Debian/Ubuntu VPS’i seçin ve OOM’lara (bellek yetersizliği) takılırsanız ölçeklendirin.

## Ne yapıyoruz (basitçe)?

- Küçük bir Linux sunucusu kiralıyoruz (Hetzner VPS)
- Docker’ı kuruyoruz (izole uygulama çalışma zamanı)
- OpenClaw Gateway’i Docker içinde başlatıyoruz
- `~/.openclaw` + `~/.openclaw/workspace` verilerini ana makinede kalıcı hale getiriyoruz (yeniden başlatma/yeniden oluşturma sonrası korunur)
- Dizüstünüzden bir SSH tüneli üzerinden Kontrol UI’ye erişiyoruz

Gateway’e şu yollarla erişilebilir:

- Dizüstünüzden SSH port yönlendirmesi
- Güvenlik duvarı ve belirteçleri kendiniz yönetiyorsanız doğrudan port açma

Bu rehber, Hetzner üzerinde Ubuntu veya Debian varsayar.  
Başka bir Linux VPS kullanıyorsanız, paketleri buna göre eşleyin.
Genel Docker akışı için bkz. [Docker](/install/docker).

---

## Hızlı yol (deneyimli operatörler)

1. Hetzner VPS’i sağlayın
2. Docker’ı kurun
3. OpenClaw deposunu klonlayın
4. Kalıcı ana makine dizinlerini oluşturun
5. `.env` ve `docker-compose.yml` yapılandırın
6. Ana makine hacim bağlaması
7. `docker compose up -d`
8. Kalıcılığı ve Gateway erişimini doğrulayın

---

## İhtiyacınız olanlar

- Root erişimine sahip Hetzner VPS
- Dizüstünüzden SSH erişimi
- SSH + kopyala/yapıştır konusunda temel rahatlık
- ~20 dakika
- Docker ve Docker Compose
- Model kimlik doğrulama bilgileri
- İsteğe bağlı sağlayıcı kimlik bilgileri
  - WhatsApp QR
  - Telegram bot belirteci
  - Gmail OAuth

---

## 1. VPS’i sağlayın

Hetzner’da bir Ubuntu veya Debian VPS oluşturun.

Root olarak bağlanın:

```bash
ssh root@YOUR_VPS_IP
```

Bu rehber VPS’in durum bilgisi tutan (stateful) olduğunu varsayar.
Bunu tek kullanımlık (disposable) altyapı gibi ele almayın.

---

## 2. Docker’ı kurun (VPS üzerinde)

```bash
apt-get update
apt-get install -y git curl ca-certificates
curl -fsSL https://get.docker.com | sh
```

Doğrulayın:

```bash
docker --version
docker compose version
```

---

## 3. OpenClaw deposunu klonlayın

```bash
git clone https://github.com/openclaw/openclaw.git
cd openclaw
```

Bu rehber, ikili dosyaların kalıcılığını garanti etmek için özel bir imaj oluşturacağınızı varsayar.

---

## 4. Kalıcı ana makine dizinlerini oluşturun

Docker container’ları geçicidir.
Tüm uzun ömürlü durum ana makinede bulunmalıdır.

```bash
mkdir -p /root/.openclaw
mkdir -p /root/.openclaw/workspace

# Set ownership to the container user (uid 1000):
chown -R 1000:1000 /root/.openclaw
chown -R 1000:1000 /root/.openclaw/workspace
```

---

## 5. Ortam değişkenlerini yapılandırın

Depo kökünde `.env` oluşturun.

```bash
OPENCLAW_IMAGE=openclaw:latest
OPENCLAW_GATEWAY_TOKEN=change-me-now
OPENCLAW_GATEWAY_BIND=lan
OPENCLAW_GATEWAY_PORT=18789

OPENCLAW_CONFIG_DIR=/root/.openclaw
OPENCLAW_WORKSPACE_DIR=/root/.openclaw/workspace

GOG_KEYRING_PASSWORD=change-me-now
XDG_CONFIG_HOME=/home/node/.openclaw
```

Güçlü gizli anahtarlar üretin:

```bash
openssl rand -hex 32
```

**Bu dosyayı commit etmeyin.**

---

## 6. Docker Compose yapılandırması

`docker-compose.yml` dosyasını oluşturun veya güncelleyin.

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
      # Recommended: keep the Gateway loopback-only on the VPS; access via SSH tunnel.
      # To expose it publicly, remove the `127.0.0.1:` prefix and firewall accordingly.
      - "127.0.0.1:${OPENCLAW_GATEWAY_PORT}:18789"

      # Optional: only if you run iOS/Android nodes against this VPS and need Canvas host.
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

## 7. Gerekli ikili dosyaları imaja yerleştirin (kritik)

Çalışan bir container içine ikili dosyalar kurmak bir tuzaktır.
Çalışma anında kurulan her şey yeniden başlatmada kaybolur.

Skills tarafından gereken tüm harici ikili dosyalar imaj oluşturma zamanında kurulmalıdır.

Aşağıdaki örnekler yalnızca üç yaygın ikili dosyayı gösterir:

- Gmail erişimi için `gog`
- Google Places için `goplaces`
- WhatsApp için `wacli`

Bunlar örnektir, eksiksiz bir liste değildir.
Aynı deseni kullanarak gerektiği kadar ikili dosya kurabilirsiniz.

Daha sonra ek ikili dosyalara bağımlı yeni skills eklerseniz şunları yapmalısınız:

1. Dockerfile’ı güncelleyin
2. İmajı yeniden oluşturun
3. Container’ları yeniden başlatın

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

## 8. Derleyin ve başlatın

```bash
docker compose build
docker compose up -d openclaw-gateway
```

İkili dosyaları doğrulayın:

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

## 9. Gateway’i doğrulayın

```bash
docker compose logs -f openclaw-gateway
```

Başarılı:

```
[gateway] listening on ws://0.0.0.0:18789
```

Dizüstünüzden:

```bash
ssh -N -L 18789:127.0.0.1:18789 root@YOUR_VPS_IP
```

Açın:

`http://127.0.0.1:18789/`

Gateway belirtecinizi yapıştırın.

---

## Nerede ne kalıcı (tek doğru kaynak)

OpenClaw Docker içinde çalışır, ancak Docker tek doğru kaynak değildir.
Tüm uzun ömürlü durum; yeniden başlatmalar, yeniden oluşturma ve yeniden başlatma (reboot) sonrasında hayatta kalmalıdır.

| Bileşen                                     | Konum                             | Kalıcılık mekanizması      | Notlar                                  |
| ------------------------------------------- | --------------------------------- | -------------------------- | --------------------------------------- |
| Gateway yapılandırması                      | `/home/node/.openclaw/`           | Ana makine hacim bağlaması | `openclaw.json`, belirteçler dahil      |
| Model kimlik profilleri                     | `/home/node/.openclaw/`           | Ana makine hacim bağlaması | OAuth belirteçleri, API anahtarları     |
| Skill yapılandırmaları                      | `/home/node/.openclaw/skills/`    | Ana makine hacim bağlaması | Skill düzeyi durum                      |
| concepts/agent-workspace.md | `/home/node/.openclaw/workspace/` | Ana makine hacim bağlaması | Kod ve ajan artefaktları                |
| WhatsApp oturumu                            | `/home/node/.openclaw/`           | Harici ikili dosyalar      | QR girişini korur                       |
| Gmail anahtarlığı                           | `/home/node/.openclaw/`           | Ana makine volume + parola | `GOG_KEYRING_PASSWORD` gerektirir       |
| Derleme zamanında imaja gömülmelidir        | `/usr/local/bin/`                 | Docker imajı               | Node çalışma zamanı                     |
| Çalışma zamanında kurmayın                  | Container dosya sistemi           | Docker imajı               | Her imaj oluşturmada yeniden kurulur    |
| OS paketleri                                | Container dosya sistemi           | Docker imajı               | Yalnızca kaynaktan derliyorsanız `pnpm` |
| Docker container                            | Geçicidir                         | Yeniden başlatılabilir     | Yok edilmesi güvenlidir                 |
