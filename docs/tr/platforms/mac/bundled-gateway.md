---
summary: "macOS üzerinde Gateway çalışma zamanı (harici launchd hizmeti)"
read_when:
  - OpenClaw.app paketlenirken
  - macOS gateway launchd hizmeti hata ayıklanırken
  - macOS için gateway CLI kurulurken
title: "macOS üzerinde Gateway"
---

# macOS üzerinde Gateway (harici launchd)

OpenClaw.app artık Node/Bun veya Gateway çalışma zamanını paketlemez. macOS uygulaması
**harici** bir `openclaw` CLI kurulumunu bekler, Gateway’i bir alt süreç olarak
başlatmaz ve Gateway’in çalışır durumda kalması için kullanıcı başına bir launchd
hizmetini yönetir (ya da zaten çalışıyorsa mevcut bir yerel Gateway’e bağlanır).

## CLI’yi yükleyin (yerel mod için gereklidir)

Mac’te Node 22+ gereklidir, ardından `openclaw`’ü global olarak yükleyin:

```bash
npm install -g openclaw@<version>
```

macOS uygulamasındaki **Install CLI** düğmesi aynı akışı npm/pnpm üzerinden çalıştırır (Gateway çalışma zamanı için bun önerilmez).

## Launchd (LaunchAgent olarak Gateway)

Etiket:

- `bot.molt.gateway` (veya `bot.molt.<profile>`; eski `com.openclaw.*` kalmış olabilir)

Plist konumu (kullanıcı başına):

- `~/Library/LaunchAgents/bot.molt.gateway.plist`
  (veya `~/Library/LaunchAgents/bot.molt.<profile>.plist`)

Yönetim:

- Yerel modda LaunchAgent kurulum/güncellemesinin sahibi macOS uygulamasıdır.
- CLI de kurabilir: `openclaw gateway install`.

Davranış:

- “OpenClaw Active” LaunchAgent’i etkinleştirir/devre dışı bırakır.
- Uygulamadan çıkış gateway’i **durdurmaz** (launchd çalışır durumda tutar).
- Yapılandırılan portta bir Gateway zaten çalışıyorsa, uygulama yeni bir tane
  başlatmak yerine ona bağlanır.

Logging:

- launchd stdout/err: `/tmp/openclaw/openclaw-gateway.log`

## Sürüm uyumluluğu

macOS uygulaması gateway sürümünü kendi sürümüyle karşılaştırır. Uyumsuzlarsa,
uygulama sürümüyle eşleşecek şekilde global CLI’yi güncelleyin.

## Duman testi

```bash
openclaw --version

OPENCLAW_SKIP_CHANNELS=1 \
OPENCLAW_SKIP_CANVAS_HOST=1 \
openclaw gateway --port 18999 --bind loopback
```

Ardından:

```bash
openclaw gateway call health --url ws://127.0.0.1:18999 --timeout 3000
```
