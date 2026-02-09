---
summary: "Tek bir ana makinede birden fazla OpenClaw Gateway çalıştırma (izolasyon, portlar ve profiller)"
read_when:
  - Aynı makinede birden fazla Gateway çalıştırıyorsanız
  - Her Gateway için yalıtılmış yapılandırma/durum/portlara ihtiyacınız varsa
title: "Birden Fazla Gateway"
---

# Birden Fazla Gateway (aynı ana makine)

Çoğu kurulumda tek bir Gateway kullanılmalıdır; çünkü tek bir Gateway birden fazla mesajlaşma bağlantısını ve ajanı yönetebilir. Daha güçlü izolasyon veya yedeklilik gerekiyorsa (ör. bir kurtarma botu), yalıtılmış profil/portlarla ayrı Gateway’ler çalıştırın.

## İzolasyon kontrol listesi (zorunlu)

- `OPENCLAW_CONFIG_PATH` — örnek başına yapılandırma dosyası
- `OPENCLAW_STATE_DIR` — örnek başına oturumlar, kimlik bilgileri, önbellekler
- `agents.defaults.workspace` — örnek başına çalışma alanı kökü
- `gateway.port` (veya `--port`) — örnek başına benzersiz
- Türetilmiş portlar (tarayıcı/tuval) çakışmamalıdır

Bunlar paylaşılırsa yapılandırma yarışları ve port çakışmaları yaşarsınız.

## Önerilen: profiller (`--profile`)

Profiller `OPENCLAW_STATE_DIR` + `OPENCLAW_CONFIG_PATH`’yi otomatik olarak kapsar ve servis adlarına sonek ekler.

```bash
# main
openclaw --profile main setup
openclaw --profile main gateway --port 18789

# rescue
openclaw --profile rescue setup
openclaw --profile rescue gateway --port 19001
```

Profil başına servisler:

```bash
openclaw --profile main gateway install
openclaw --profile rescue gateway install
```

## Kurtarma botu kılavuzu

Aynı ana makinede, aşağıdakilere sahip ikinci bir Gateway çalıştırın:

- profil/yapılandırma
- state dir
- çalışma alanı
- temel port (ve türetilmiş portlar)

Bu, kurtarma botunu ana bottan yalıtır; böylece birincil bot kapalıyken hata ayıklama yapabilir veya yapılandırma değişiklikleri uygulayabilir.

Port aralığı: türetilmiş tarayıcı/tuval/CDP portlarının asla çakışmaması için temel portlar arasında en az 20 port boşluk bırakın.

### Nasıl kurulur (kurtarma botu)

```bash
# Main bot (existing or fresh, without --profile param)
# Runs on port 18789 + Chrome CDC/Canvas/... Ports
openclaw onboard
openclaw gateway install

# Rescue bot (isolated profile + ports)
openclaw --profile rescue onboard
# Notes:
# - workspace name will be postfixed with -rescue per default
# - Port should be at least 18789 + 20 Ports,
#   better choose completely different base port, like 19789,
# - rest of the onboarding is the same as normal

# To install the service (if not happened automatically during onboarding)
openclaw --profile rescue gateway install
```

## Port eşlemesi (türetilmiş)

Temel port = `gateway.port` (veya `OPENCLAW_GATEWAY_PORT` / `--port`).

- tarayıcı kontrol servis portu = temel + 2 (yalnızca local loopback)
- `canvasHost.port = base + 4`
- Tarayıcı profil CDP portları `browser.controlPort + 9 .. + 108`’den otomatik olarak atanır

Bunlardan herhangi birini yapılandırmada veya ortam değişkenlerinde geçersiz kılarsanız, örnek başına benzersiz tutmalısınız.

## Tarayıcı/CDP notları (yaygın tuzak)

- Birden fazla örnekte `browser.cdpUrl`’i aynı değerlere **sabitlemeyin**.
- Her örneğin kendi tarayıcı kontrol portuna ve CDP aralığına (gateway portundan türetilmiş) ihtiyacı vardır.
- Açık CDP portlarına ihtiyacınız varsa, örnek başına `browser.profiles.<name>.cdpPort` ayarlayın.
- Uzak Chrome: `browser.profiles.<name>.cdpUrl` kullanın (profil başına, örnek başına).

## Manuel ortam değişkeni örneği

```bash
OPENCLAW_CONFIG_PATH=~/.openclaw/main.json \
OPENCLAW_STATE_DIR=~/.openclaw-main \
openclaw gateway --port 18789

OPENCLAW_CONFIG_PATH=~/.openclaw/rescue.json \
OPENCLAW_STATE_DIR=~/.openclaw-rescue \
openclaw gateway --port 19001
```

## Hızlı kontroller

```bash
openclaw --profile main status
openclaw --profile rescue status
openclaw --profile rescue browser status
```
