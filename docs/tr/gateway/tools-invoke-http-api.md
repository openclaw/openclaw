---
summary: "Gateway HTTP uç noktası üzerinden tek bir aracı doğrudan çağırma"
read_when:
  - Tam bir ajan turu çalıştırmadan araçları çağırma
  - Araç politika zorunluluğu gerektiren otomasyonlar oluşturma
title: "Araçları Çağırma API'si"
---

# Araçları Çağırma (HTTP)

OpenClaw’ın Gateway’si, tek bir aracı doğrudan çağırmak için basit bir HTTP uç noktası sunar. Her zaman etkindir, ancak Gateway kimlik doğrulaması ve araç politikasıyla sınırlandırılmıştır.

- `POST /tools/invoke`
- Gateway ile aynı port (WS + HTTP çoklama): `http://<gateway-host>:<port>/tools/invoke`

Varsayılan maksimum yük boyutu 2 MB’dir.

## Kimlik doğrulama

Gateway kimlik doğrulama yapılandırmasını kullanır. Bir bearer token gönderin:

- `Authorization: Bearer <token>`

Notlar:

- `gateway.auth.mode="token"` olduğunda `gateway.auth.token` (veya `OPENCLAW_GATEWAY_TOKEN`) kullanın.
- `gateway.auth.mode="password"` olduğunda `gateway.auth.password` (veya `OPENCLAW_GATEWAY_PASSWORD`) kullanın.

## İstek gövdesi

```json
{
  "tool": "sessions_list",
  "action": "json",
  "args": {},
  "sessionKey": "main",
  "dryRun": false
}
```

Alanlar:

- `tool` (string, gerekli): çağrılacak araç adı.
- `action` (string, isteğe bağlı): araç şeması `action`’ü destekliyorsa ve args yükü bunu içermiyorsa, args içine eşlenir.
- `args` (object, isteğe bağlı): araca özgü argümanlar.
- `sessionKey` (string, isteğe bağlı): hedef oturum anahtarı. Atlanırsa veya `"main"` ise, Gateway yapılandırılmış ana oturum anahtarını kullanır (`session.mainKey` ve varsayılan ajanı dikkate alır ya da genel kapsamda `global`).
- `dryRun` (boolean, isteğe bağlı): gelecekte kullanım için ayrılmıştır; şu anda yok sayılır.

## Politika + yönlendirme davranışı

Araç kullanılabilirliği, Gateway ajanları tarafından kullanılan aynı politika zinciri üzerinden filtrelenir:

- `tools.profile` / `tools.byProvider.profile`
- `tools.allow` / `tools.byProvider.allow`
- `agents.<id>.tools.allow` / `agents.<id>.tools.byProvider.allow`
- grup politikaları (oturum anahtarı bir gruba veya kanala eşleniyorsa)
- Alt ajan politikası (bir alt ajan oturum anahtarıyla çağırırken)

Bir araç politika tarafından izinli değilse, uç nokta **404** döndürür.

Grup politikalarının bağlamı çözmesine yardımcı olmak için isteğe bağlı olarak şunları ayarlayabilirsiniz:

- `x-openclaw-message-channel: <channel>` (örnek: `slack`, `telegram`)
- `x-openclaw-account-id: <accountId>` (birden fazla hesap olduğunda)

## Yanıtlar

- `200` → `{ ok: true, result }`
- `400` → `{ ok: false, error: { type, message } }` (geçersiz istek veya araç hatası)
- `401` → yetkisiz
- `404` → araç kullanılamıyor (bulunamadı veya izin listesinde değil)
- `405` → yöntem izinli değil

## Örnek

```bash
curl -sS http://127.0.0.1:18789/tools/invoke \
  -H 'Authorization: Bearer YOUR_TOKEN' \
  -H 'Content-Type: application/json' \
  -d '{
    "tool": "sessions_list",
    "action": "json",
    "args": {}
  }'
```
