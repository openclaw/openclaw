---
summary: "Linux desteği + yardımcı uygulama durumu"
read_when:
  - Linux yardımcı uygulama durumunu ararken
  - Platform kapsamını veya katkıları planlarken
title: "Linux Uygulaması"
---

# Linux Uygulaması

Gateway, Linux üzerinde tamamen desteklenir. **Node önerilen çalışma zamanıdır**.
Bun, Gateway için önerilmez (WhatsApp/Telegram hataları).

Yerel Linux yardımcı uygulamaları planlanmaktadır. Bir tane geliştirmeye yardımcı olmak istiyorsanız katkılar memnuniyetle karşılanır.

## Başlangıç için hızlı yol (VPS)

1. Node 22+ kurun
2. `npm i -g openclaw@latest`
3. `openclaw onboard --install-daemon`
4. Dizüstü bilgisayarınızdan: `ssh -N -L 18789:127.0.0.1:18789 <user>@<host>`
5. `http://127.0.0.1:18789/` açın ve belirtecinizi yapıştırın

Adım adım VPS kılavuzu: [exe.dev](/install/exe-dev)

## Yükleme

- [Başlarken](/start/getting-started)
- [Yükleme ve güncellemeler](/install/updating)
- İsteğe bağlı akışlar: [Bun (deneysel)](/install/bun), [Nix](/install/nix), [Docker](/install/docker)

## Gateway

- [Gateway runbook](/gateway)
- [Yapılandırma](/gateway/configuration)

## Gateway hizmeti kurulumu (CLI)

Bunlardan birini kullanın:

```
openclaw onboard --install-daemon
```

Ya da:

```
openclaw gateway install
```

Ya da:

```
openclaw configure
```

İstendiğinde **Gateway service** seçin.

Onarma/geçiş:

```
openclaw doctor
```

## Sistem denetimi (systemd kullanıcı birimi)

OpenClaw, varsayılan olarak bir systemd **kullanıcı** hizmeti kurar. Paylaşımlı veya her zaman açık sunucular için **sistem** hizmeti kullanın. Tam birim örneği ve yönergeler
[Gateway runbook](/gateway) içinde yer alır.

Minimal kurulum:

`~/.config/systemd/user/openclaw-gateway[-<profile>].service` oluşturun:

```
[Unit]
Description=OpenClaw Gateway (profile: <profile>, v<version>)
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=/usr/local/bin/openclaw gateway --port 18789
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
```

Etkinleştirin:

```
systemctl --user enable --now openclaw-gateway[-<profile>].service
```
