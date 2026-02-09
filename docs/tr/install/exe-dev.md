---
summary: "Uzaktan erişim için OpenClaw Gateway’i exe.dev üzerinde (VM + HTTPS proxy) çalıştırın"
read_when:
  - Gateway için ucuz, her zaman açık bir Linux ana makinesine ihtiyacınız var
  - Kendi VPS’inizi çalıştırmadan uzaktan Control UI erişimi istiyorsunuz
title: "exe.dev"
---

# exe.dev

Amaç: exe.dev VM üzerinde çalışan ve dizüstü bilgisayarınızdan şu yol ile erişilebilen OpenClaw Gateway: `https://<vm-name>.exe.xyz`

Bu sayfa, exe.dev’in varsayılan **exeuntu** imajını varsayar. Farklı bir dağıtım seçtiyseniz, paketleri buna göre eşleyin.

## Başlangıç için hızlı yol

1. [https://exe.new/openclaw](https://exe.new/openclaw)
2. Gerekirse kimlik doğrulama anahtarınızı/belirtecinizi girin
3. VM’nizin yanındaki "Agent"e tıklayın ve bekleyin...
4. ???
5. Kâr

## Gerekenler

- exe.dev hesabı
- [exe.dev](https://exe.dev) sanal makinelerine `ssh exe.dev` erişimi (isteğe bağlı)

## Shelley ile Otomatik Kurulum

[exe.dev](https://exe.dev)’in ajanı olan Shelley, OpenClaw’ı bizim
istemimizle anında kurabilir. Kullanılan istem aşağıdadır:

```
Set up OpenClaw (https://docs.openclaw.ai/install) on this VM. Use the non-interactive and accept-risk flags for openclaw onboarding. Add the supplied auth or token as needed. Configure nginx to forward from the default port 18789 to the root location on the default enabled site config, making sure to enable Websocket support. Pairing is done by "openclaw devices list" and "openclaw device approve <request id>". Make sure the dashboard shows that OpenClaw's health is OK. exe.dev handles forwarding from port 8000 to port 80/443 and HTTPS for us, so the final "reachable" should be <vm-name>.exe.xyz, without port specification.
```

## Manuel kurulum

## 1. VM’yi oluşturun

Cihazınızdan:

```bash
ssh exe.dev new
```

Ardından bağlanın:

```bash
ssh <vm-name>.exe.xyz
```

İpucu: Bu VM’yi **durum bilgili (stateful)** tutun. OpenClaw durumu `~/.openclaw/` ve `~/.openclaw/workspace/` altında saklar.

## 2. Ön koşulları kurun (VM üzerinde)

```bash
sudo apt-get update
sudo apt-get install -y git curl jq ca-certificates openssl
```

## 3. OpenClaw’ı kurun

OpenClaw kurulum betiğini çalıştırın:

```bash
curl -fsSL https://openclaw.ai/install.sh | bash
```

## 4. OpenClaw’ı 8000 portuna proxy’lemek için nginx’i ayarlayın

`/etc/nginx/sites-enabled/default` dosyasını aşağıdakiyle düzenleyin:

```
server {
    listen 80 default_server;
    listen [::]:80 default_server;
    listen 8000;
    listen [::]:8000;

    server_name _;

    location / {
        proxy_pass http://127.0.0.1:18789;
        proxy_http_version 1.1;

        # WebSocket support
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";

        # Standard proxy headers
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # Timeout settings for long-lived connections
        proxy_read_timeout 86400s;
        proxy_send_timeout 86400s;
    }
}
```

## 5. OpenClaw’a erişin ve ayrıcalıkları verin

`https://<vm-name>.exe.xyz/` adresine erişin (onboarding sırasında Control UI çıktısına bakın). Kimlik doğrulama isterse,
VM üzerindeki `gateway.auth.token`’ten belirteci yapıştırın ( `openclaw config get gateway.auth.token` ile alın ya da
`openclaw doctor --generate-gateway-token` ile bir tane oluşturun). Cihazları `openclaw devices list` ve
`openclaw devices approve <requestId>` ile onaylayın. Emin olmadığınızda, tarayıcınızdan Shelley’i kullanın!

## Uzaktan Erişim

Uzaktan erişim, [exe.dev](https://exe.dev)’in kimlik doğrulamasıyla yönetilir. Varsayılan olarak,
8000 portundan gelen HTTP trafiği e‑posta kimlik doğrulamasıyla `https://<vm-name>.exe.xyz` adresine yönlendirilir.

## Güncelleme

```bash
npm i -g openclaw@latest
openclaw doctor
openclaw gateway restart
openclaw health
```

Kılavuz: [Updating](/install/updating)
