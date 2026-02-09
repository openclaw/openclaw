---
summary: "Gateway panosu için entegre Tailscale Serve/Funnel"
read_when:
  - Gateway Kontrol UI’sini localhost dışına açma
  - Tailnet veya herkese açık pano erişimini otomatikleştirme
title: "Tailscale"
---

# Tailscale (Gateway panosu)

OpenClaw, Gateway panosu ve WebSocket portu için Tailscale **Serve** (tailnet) veya **Funnel** (herkese açık) yapılandırmasını otomatik olarak yapabilir. Bu yaklaşım, Gateway’in loopback’e bağlı kalmasını sağlarken Tailscale’in HTTPS, yönlendirme ve (Serve için) kimlik başlıklarını sağlamasına olanak tanır.

## Modlar

- `serve`: `tailscale serve` üzerinden yalnızca Tailnet Serve. Gateway, `127.0.0.1` üzerinde kalır.
- `funnel`: `tailscale funnel` üzerinden herkese açık HTTPS. OpenClaw paylaşılan bir parola gerektirir.
- `off`: Varsayılan (Tailscale otomasyonu yok).

## Kimlik doğrulama

El sıkışmayı denetlemek için `gateway.auth.mode` değerini ayarlayın:

- `token` (`OPENCLAW_GATEWAY_TOKEN` ayarlandığında varsayılan)
- `password` (`OPENCLAW_GATEWAY_PASSWORD` veya yapılandırma üzerinden paylaşılan gizli anahtar)

`tailscale.mode = "serve"` etkin ve `gateway.auth.allowTailscale` `true` olduğunda,
geçerli Serve proxy istekleri bir belirteç/parola sunmadan Tailscale kimlik başlıkları
(`tailscale-user-login`) üzerinden kimlik doğrulaması yapabilir. OpenClaw,
`x-forwarded-for` adresini yerel Tailscale daemon’ı (`tailscale whois`) üzerinden çözümleyerek
ve kabul etmeden önce başlıkla eşleştirerek kimliği doğrular.
OpenClaw bir isteği yalnızca loopback’ten ve Tailscale’in `x-forwarded-for`,
`x-forwarded-proto` ve `x-forwarded-host` başlıklarıyla geldiğinde Serve olarak değerlendirir.
Açık kimlik bilgileri gerektirmek için `gateway.auth.allowTailscale: false` ayarlayın veya
`gateway.auth.mode: "password"` kullanımını zorlayın.

## Yapılandırma örnekleri

### Yalnızca Tailnet (Serve)

```json5
{
  gateway: {
    bind: "loopback",
    tailscale: { mode: "serve" },
  },
}
```

Açın: `https://<magicdns>/` (veya yapılandırdığınız `gateway.controlUi.basePath`)

### Yalnızca Tailnet (Tailnet IP’ye bağlan)

Gateway’in doğrudan Tailnet IP’sini dinlemesini istediğinizde bunu kullanın (Serve/Funnel yok).

```json5
{
  gateway: {
    bind: "tailnet",
    auth: { mode: "token", token: "your-token" },
  },
}
```

Başka bir Tailnet cihazından bağlanın:

- Kontrol UI: `http://<tailscale-ip>:18789/`
- WebSocket: `ws://<tailscale-ip>:18789`

Not: Bu modda loopback (`http://127.0.0.1:18789`) **çalışmaz**.

### Herkese açık internet (Funnel + paylaşılan parola)

```json5
{
  gateway: {
    bind: "loopback",
    tailscale: { mode: "funnel" },
    auth: { mode: "password", password: "replace-me" },
  },
}
```

Parolayı diske yazmak yerine `OPENCLAW_GATEWAY_PASSWORD` tercih edin.

## CLI örnekleri

```bash
openclaw gateway --tailscale serve
openclaw gateway --tailscale funnel --auth password
```

## Notlar

- Tailscale Serve/Funnel, `tailscale` CLI’nin kurulu ve oturum açılmış olmasını gerektirir.
- `tailscale.mode: "funnel"`, herkese açık maruziyeti önlemek için kimlik doğrulama modu `password` değilse başlatmayı reddeder.
- Kapanışta OpenClaw’un `tailscale serve` veya `tailscale funnel` yapılandırmasını geri almasını istiyorsanız `gateway.tailscale.resetOnExit` ayarlayın.
- `gateway.bind: "tailnet"`, doğrudan Tailnet bağlamasıdır (HTTPS yok, Serve/Funnel yok).
- `gateway.bind: "auto"` loopback’i tercih eder; yalnızca Tailnet istiyorsanız `tailnet` kullanın.
- Serve/Funnel yalnızca **Gateway kontrol UI + WS**’yi açığa çıkarır. Düğümler aynı Gateway WS uç noktası üzerinden bağlanır; bu nedenle Serve, düğüm erişimi için de çalışabilir.

## Tarayıcı kontrolü (uzak Gateway + yerel tarayıcı)

Gateway’i bir makinede çalıştırıp tarayıcıyı başka bir makinede kullanmak istiyorsanız,
tarayıcı makinesinde bir **node host** çalıştırın ve her ikisini de aynı tailnet’te tutun.
Gateway, tarayıcı eylemlerini node’a proxy’ler; ayrı bir kontrol sunucusu veya Serve URL’si gerekmez.

Tarayıcı kontrolü için Funnel’dan kaçının; node eşleştirmeyi operatör erişimi gibi ele alın.

## Tailscale ön koşulları + sınırlamalar

- Serve, tailnet’iniz için HTTPS’in etkin olmasını gerektirir; eksikse CLI sizi yönlendirir.
- Serve, Tailscale kimlik başlıklarını enjekte eder; Funnel etmez.
- Funnel, Tailscale v1.38.3+, MagicDNS, HTTPS’in etkin olması ve bir funnel node özniteliği gerektirir.
- Funnel, TLS üzerinden yalnızca `443`, `8443` ve `10000` portlarını destekler.
- macOS’te Funnel, açık kaynaklı Tailscale uygulama varyantını gerektirir.

## Daha fazla bilgi

- Tailscale Serve genel bakış: [https://tailscale.com/kb/1312/serve](https://tailscale.com/kb/1312/serve)
- `tailscale serve` komutu: [https://tailscale.com/kb/1242/tailscale-serve](https://tailscale.com/kb/1242/tailscale-serve)
- Tailscale Funnel genel bakış: [https://tailscale.com/kb/1223/tailscale-funnel](https://tailscale.com/kb/1223/tailscale-funnel)
- `tailscale funnel` komutu: [https://tailscale.com/kb/1311/tailscale-funnel](https://tailscale.com/kb/1311/tailscale-funnel)
