---
summary: "Gateway üzerinden OpenResponses uyumlu bir /v1/responses HTTP uç noktası sunar"
read_when:
  - OpenResponses API’sini konuşan istemcileri entegre ederken
  - Öğe tabanlı girdiler, istemci araç çağrıları veya SSE olayları istediğinizde
title: "OpenResponses API"
---

# OpenResponses API (HTTP)

OpenClaw’ın Gateway’i, OpenResponses uyumlu bir `POST /v1/responses` uç noktası sunabilir.

Bu uç nokta **varsayılan olarak devre dışıdır**. Önce yapılandırmada etkinleştirin.

- `POST /v1/responses`
- Gateway ile aynı port (WS + HTTP çoklama): `http://<gateway-host>:<port>/v1/responses`

Arka planda, istekler normal bir Gateway ajan çalıştırması olarak yürütülür (aynı kod yolu
`openclaw agent`), bu nedenle yönlendirme/izinler/yapılandırma Gateway’inizle eşleşir.

## Kimlik doğrulama

Gateway kimlik doğrulama yapılandırmasını kullanır. Bir bearer belirteci gönderin:

- `Authorization: Bearer <token>`

Notlar:

- `gateway.auth.mode="token"` olduğunda, `gateway.auth.token` (veya `OPENCLAW_GATEWAY_TOKEN`) kullanın.
- `gateway.auth.mode="password"` olduğunda, `gateway.auth.password` (veya `OPENCLAW_GATEWAY_PASSWORD`) kullanın.

## Choosing an agent

Özel başlıklara gerek yoktur: ajan kimliğini OpenResponses `model` alanında kodlayın:

- `model: "openclaw:<agentId>"` (örnek: `"openclaw:main"`, `"openclaw:beta"`)
- `model: "agent:<agentId>"` (takma ad)

Ya da bir başlıkla belirli bir OpenClaw ajanını hedefleyin:

- `x-openclaw-agent-id: <agentId>` (varsayılan: `main`)

Gelişmiş:

- Oturum yönlendirmesini tamamen kontrol etmek için `x-openclaw-session-key: <sessionKey>`.

## Uç noktayı etkinleştirme

`gateway.http.endpoints.responses.enabled` değerini `true` olarak ayarlayın:

```json5
{
  gateway: {
    http: {
      endpoints: {
        responses: { enabled: true },
      },
    },
  },
}
```

## Uç noktayı devre dışı bırakma

`gateway.http.endpoints.responses.enabled` değerini `false` olarak ayarlayın:

```json5
{
  gateway: {
    http: {
      endpoints: {
        responses: { enabled: false },
      },
    },
  },
}
```

## Oturum davranışı

Varsayılan olarak uç nokta **istek başına durumsuzdur** (her çağrıda yeni bir oturum anahtarı üretilir).

İstek bir OpenResponses `user` dizesi içeriyorsa, Gateway bundan kararlı bir oturum anahtarı türetir;
böylece yinelenen çağrılar bir ajan oturumunu paylaşabilir.

## İstek şekli (desteklenen)

İstek, öğe tabanlı girdilerle OpenResponses API’sini izler. Mevcut destek:

- `input`: dize veya öğe nesneleri dizisi.
- `instructions`: sistem istemine birleştirilir.
- `tools`: istemci araç tanımları (fonksiyon araçları).
- `tool_choice`: istemci araçlarını filtreler veya zorunlu kılar.
- `stream`: SSE akışını etkinleştirir.
- `max_output_tokens`: en iyi çaba çıktı sınırı (sağlayıcıya bağlı).
- `user`: kararlı oturum yönlendirmesi.

Kabul edilir ancak **şu anda yok sayılır**:

- `max_tool_calls`
- `reasoning`
- `metadata`
- `store`
- `previous_response_id`
- `truncation`

## Öğeler (girdi)

### `message`

Roller: `system`, `developer`, `user`, `assistant`.

- `system` ve `developer` sistem istemine eklenir.
- En güncel `user` veya `function_call_output` öğesi “geçerli mesaj” olur.
- Daha önceki kullanıcı/asistan mesajları bağlam için geçmişe dahil edilir.

### `function_call_output` (tur tabanlı araçlar)

Araç sonuçlarını modele geri gönderin:

```json
{
  "type": "function_call_output",
  "call_id": "call_123",
  "output": "{\"temperature\": \"72F\"}"
}
```

### `reasoning` ve `item_reference`

Şema uyumluluğu için kabul edilir ancak istem oluşturulurken yok sayılır.

## Araçlar (istemci tarafı fonksiyon araçları)

Araçları `tools: [{ type: "function", function: { name, description?, parameters? } }]` ile sağlayın.

Ajan bir araç çağırmaya karar verirse, yanıt bir `function_call` çıktı öğesi döndürür.
Ardından turu sürdürmek için `function_call_output` ile bir takip isteği gönderirsiniz.

## Görseller (`input_image`)

Base64 veya URL kaynaklarını destekler:

```json
{
  "type": "input_image",
  "source": { "type": "url", "url": "https://example.com/image.png" }
}
```

İzin verilen MIME türleri (güncel): `image/jpeg`, `image/png`, `image/gif`, `image/webp`.
Azami boyut (güncel): 10MB.

## Dosyalar (`input_file`)

Base64 veya URL kaynaklarını destekler:

```json
{
  "type": "input_file",
  "source": {
    "type": "base64",
    "media_type": "text/plain",
    "data": "SGVsbG8gV29ybGQh",
    "filename": "hello.txt"
  }
}
```

İzin verilen MIME türleri (güncel): `text/plain`, `text/markdown`, `text/html`, `text/csv`,
`application/json`, `application/pdf`.

Azami boyut (güncel): 5MB.

Mevcut davranış:

- Dosya içeriği çözülür ve kullanıcı mesajına değil **sistem istemine** eklenir;
  böylece geçici kalır (oturum geçmişinde kalıcı değildir).
- PDF’ler metin için ayrıştırılır. Az metin bulunursa, ilk sayfalar rasterleştirilir
  ve modele görsel olarak iletilir.

PDF ayrıştırma, Node uyumlu `pdfjs-dist` eski derlemesini (worker yok) kullanır. Modern
PDF.js derlemesi tarayıcı worker’ları/DOM küreselleri bekler; bu nedenle Gateway’de kullanılmaz.

URL getirme varsayılanları:

- `files.allowUrl`: `true`
- `images.allowUrl`: `true`
- İstekler korunur (DNS çözümleme, özel IP engelleme, yönlendirme sınırları, zaman aşımları).

## Dosya + görsel sınırları (yapılandırma)

Varsayılanlar `gateway.http.endpoints.responses` altında ayarlanabilir:

```json5
{
  gateway: {
    http: {
      endpoints: {
        responses: {
          enabled: true,
          maxBodyBytes: 20000000,
          files: {
            allowUrl: true,
            allowedMimes: [
              "text/plain",
              "text/markdown",
              "text/html",
              "text/csv",
              "application/json",
              "application/pdf",
            ],
            maxBytes: 5242880,
            maxChars: 200000,
            maxRedirects: 3,
            timeoutMs: 10000,
            pdf: {
              maxPages: 4,
              maxPixels: 4000000,
              minTextChars: 200,
            },
          },
          images: {
            allowUrl: true,
            allowedMimes: ["image/jpeg", "image/png", "image/gif", "image/webp"],
            maxBytes: 10485760,
            maxRedirects: 3,
            timeoutMs: 10000,
          },
        },
      },
    },
  },
}
```

Atlandığında varsayılanlar:

- `maxBodyBytes`: 20MB
- `files.maxBytes`: 5MB
- `files.maxChars`: 200k
- `files.maxRedirects`: 3
- `files.timeoutMs`: 10s
- `files.pdf.maxPages`: 4
- `files.pdf.maxPixels`: 4.000.000
- `files.pdf.minTextChars`: 200
- `images.maxBytes`: 10MB
- `images.maxRedirects`: 3
- `images.timeoutMs`: 10s

## Akış (SSE)

Server-Sent Events (SSE) almak için `stream: true` ayarlayın:

- `Content-Type: text/event-stream`
- Her olay satırı `event: <type>` ve `data: <json>` içerir
- Akış `data: [DONE]` ile biter

Şu anda yayımlanan olay türleri:

- `response.created`
- `response.in_progress`
- `response.output_item.added`
- `response.content_part.added`
- `response.output_text.delta`
- `response.output_text.done`
- `response.content_part.done`
- `response.output_item.done`
- `response.completed`
- `response.failed` (hata durumunda)

## Kullanım

Temel sağlayıcı belirteç sayımlarını bildirdiğinde `usage` doldurulur.

## Hatalar

Hatalar aşağıdaki gibi bir JSON nesnesi kullanır:

```json
{ "error": { "message": "...", "type": "invalid_request_error" } }
```

Yaygın durumlar:

- `401` eksik/geçersiz kimlik doğrulama
- `400` geçersiz istek gövdesi
- `405` yanlış yöntem

## Örnekler

Akışsız:

```bash
curl -sS http://127.0.0.1:18789/v1/responses \
  -H 'Authorization: Bearer YOUR_TOKEN' \
  -H 'Content-Type: application/json' \
  -H 'x-openclaw-agent-id: main' \
  -d '{
    "model": "openclaw",
    "input": "hi"
  }'
```

Akışlı:

```bash
curl -N http://127.0.0.1:18789/v1/responses \
  -H 'Authorization: Bearer YOUR_TOKEN' \
  -H 'Content-Type: application/json' \
  -H 'x-openclaw-agent-id: main' \
  -d '{
    "model": "openclaw",
    "stream": true,
    "input": "hi"
  }'
```
