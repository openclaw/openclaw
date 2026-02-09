---
summary: "Gateway kontrol paneli (Control UI) erişimi ve kimlik doğrulama"
read_when:
  - Kontrol paneli kimlik doğrulaması veya erişime açma modlarını değiştirirken
title: "Gösterge Paneli"
---

# Kontrol Paneli (Control UI)

Gateway kontrol paneli, varsayılan olarak `/` adresinde sunulan tarayıcı tabanlı Control UI’dir
(`gateway.controlUi.basePath` ile geçersiz kılınabilir).

Hızlı açma (yerel Gateway):

- [http://127.0.0.1:18789/](http://127.0.0.1:18789/) (veya [http://localhost:18789/](http://localhost:18789/))

Key references:

- Kullanım ve UI yetenekleri için [Control UI](/web/control-ui).
- Serve/Funnel otomasyonu için [Tailscale](/gateway/tailscale).
- Bağlama modları ve güvenlik notları için [Web surfaces](/web).

Kimlik doğrulama, WebSocket el sıkışması sırasında `connect.params.auth` (belirteç veya parola) ile zorunlu kılınır. Ayrıntılar için [Gateway yapılandırması](/gateway/configuration) içindeki `gateway.auth` bölümüne bakın.

Güvenlik notu: Control UI bir **yönetici yüzeyidir** (sohbet, yapılandırma, çalıştırma onayları).
Herkese açık olarak erişime açmayın. UI, ilk yüklemeden sonra belirteci `localStorage` içinde saklar.
localhost, Tailscale Serve veya bir SSH tünelini tercih edin.

## Hızlı yol (önerilen)

- İlk kurulumdan sonra CLI, kontrol panelini otomatik olarak açar ve temiz (belirteç içermeyen) bir bağlantı yazdırır.
- İstediğiniz zaman yeniden açın: `openclaw dashboard` (bağlantıyı kopyalar, mümkünse tarayıcıyı açar, başsızsa SSH ipucu gösterir).
- UI kimlik doğrulama isterse, `gateway.auth.token` (veya `OPENCLAW_GATEWAY_TOKEN`) içindeki belirteci Control UI ayarlarına yapıştırın.

## Token basics (local vs remote)

- **Localhost**: `http://127.0.0.1:18789/` adresini açın.
- **Belirteç kaynağı**: `gateway.auth.token` (veya `OPENCLAW_GATEWAY_TOKEN`); bağlandıktan sonra UI bir kopyayı localStorage’da saklar.
- **Localhost değilse**: Tailscale Serve (eğer `gateway.auth.allowTailscale: true` ise belirteçsiz), belirteçle tailnet bağlama veya bir SSH tüneli kullanın. Bkz. [Web surfaces](/web).

## “unauthorized” / 1008 görürseniz

- Gateway’in erişilebilir olduğundan emin olun (yerel: `openclaw status`; uzak: SSH tüneli `ssh -N -L 18789:127.0.0.1:18789 user@host` ardından `http://127.0.0.1:18789/` adresini açın).
- Belirteci gateway ana makinesinden alın: `openclaw config get gateway.auth.token` (veya bir tane oluşturun: `openclaw doctor --generate-gateway-token`).
- Kontrol paneli ayarlarında, belirteci kimlik doğrulama alanına yapıştırın ve bağlanın.
