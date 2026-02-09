---
summary: "OpenClaw için gelişmiş kurulum ve geliştirme iş akışları"
read_when:
  - Yeni bir makine kurarken
  - Kişisel kurulumunuzu bozmadan “en yeni + en iyiyi” istiyorsanız
title: "Kurulum"
---

# Kurulum

<Note>
İlk kez kurulum yapıyorsanız, [Başlarken](/start/getting-started) ile başlayın.
Sihirbaz ayrıntıları için [Onboarding Wizard](/start/wizard) bölümüne bakın.
</Note>

Son güncelleme: 2026-01-01

## TL;DR

- **Özelleştirme depo dışında yaşar:** `~/.openclaw/workspace` (çalışma alanı) + `~/.openclaw/openclaw.json` (yapılandırma).
- **Kararlı iş akışı:** macOS uygulamasını yükleyin; paketli Gateway’i çalıştırmasına izin verin.
- **En yeni iş akışı:** Gateway’i `pnpm gateway:watch` üzerinden kendiniz çalıştırın; ardından macOS uygulamasının Yerel modda bağlanmasına izin verin.

## Ön Koşullar (kaynaktan)

- Node `>=22`
- `pnpm`
- Docker (isteğe bağlı; yalnızca konteynerli kurulum/e2e için — bkz. [Docker](/install/docker))

## Uyarlama stratejisi (böylece güncellemeler zarar vermez)

“%100 bana özel” _ve_ kolay güncellemeler istiyorsanız, özelleştirmenizi şuralarda tutun:

- **Yapılandırma:** `~/.openclaw/openclaw.json` (JSON/JSON5 benzeri)
- **Çalışma alanı:** `~/.openclaw/workspace` (skills, prompt’lar, anılar; özel bir git deposu yapın)

Bir kez önyükleyin:

```bash
openclaw setup
```

Bu depo içinden yerel CLI girişini kullanın:

```bash
openclaw setup
```

Henüz global bir kurulumunuz yoksa, `pnpm openclaw setup` ile çalıştırın.

## Bu depodan Gateway’i çalıştırma

`pnpm build` sonrasında, paketlenmiş CLI’yi doğrudan çalıştırabilirsiniz:

```bash
node openclaw.mjs gateway --port 18789 --verbose
```

## Kararlı iş akışı (önce macOS uygulaması)

1. **OpenClaw.app**’i yükleyin + başlatın (menü çubuğu).
2. Onboarding/izinler kontrol listesini tamamlayın (TCC istemleri).
3. Gateway’in **Yerel** olduğundan ve çalıştığından emin olun (uygulama yönetir).
4. Yüzeyleri bağlayın (örnek: WhatsApp):

```bash
openclaw channels login
```

5. 1. Sağlamlık kontrolü:

```bash
openclaw health
```

Onboarding derlemenizde mevcut değilse:

- `openclaw setup` çalıştırın, ardından `openclaw channels login`, sonra Gateway’i manuel olarak başlatın (`openclaw gateway`).

## En yeni iş akışı (Gateway terminalde)

Amaç: TypeScript Gateway üzerinde çalışmak, sıcak yeniden yükleme almak, macOS uygulaması UI’sini bağlı tutmak.

### 0. (İsteğe bağlı) macOS uygulamasını da kaynaktan çalıştırın

macOS uygulamasını da en yeni sürümde istiyorsanız:

```bash
./scripts/restart-mac.sh
```

### 1. Geliştirme Gateway’ini başlatın

```bash
pnpm install
pnpm gateway:watch
```

`gateway:watch`, gateway’i izleme modunda çalıştırır ve TypeScript değişikliklerinde yeniden yükler.

### 2. macOS uygulamasını çalışan Gateway’inize yönlendirin

**OpenClaw.app** içinde:

- Bağlantı Modu: **Yerel**
  Uygulama, yapılandırılmış bağlantı noktasındaki çalışan gateway’e bağlanır.

### 3. Doğrulayın

- Uygulama içi Gateway durumu **“Using existing gateway …”** olarak görünmelidir
- Ya da CLI üzerinden:

```bash
openclaw health
```

### 2. Yaygın tuzaklar

- **Yanlış port:** Gateway WS varsayılanı `ws://127.0.0.1:18789`; uygulama + CLI aynı portta olmalıdır.
- **Durumun yaşadığı yerler:**
  - Kimlik bilgileri: `~/.openclaw/credentials/`
  - Oturumlar: `~/.openclaw/agents/<agentId>/sessions/`
  - Günlükler: `/tmp/openclaw/`

## Kimlik bilgisi depolama haritası

Kimlik doğrulamayı hata ayıklarken veya neyi yedekleyeceğinize karar verirken kullanın:

- **WhatsApp**: `~/.openclaw/credentials/whatsapp/<accountId>/creds.json`
- **Telegram bot belirteci**: config/env veya `channels.telegram.tokenFile`
- **Discord bot belirteci**: config/env (belirteç dosyası henüz desteklenmiyor)
- **Slack belirteçleri**: config/env (`channels.slack.*`)
- **Eşleştirme izin listeleri**: `~/.openclaw/credentials/<channel>-allowFrom.json`
- **Model kimlik doğrulama profilleri**: `~/.openclaw/agents/<agentId>/agent/auth-profiles.json`
- **Eski OAuth içe aktarma**: `~/.openclaw/credentials/oauth.json`
  Daha fazla ayrıntı: [Güvenlik](/gateway/security#credential-storage-map).

## Güncelleme (kurulumunuzu dağıtmadan)

- `~/.openclaw/workspace` ve `~/.openclaw/`’ü “sizin şeyleriniz” olarak tutun; kişisel prompt/yapılandırmayı `openclaw` deposuna koymayın.
- Kaynağı güncelleme: `git pull` + `pnpm install` (lockfile değiştiğinde) + `pnpm gateway:watch`’yi kullanmaya devam edin.

## Linux (systemd kullanıcı servisi)

Linux kurulumları bir systemd **kullanıcı** servisi kullanır. Varsayılan olarak systemd, çıkışta/boşta kullanıcı
servislerini durdurur; bu da Gateway’i kapatır. Onboarding sizin için lingering’i
etkinleştirmeye çalışır (sudo isteyebilir). Hâlâ kapalıysa, şunu çalıştırın:

```bash
sudo loginctl enable-linger $USER
```

Her zaman açık veya çok kullanıcılı sunucular için, bir
kullanıcı servisi yerine **sistem** servisini düşünün (lingering gerekmez). systemd notları için [Gateway runbook](/gateway) bölümüne bakın.

## İlgili belgeler

- [Gateway runbook](/gateway) (bayraklar, denetim, portlar)
- [Gateway yapılandırması](/gateway/configuration) (yapılandırma şeması + örnekler)
- [Discord](/channels/discord) ve [Telegram](/channels/telegram) (yanıt etiketleri + replyToMode ayarları)
- [OpenClaw asistan kurulumu](/start/openclaw)
- [macOS uygulaması](/platforms/macos) (gateway yaşam döngüsü)
