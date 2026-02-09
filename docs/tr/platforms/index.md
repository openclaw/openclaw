---
summary: "Platform desteğine genel bakış (Gateway + yardımcı uygulamalar)"
read_when:
  - İşletim sistemi desteği veya kurulum yolları arıyorsanız
  - Gateway’i nerede çalıştıracağınıza karar veriyorsanız
title: "Platformlar"
---

# Platformlar

OpenClaw çekirdeği TypeScript ile yazılmıştır. **Önerilen çalışma zamanı Node’dur**.
Bun, Gateway için önerilmez (WhatsApp/Telegram hataları).

macOS (menü çubuğu uygulaması) ve mobil düğümler (iOS/Android) için yardımcı uygulamalar mevcuttur. Windows ve
Linux yardımcı uygulamaları planlanmaktadır; ancak Gateway bugün itibarıyla tamamen desteklenmektedir.
Windows için yerel yardımcı uygulamalar da planlanmaktadır; Gateway’in WSL2 üzerinden çalıştırılması önerilir.

## İşletim sisteminizi seçin

- macOS: [macOS](/platforms/macos)
- iOS: [iOS](/platforms/ios)
- Android: [Android](/platforms/android)
- Windows: [Windows](/platforms/windows)
- Linux: [Linux](/platforms/linux)

## VPS ve barındırma

- VPS merkezi: [VPS hosting](/vps)
- Fly.io: [Fly.io](/install/fly)
- Hetzner (Docker): [Hetzner](/install/hetzner)
- GCP (Compute Engine): [GCP](/install/gcp)
- exe.dev (VM + HTTPS proxy): [exe.dev](/install/exe-dev)

## Ortak bağlantılar

- Kurulum kılavuzu: [Başlarken](/start/getting-started)
- Gateway çalışma kılavuzu: [Gateway](/gateway)
- Gateway yapılandırması: [Yapılandırma](/gateway/configuration)
- Hizmet durumu: `openclaw gateway status`

## Gateway hizmeti kurulumu (CLI)

Aşağıdakilerden birini kullanın (hepsi desteklenir):

- Sihirbaz (önerilir): `openclaw onboard --install-daemon`
- Doğrudan: `openclaw gateway install`
- Yapılandırma akışı: `openclaw configure` → **Gateway hizmeti**ni seçin
- Onarım/geçiş: `openclaw doctor` (hizmeti kurmayı veya düzeltmeyi önerir)

Hizmet hedefi işletim sistemine bağlıdır:

- macOS: LaunchAgent (`bot.molt.gateway` veya `bot.molt.<profile>`; eski `com.openclaw.*`)
- Linux/WSL2: systemd kullanıcı hizmeti (`openclaw-gateway[-<profile>].service`)
