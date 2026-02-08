---
summary: "OpenClaw.app’in uzak bir gateway’e bağlanması için SSH tüneli kurulumu"
read_when: "macOS uygulamasını SSH üzerinden uzak bir gateway’e bağlarken"
title: "Uzak Gateway Kurulumu"
x-i18n:
  source_path: gateway/remote-gateway-readme.md
  source_hash: b1ae266a7cb4911b
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:53:16Z
---

# OpenClaw.app’i Uzak Bir Gateway ile Çalıştırma

OpenClaw.app, uzak bir gateway’e bağlanmak için SSH tünelleme kullanır. Bu kılavuz, kurulumu nasıl yapacağınızı gösterir.

## Genel bakış

```
┌─────────────────────────────────────────────────────────────┐
│                        Client Machine                          │
│                                                              │
│  OpenClaw.app ──► ws://127.0.0.1:18789 (local port)           │
│                     │                                        │
│                     ▼                                        │
│  SSH Tunnel ────────────────────────────────────────────────│
│                     │                                        │
└─────────────────────┼──────────────────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────────────────┐
│                         Remote Machine                        │
│                                                              │
│  Gateway WebSocket ──► ws://127.0.0.1:18789 ──►              │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

## Hızlı Kurulum

### Adım 1: SSH Yapılandırması Ekleme

`~/.ssh/config` dosyasını düzenleyin ve şunları ekleyin:

```ssh
Host remote-gateway
    HostName <REMOTE_IP>          # e.g., 172.27.187.184
    User <REMOTE_USER>            # e.g., jefferson
    LocalForward 18789 127.0.0.1:18789
    IdentityFile ~/.ssh/id_rsa
```

`<REMOTE_IP>` ve `<REMOTE_USER>` değerlerini kendi bilgilerinizle değiştirin.

### Adım 2: SSH Anahtarını Kopyalama

Genel anahtarınızı uzak makineye kopyalayın (parolayı bir kez girin):

```bash
ssh-copy-id -i ~/.ssh/id_rsa <REMOTE_USER>@<REMOTE_IP>
```

### Adım 3: Gateway Belirtecini Ayarlama

```bash
launchctl setenv OPENCLAW_GATEWAY_TOKEN "<your-token>"
```

### Adım 4: SSH Tünelini Başlatma

```bash
ssh -N remote-gateway &
```

### Adım 5: OpenClaw.app’i Yeniden Başlatma

```bash
# Quit OpenClaw.app (⌘Q), then reopen:
open /path/to/OpenClaw.app
```

Uygulama artık SSH tüneli üzerinden uzak gateway’e bağlanacaktır.

---

## Oturum Açılışında Tüneli Otomatik Başlatma

Oturum açtığınızda SSH tünelinin otomatik olarak başlaması için bir Launch Agent oluşturun.

### PLIST dosyasını oluşturma

Bunu `~/Library/LaunchAgents/bot.molt.ssh-tunnel.plist` olarak kaydedin:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>bot.molt.ssh-tunnel</string>
    <key>ProgramArguments</key>
    <array>
        <string>/usr/bin/ssh</string>
        <string>-N</string>
        <string>remote-gateway</string>
    </array>
    <key>KeepAlive</key>
    <true/>
    <key>RunAtLoad</key>
    <true/>
</dict>
</plist>
```

### Launch Agent’i Yükleme

```bash
launchctl bootstrap gui/$UID ~/Library/LaunchAgents/bot.molt.ssh-tunnel.plist
```

Tünel artık şunları yapacaktır:

- Oturum açtığınızda otomatik olarak başlar
- Çökerse yeniden başlatır
- Arka planda çalışmaya devam eder

Eski not: varsa kalan `com.openclaw.ssh-tunnel` LaunchAgent’ı kaldırın.

---

## Sorun Giderme

**Tünelin çalışıp çalışmadığını kontrol edin:**

```bash
ps aux | grep "ssh -N remote-gateway" | grep -v grep
lsof -i :18789
```

**Tüneli yeniden başlatın:**

```bash
launchctl kickstart -k gui/$UID/bot.molt.ssh-tunnel
```

**Tüneli durdurun:**

```bash
launchctl bootout gui/$UID/bot.molt.ssh-tunnel
```

---

## Nasıl Çalışır

| Bileşen                              | Ne Yapar                                                    |
| ------------------------------------ | ----------------------------------------------------------- |
| `LocalForward 18789 127.0.0.1:18789` | Yerel 18789 portunu uzak 18789 portuna yönlendirir          |
| `ssh -N`                             | Uzak komutlar çalıştırmadan SSH (yalnızca port yönlendirme) |
| `KeepAlive`                          | Çökerse tüneli otomatik olarak yeniden başlatır             |
| `RunAtLoad`                          | Ajan yüklendiğinde tüneli başlatır                          |

OpenClaw.app, istemci makinenizdeki `ws://127.0.0.1:18789` adresine bağlanır. SSH tüneli bu bağlantıyı, Gateway’in çalıştığı uzak makinedeki 18789 portuna yönlendirir.
