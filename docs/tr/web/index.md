---
summary: "Gateway web yüzeyleri: Kontrol UI, bağlama modları ve güvenlik"
read_when:
  - Gateway’e Tailscale üzerinden erişmek istiyorsunuz
  - Tarayıcı Kontrol UI ve yapılandırma düzenlemeyi istiyorsunuz
title: "Web"
---

# Web (Gateway)

Gateway, Gateway WebSocket ile aynı porttan küçük bir **tarayıcı Kontrol UI** (Vite + Lit) sunar:

- varsayılan: `http://<host>:18789/`
- isteğe bağlı önek: `gateway.controlUi.basePath` ayarlayın (örn. `/openclaw`)

Yetenekler [Kontrol UI](/web/control-ui) içinde yer alır.
Bu sayfa bağlama modları, güvenlik ve web’e açık yüzeylere odaklanır.

## Webhook’lar

`hooks.enabled=true` olduğunda, Gateway aynı HTTP sunucusunda küçük bir webhook uç noktası da sunar.
Kimlik doğrulama ve yükler için [Gateway yapılandırması](/gateway/configuration) → `hooks` bölümüne bakın.

## Config (default-on)

Varlıklar mevcut olduğunda (`dist/control-ui`) Kontrol UI **varsayılan olarak etkindir**.
Yapılandırma ile denetleyebilirsiniz:

```json5
{
  gateway: {
    controlUi: { enabled: true, basePath: "/openclaw" }, // basePath optional
  },
}
```

## Tailscale erişimi

### Entegre Serve (önerilen)

Gateway’i loopback üzerinde tutun ve Tailscale Serve’in proxy’lemesine izin verin:

```json5
{
  gateway: {
    bind: "loopback",
    tailscale: { mode: "serve" },
  },
}
```

Ardından gateway’i başlatın:

```bash
openclaw gateway
```

Açın:

- `https://<magicdns>/` (veya yapılandırılmış `gateway.controlUi.basePath`)

### Tailnet bağlama + belirteç

```json5
{
  gateway: {
    bind: "tailnet",
    controlUi: { enabled: true },
    auth: { mode: "token", token: "your-token" },
  },
}
```

Ardından gateway’i başlatın (loopback olmayan bağlamalar için belirteç gerekir):

```bash
openclaw gateway
```

Açın:

- `http://<tailscale-ip>:18789/` (veya yapılandırılmış `gateway.controlUi.basePath`)

### Genel internet (Funnel)

```json5
{
  gateway: {
    bind: "loopback",
    tailscale: { mode: "funnel" },
    auth: { mode: "password" }, // or OPENCLAW_GATEWAY_PASSWORD
  },
}
```

## Güvenlik notları

- Gateway kimlik doğrulaması varsayılan olarak gereklidir (belirteç/parola veya Tailscale kimlik başlıkları).
- Loopback olmayan bağlamalar yine de **paylaşılan bir belirteç/parola** gerektirir (`gateway.auth` veya ortam değişkeni).
- Sihirbaz varsayılan olarak bir gateway belirteci üretir (loopback’te bile).
- UI, `connect.params.auth.token` veya `connect.params.auth.password` gönderir.
- Kontrol UI, anti-clickjacking başlıkları gönderir ve `gateway.controlUi.allowedOrigins` ayarlanmadıkça yalnızca aynı kaynaklı tarayıcı
  websocket bağlantılarını kabul eder.
- Serve ile, `gateway.auth.allowTailscale` `true` olduğunda Tailscale kimlik başlıkları kimlik doğrulamayı karşılayabilir
  (belirteç/parola gerekmez). Açık kimlik bilgilerini zorunlu kılmak için
  `gateway.auth.allowTailscale: false` ayarlayın. [Tailscale](/gateway/tailscale) ve [Güvenlik](/gateway/security) bölümlerine bakın.
- `gateway.tailscale.mode: "funnel"`, `gateway.auth.mode: "password"` (paylaşılan parola) gerektirir.

## UI’yi derleme

Gateway, statik dosyaları `dist/control-ui` konumundan sunar. Şu komutla derleyin:

```bash
pnpm ui:build # auto-installs UI deps on first run
```
