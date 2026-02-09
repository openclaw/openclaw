---
title: Fly.io
description: OpenClaw’ı Fly.io üzerinde dağıtın
---

# Fly.io Dağıtımı

**Amaç:** Kalıcı depolama, otomatik HTTPS ve Discord/kanal erişimi ile bir [Fly.io](https://fly.io) makinesinde çalışan OpenClaw Gateway.

## İhtiyacınız olanlar

- Yüklü [flyctl CLI](https://fly.io/docs/hands-on/install-flyctl/)
- Fly.io hesabı (ücretsiz katman yeterlidir)
- Model kimlik doğrulaması: Anthropic API anahtarı (veya diğer sağlayıcı anahtarları)
- Kanal kimlik bilgileri: Discord bot belirteci, Telegram belirteci vb.

## Yeni başlayanlar için hızlı yol

1. Depoyu klonlayın → `fly.toml` özelleştirin
2. Uygulama + birim oluşturun → gizli anahtarları ayarlayın
3. `fly deploy` ile dağıtın
4. Yapılandırma oluşturmak için SSH ile bağlanın veya Control UI’yi kullanın

## 1) Fly uygulamasını oluşturun

```bash
# Clone the repo
git clone https://github.com/openclaw/openclaw.git
cd openclaw

# Create a new Fly app (pick your own name)
fly apps create my-openclaw

# Create a persistent volume (1GB is usually enough)
fly volumes create openclaw_data --size 1 --region iad
```

**İpucu:** Size yakın bir bölge seçin. Yaygın seçenekler: `lhr` (Londra), `iad` (Virginia), `sjc` (San Jose).

## 2. fly.toml yapılandırması

Uygulama adınız ve gereksinimlerinizle eşleşecek şekilde `fly.toml` dosyasını düzenleyin.

**Güvenlik notu:** Varsayılan yapılandırma herkese açık bir URL açığa çıkarır. Genel IP’si olmayan, güçlendirilmiş bir dağıtım için [Özel Dağıtım](#private-deployment-hardened) bölümüne bakın veya `fly.private.toml` kullanın.

```toml
app = "my-openclaw"  # Your app name
primary_region = "iad"

[build]
  dockerfile = "Dockerfile"

[env]
  NODE_ENV = "production"
  OPENCLAW_PREFER_PNPM = "1"
  OPENCLAW_STATE_DIR = "/data"
  NODE_OPTIONS = "--max-old-space-size=1536"

[processes]
  app = "node dist/index.js gateway --allow-unconfigured --port 3000 --bind lan"

[http_service]
  internal_port = 3000
  force_https = true
  auto_stop_machines = false
  auto_start_machines = true
  min_machines_running = 1
  processes = ["app"]

[[vm]]
  size = "shared-cpu-2x"
  memory = "2048mb"

[mounts]
  source = "openclaw_data"
  destination = "/data"
```

**Ana ayarlar:**

| Ayar                           | Neden                                                                                                                   |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| `--bind lan`                   | Fly proxy’sinin gateway’e erişebilmesi için `0.0.0.0`’e bağlanır                                                        |
| `--allow-unconfigured`         | Bir yapılandırma dosyası olmadan başlar (sonrasında oluşturacaksınız)                                |
| `internal_port = 3000`         | Fly sağlık kontrolleri için `--port 3000` (veya `OPENCLAW_GATEWAY_PORT`) ile eşleşmelidir            |
| `memory = "2048mb"`            | 512MB çok küçüktür; 2GB önerilir                                                                                        |
| `OPENCLAW_STATE_DIR = "/data"` | **Tüm API anahtarları ve token’lar için yapılandırma dosyası yerine ortam değişkenlerini tercih edin.** |

## 3. Gizli anahtarları ayarlayın

```bash
# Required: Gateway token (for non-loopback binding)
fly secrets set OPENCLAW_GATEWAY_TOKEN=$(openssl rand -hex 32)

# Model provider API keys
fly secrets set ANTHROPIC_API_KEY=sk-ant-...

# Optional: Other providers
fly secrets set OPENAI_API_KEY=sk-...
fly secrets set GOOGLE_API_KEY=...

# Channel tokens
fly secrets set DISCORD_BOT_TOKEN=MTQ...
```

**Notlar:**

- Loopback olmayan bağlamalar (`--bind lan`) güvenlik için `OPENCLAW_GATEWAY_TOKEN` gerektirir.
- Bu belirteçleri parola gibi ele alın.
- Bu, sırların kazara açığa çıkabileceği veya günlüklere yazılabileceği `openclaw.json` dosyasından uzak tutulmasını sağlar. Günlükler

## 4. Dağıtım

```bash
fly deploy
```

İlk dağıtım Docker imajını oluşturur (~2–3 dakika). Sonraki dağıtımlar daha hızlıdır.

Dağıtımdan sonra doğrulayın:

```bash
fly status
fly logs
```

Şunu görmelisiniz:

```
[gateway] listening on ws://0.0.0.0:3000 (PID xxx)
[discord] logged in to discord as xxx
```

## 5. Yapılandırma dosyasını oluşturun

Uygun bir yapılandırma oluşturmak için makineye SSH ile bağlanın:

```bash
fly ssh console
```

Yapılandırma dizinini ve dosyasını oluşturun:

```bash
mkdir -p /data
cat > /data/openclaw.json << 'EOF'
{
  "agents": {
    "defaults": {
      "model": {
        "primary": "anthropic/claude-opus-4-6",
        "fallbacks": ["anthropic/claude-sonnet-4-5", "openai/gpt-4o"]
      },
      "maxConcurrent": 4
    },
    "list": [
      {
        "id": "main",
        "default": true
      }
    ]
  },
  "auth": {
    "profiles": {
      "anthropic:default": { "mode": "token", "provider": "anthropic" },
      "openai:default": { "mode": "token", "provider": "openai" }
    }
  },
  "bindings": [
    {
      "agentId": "main",
      "match": { "channel": "discord" }
    }
  ],
  "channels": {
    "discord": {
      "enabled": true,
      "groupPolicy": "allowlist",
      "guilds": {
        "YOUR_GUILD_ID": {
          "channels": { "general": { "allow": true } },
          "requireMention": false
        }
      }
    }
  },
  "gateway": {
    "mode": "local",
    "bind": "auto"
  },
  "meta": {
    "lastTouchedVersion": "2026.1.29"
  }
}
EOF
```

**Not:** `OPENCLAW_STATE_DIR=/data` ile yapılandırma yolu `/data/openclaw.json`’dır.

**Not:** Discord belirteci aşağıdakilerden biriyle sağlanabilir:

- Ortam değişkeni: `DISCORD_BOT_TOKEN` (sırlar için önerilir)
- Yapılandırma dosyası: `channels.discord.token`

Ortam değişkeni kullanıyorsanız, yapılandırmaya belirteç eklemenize gerek yoktur. Gateway `DISCORD_BOT_TOKEN`’u otomatik olarak okur.

Uygulamak için yeniden başlatın:

```bash
exit
fly machine restart <machine-id>
```

## 6. Gateway’e erişim

### Control UI

Tarayıcıda açın:

```bash
fly open
```

Veya `https://my-openclaw.fly.dev/` adresini ziyaret edin.

Kimlik doğrulamak için gateway belirtecinizi (`OPENCLAW_GATEWAY_TOKEN`’ten alınan) yapıştırın.

### Durum Kalıcı Değil

```bash
fly logs              # Live logs
fly logs --no-tail    # Recent logs
```

### SSH Konsolu

```bash
fly ssh console
```

## Sorun Giderme

### “App is not listening on expected address”

Gateway, `0.0.0.0` yerine `127.0.0.1`’ye bağlanıyor.

**Çözüm:** `fly.toml` içindeki işlem komutunuza `--bind lan` ekleyin.

### Sağlık kontrolleri başarısız / bağlantı reddedildi

Fly, yapılandırılan port üzerinden gateway’e erişemiyor.

**Çözüm:** `internal_port`’nın gateway portuyla eşleştiğinden emin olun (`--port 3000` veya `OPENCLAW_GATEWAY_PORT=3000` ayarlayın).

### OOM / Bellek Sorunları

Konteyner sürekli yeniden başlıyor veya öldürülüyor. İşaretler: `SIGABRT`, `v8::internal::Runtime_AllocateInYoungGeneration` veya sessiz yeniden başlatmalar.

**Çözüm:** `fly.toml` içinde belleği artırın:

```toml
[[vm]]
  memory = "2048mb"
```

Ya da mevcut bir makineyi güncelleyin:

```bash
fly machine update <machine-id> --vm-memory 2048 -y
```

**Not:** 512MB çok küçüktür. 1GB çalışabilir ancak yük altında veya ayrıntılı günlükleme ile OOM yaşanabilir. **2GB önerilir.**

### Gateway Kilit Sorunları

Gateway “zaten çalışıyor” hatalarıyla başlamayı reddeder.

Bu, konteyner yeniden başlatıldığında PID kilit dosyasının birimde kalıcı olması durumunda olur.

**Çözüm:** Kilit dosyasını silin:

```bash
fly ssh console --command "rm -f /data/gateway.*.lock"
fly machine restart <machine-id>
```

Kilit dosyası `/data/gateway.*.lock` konumundadır (alt dizinde değildir).

### Yapılandırma Okunmuyor

`--allow-unconfigured` kullanılıyorsa, gateway minimal bir yapılandırma oluşturur. `/data/openclaw.json` konumundaki özel yapılandırmanız yeniden başlatmada okunmalıdır.

Yapılandırmanın var olduğunu doğrulayın:

```bash
fly ssh console --command "cat /data/openclaw.json"
```

### SSH ile Yapılandırma Yazma

`fly ssh console -C` komutu kabuk yönlendirmesini desteklemez. Bir yapılandırma dosyası yazmak için:

```bash
# Use echo + tee (pipe from local to remote)
echo '{"your":"config"}' | fly ssh console -C "tee /data/openclaw.json"

# Or use sftp
fly sftp shell
> put /local/path/config.json /data/openclaw.json
```

**Not:** Dosya zaten varsa `fly sftp` başarısız olabilir. Önce silin:

```bash
fly ssh console --command "rm /data/openclaw.json"
```

### herkese açık maruz kalma olmadan:

Yeniden başlatmadan sonra kimlik bilgilerini veya oturumları kaybediyorsanız, durum dizini konteyner dosya sistemine yazıyordur.

**Çözüm:** `OPENCLAW_STATE_DIR=/data`’nin `fly.toml` içinde ayarlı olduğundan emin olun ve yeniden dağıtın.

## Güncellemeler

```bash
# Pull latest changes
git pull

# Redeploy
fly deploy

# Check health
fly status
fly logs
```

### Makine Komutunu Güncelleme

Tam bir yeniden dağıtım yapmadan başlangıç komutunu değiştirmeniz gerekiyorsa:

```bash
# Get machine ID
fly machines list

# Update command
fly machine update <machine-id> --command "node dist/index.js gateway --port 3000 --bind lan" -y

# Or with memory increase
fly machine update <machine-id> --vm-memory 2048 --command "node dist/index.js gateway --port 3000 --bind lan" -y
```

**Not:** `fly deploy` sonrasında makine komutu `fly.toml`’teki değere sıfırlanabilir. Manuel değişiklik yaptıysanız, dağıtımdan sonra yeniden uygulayın.

## Özel Dağıtım (Güçlendirilmiş)

Varsayılan olarak Fly, herkese açık IP’ler atar; bu da gateway’inizin `https://your-app.fly.dev` üzerinden erişilebilir olmasını sağlar. Bu kullanışlıdır ancak dağıtımınızın internet tarayıcıları (Shodan, Censys vb.) tarafından keşfedilebilir olduğu anlamına gelir.

**Genel erişimi olmayan** güçlendirilmiş bir dağıtım için özel şablonu kullanın.

### Özel dağıtımı ne zaman kullanmalı

- Yalnızca **giden** çağrılar/mesajlar yapıyorsanız (gelen webhook yok)
- Herhangi bir webhook geri çağrısı için **ngrok veya Tailscale** tünelleri kullanıyorsanız
- Gateway’e tarayıcı yerine **SSH, proxy veya WireGuard** üzerinden erişiyorsanız
- Dağıtımın **internet tarayıcılarından gizli** olmasını istiyorsanız

### Kurulum

Standart yapılandırma yerine `fly.private.toml` kullanın:

```bash
# Deploy with private config
fly deploy -c fly.private.toml
```

Ya da mevcut bir dağıtımı dönüştürün:

```bash
# List current IPs
fly ips list -a my-openclaw

# Release public IPs
fly ips release <public-ipv4> -a my-openclaw
fly ips release <public-ipv6> -a my-openclaw

# Switch to private config so future deploys don't re-allocate public IPs
# (remove [http_service] or deploy with the private template)
fly deploy -c fly.private.toml

# Allocate private-only IPv6
fly ips allocate-v6 --private -a my-openclaw
```

Bundan sonra `fly ips list` yalnızca `private` türünde bir IP göstermelidir:

```
VERSION  IP                   TYPE             REGION
v6       fdaa:x:x:x:x::x      private          global
```

### Özel bir dağıtıma erişim

Genel bir URL olmadığından, şu yöntemlerden birini kullanın:

**Seçenek 1: Yerel proxy (en basit)**

```bash
# Forward local port 3000 to the app
fly proxy 3000:3000 -a my-openclaw

# Then open http://localhost:3000 in browser
```

**Seçenek 2: WireGuard VPN**

```bash
# Create WireGuard config (one-time)
fly wireguard create

# Import to WireGuard client, then access via internal IPv6
# Example: http://[fdaa:x:x:x:x::x]:3000
```

**Seçenek 3: Yalnızca SSH**

```bash
fly ssh console -a my-openclaw
```

### Özel dağıtımda webhooks

Genel erişim olmadan webhook geri çağrıları (Twilio, Telnyx vb.) gerekiyorsa: Kalıcı veriler `/data` konumundaki hacimde bulunur

1. **ngrok tüneli** – ngrok’u konteyner içinde veya yan bileşen olarak çalıştırın
2. **Tailscale Funnel** – Belirli yolları Tailscale üzerinden açığa çıkarın
3. **Yalnızca giden** – Bazı sağlayıcılar (Twilio) webhook olmadan giden çağrılar için sorunsuz çalışır

ngrok ile örnek sesli arama yapılandırması:

```json
{
  "plugins": {
    "entries": {
      "voice-call": {
        "enabled": true,
        "config": {
          "provider": "twilio",
          "tunnel": { "provider": "ngrok" },
          "webhookSecurity": {
            "allowedHosts": ["example.ngrok.app"]
          }
        }
      }
    }
  }
}
```

ngrok tüneli konteyner içinde çalışır ve Fly uygulamasını açığa çıkarmadan genel bir webhook URL’si sağlar. Yönlendirilen host başlıklarının kabul edilmesi için `webhookSecurity.allowedHosts`’i genel tünel ana makine adına ayarlayın.

### Güvenlik avantajları

| Aspect            | Public       | Private    |
| ----------------- | ------------ | ---------- |
| Internet scanners | Discoverable | Hidden     |
| Direct attacks    | Possible     | Blocked    |
| Control UI access | Browser      | Proxy/VPN  |
| Webhook delivery  | Direct       | Via tunnel |

## Notlar

- Fly.io **x86 mimarisi** kullanır (ARM değil)
- Dockerfile her iki mimariyle de uyumludur
- WhatsApp/Telegram başlangıcı için `fly ssh console` kullanın
- Tür
- Signal, Java + signal-cli gerektirir; özel bir imaj kullanın ve belleği 2GB+ tutun.

## Maliyet

Önerilen yapılandırma ile (`shared-cpu-2x`, 2GB RAM):

- Kullanıma bağlı olarak ~$10–15/ay
- Ücretsiz katman belirli bir kullanım hakkı içerir

Ayrıntılar için [Fly.io fiyatlandırması](https://fly.io/docs/about/pricing/) sayfasına bakın.
