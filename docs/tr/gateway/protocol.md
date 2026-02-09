---
summary: "Gateway WebSocket protokolü: el sıkışma, çerçeveler, sürümleme"
read_when:
  - Gateway WS istemcilerini uygularken veya güncellerken
  - Protokol uyuşmazlıklarını veya bağlantı hatalarını ayıklarken
  - Protokol şemasını/modellerini yeniden üretirken
title: "Gateway Protokolü"
---

# Gateway protokolü (WebSocket)

Gateway (Ağ Geçidi) WS protokolü, OpenClaw için **tek kontrol düzlemi + düğüm taşımasıdır**. Tüm istemciler (CLI, web UI, macOS uygulaması, iOS/Android düğümleri, başsız
düğümler) WebSocket üzerinden bağlanır ve el sıkışma sırasında **rol** +
**kapsam** bildirir.

## Taşıma

- WebSocket, JSON yükleri içeren metin çerçeveleri.
- İlk çerçeve **mutlaka** bir `connect` isteği olmalıdır.

## El sıkışma (bağlanma)

Gateway → İstemci (bağlantı öncesi meydan okuma):

```json
{
  "type": "event",
  "event": "connect.challenge",
  "payload": { "nonce": "…", "ts": 1737264000000 }
}
```

İstemci → Gateway:

```json
{
  "type": "req",
  "id": "…",
  "method": "connect",
  "params": {
    "minProtocol": 3,
    "maxProtocol": 3,
    "client": {
      "id": "cli",
      "version": "1.2.3",
      "platform": "macos",
      "mode": "operator"
    },
    "role": "operator",
    "scopes": ["operator.read", "operator.write"],
    "caps": [],
    "commands": [],
    "permissions": {},
    "auth": { "token": "…" },
    "locale": "en-US",
    "userAgent": "openclaw-cli/1.2.3",
    "device": {
      "id": "device_fingerprint",
      "publicKey": "…",
      "signature": "…",
      "signedAt": 1737264000000,
      "nonce": "…"
    }
  }
}
```

Gateway → İstemci:

```json
{
  "type": "res",
  "id": "…",
  "ok": true,
  "payload": { "type": "hello-ok", "protocol": 3, "policy": { "tickIntervalMs": 15000 } }
}
```

Bir cihaz belirteci verildiğinde, `hello-ok` ayrıca şunları içerir:

```json
{
  "auth": {
    "deviceToken": "…",
    "role": "operator",
    "scopes": ["operator.read", "operator.write"]
  }
}
```

### Düğüm örneği

```json
{
  "type": "req",
  "id": "…",
  "method": "connect",
  "params": {
    "minProtocol": 3,
    "maxProtocol": 3,
    "client": {
      "id": "ios-node",
      "version": "1.2.3",
      "platform": "ios",
      "mode": "node"
    },
    "role": "node",
    "scopes": [],
    "caps": ["camera", "canvas", "screen", "location", "voice"],
    "commands": ["camera.snap", "canvas.navigate", "screen.record", "location.get"],
    "permissions": { "camera.capture": true, "screen.record": false },
    "auth": { "token": "…" },
    "locale": "en-US",
    "userAgent": "openclaw-ios/1.2.3",
    "device": {
      "id": "device_fingerprint",
      "publicKey": "…",
      "signature": "…",
      "signedAt": 1737264000000,
      "nonce": "…"
    }
  }
}
```

## Çerçeveleme

- **İstek**: `{type:"req", id, method, params}`
- **Yanıt**: `{type:"res", id, ok, payload|error}`
- **Olay**: `{type:"event", event, payload, seq?, stateVersion?}`

Yan etkisi olan yöntemler **idempotency anahtarları** gerektirir (şemaya bakın).

## Roller + kapsamlar

### Roller

- `operator` = kontrol düzlemi istemcisi (CLI/UI/otomasyon).
- `node` = yetenek ana makinesi (kamera/ekran/tuval/system.run).

### Kapsamlar (operatör)

Yaygın kapsamlar:

- `operator.read`
- `operator.write`
- `operator.admin`
- `operator.approvals`
- `operator.pairing`

### Yetenekler/komutlar/izinler (düğüm)

Düğümler, bağlantı sırasında yetenek taleplerini bildirir:

- `caps`: üst düzey yetenek kategorileri.
- `commands`: çağırma için komut izin listesi.
- `permissions`: ayrıntılı anahtarlar (örn. `screen.record`, `camera.capture`).

Gateway (Ağ Geçidi) bunları **talepler** olarak ele alır ve sunucu tarafı izin listelerini uygular.

## Presence

- `system-presence`, cihaz kimliğine göre anahtarlanmış girdiler döndürür.
- Varlık girdileri `deviceId`, `roles` ve `scopes` içerir; böylece UI'lar,
  hem **operatör** hem de **düğüm** olarak bağlansa bile cihaz başına tek bir satır gösterebilir.

### Düğüm yardımcı yöntemleri

- Düğümler, otomatik izin kontrolleri için mevcut skill yürütülebilirlerinin
  listesini almak üzere `skills.bins` çağrısını yapabilir.

## Exec onayları

- Bir çalıştırma isteği onay gerektirdiğinde, gateway `exec.approval.requested` yayınlar.
- Operatör istemciler, `operator.approvals` kapsamını gerektiren `exec.approval.resolve` çağrısı ile çözer.

## Versioning

- `PROTOCOL_VERSION`, `src/gateway/protocol/schema.ts` içinde bulunur.
- İstemciler `minProtocol` + `maxProtocol` gönderir; sunucu uyuşmazlıkları reddeder.
- Şemalar + modeller TypeBox tanımlarından üretilir:
  - `pnpm protocol:gen`
  - `pnpm protocol:gen:swift`
  - `pnpm protocol:check`

## Kimlik doğrulama

- `OPENCLAW_GATEWAY_TOKEN` (veya `--token`) ayarlanmışsa, `connect.params.auth.token` eşleşmelidir;
  aksi halde soket kapatılır.
- Eşleştirmeden sonra Gateway (Ağ Geçidi), bağlantı rolü + kapsamlarına göre
  kapsamlandırılmış bir **cihaz belirteci** verir. Bu, `hello-ok.auth.deviceToken` içinde
  döndürülür ve gelecekteki bağlantılar için istemci tarafından kalıcı olarak saklanmalıdır.
- Cihaz belirteçleri `device.token.rotate` ve `device.token.revoke` üzerinden
  döndürülebilir/iptal edilebilir ( `operator.pairing` kapsamı gerektirir).

## Cihaz kimliği + eşleştirme

- Düğümler, anahtar çifti parmak izinden türetilmiş kararlı bir cihaz kimliği
  (`device.id`) eklemelidir.
- Gateway (Ağ Geçitleri), cihaz + rol başına belirteçler verir.
- Yerel otomatik onay etkin değilse, yeni cihaz kimlikleri için eşleştirme
  onayları gereklidir.
- **Yerel** bağlantılar loopback ve gateway ana makinesinin kendi tailnet
  adresini içerir (böylece aynı ana makinedeki tailnet bağları yine de
  otomatik onaylanabilir).
- Tüm WS istemcileri, `connect` sırasında `device` kimliğini
  (operatör + düğüm) içermelidir.
  Kontrol UI'ı, **yalnızca**
  `gateway.controlUi.allowInsecureAuth` etkin olduğunda (veya acil durum kullanımı için `gateway.controlUi.dangerouslyDisableDeviceAuth`)
  bunu atlayabilir.
- Yerel olmayan bağlantılar, sunucu tarafından sağlanan `connect.challenge` nonce'unu
  imzalamalıdır.

## TLS + sabitleme

- WS bağlantıları için TLS desteklenir.
- İstemciler, isteğe bağlı olarak gateway sertifika parmak izini sabitleyebilir
  ( `gateway.tls` yapılandırması ile birlikte `gateway.remote.tlsFingerprint` veya CLI `--tls-fingerprint`'ye bakın).

## Kapsam

Bu protokol **tam gateway API'sini** (durum, kanallar, modeller, sohbet,
ajan, oturumlar, düğümler, onaylar vb.) açığa çıkarır. Kesin yüzey,
`src/gateway/protocol/schema.ts` içindeki TypeBox şemaları tarafından tanımlanır.
