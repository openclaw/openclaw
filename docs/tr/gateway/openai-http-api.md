---
summary: "Gateway üzerinden OpenAI uyumlu bir /v1/chat/completions HTTP uç noktası sunun"
read_when:
  - OpenAI Chat Completions bekleyen araçları entegre ederken
title: "OpenAI Chat Completions"
---

# OpenAI Chat Completions (HTTP)

OpenClaw’ın Gateway’i, OpenAI uyumlu küçük bir Chat Completions uç noktası sunabilir.

Bu uç nokta **varsayılan olarak devre dışıdır**. Önce yapılandırmada etkinleştirin.

- `POST /v1/chat/completions`
- Gateway ile aynı port (WS + HTTP çoklama): `http://<gateway-host>:<port>/v1/chat/completions`

Arka planda istekler, normal bir Gateway ajan çalıştırması olarak yürütülür (`openclaw agent` ile aynı kod yolu), bu nedenle yönlendirme/izinler/yapılandırma Gateway’inizle uyumludur.

## Kimlik doğrulama

Gateway kimlik doğrulama yapılandırmasını kullanır. Bir bearer token gönderin:

- `Authorization: Bearer <token>`

Notlar:

- `gateway.auth.mode="token"` olduğunda, `gateway.auth.token` (veya `OPENCLAW_GATEWAY_TOKEN`) kullanın.
- `gateway.auth.mode="password"` olduğunda, `gateway.auth.password` (veya `OPENCLAW_GATEWAY_PASSWORD`) kullanın.

## Choosing an agent

Özel başlıklar gerekmez: ajan kimliğini OpenAI `model` alanında kodlayın:

- `model: "openclaw:<agentId>"` (örnek: `"openclaw:main"`, `"openclaw:beta"`)
- `model: "agent:<agentId>"` (takma ad)

Veya bir başlıkla belirli bir OpenClaw ajanını hedefleyin:

- `x-openclaw-agent-id: <agentId>` (varsayılan: `main`)

Gelişmiş:

- Oturum yönlendirmesini tamamen kontrol etmek için `x-openclaw-session-key: <sessionKey>`.

## Uç noktayı etkinleştirme

`gateway.http.endpoints.chatCompletions.enabled` değerini `true` olarak ayarlayın:

```json5
{
  gateway: {
    http: {
      endpoints: {
        chatCompletions: { enabled: true },
      },
    },
  },
}
```

## Uç noktayı devre dışı bırakma

`gateway.http.endpoints.chatCompletions.enabled` değerini `false` olarak ayarlayın:

```json5
{
  gateway: {
    http: {
      endpoints: {
        chatCompletions: { enabled: false },
      },
    },
  },
}
```

## Oturum davranışı

Varsayılan olarak uç nokta **istek başına durumsuzdur** (her çağrıda yeni bir oturum anahtarı oluşturulur).

İstek bir OpenAI `user` dizesi içeriyorsa, Gateway bundan kararlı bir oturum anahtarı türetir; böylece tekrarlanan çağrılar bir ajan oturumunu paylaşabilir.

## Akış (SSE)

Server-Sent Events (SSE) almak için `stream: true` ayarlayın:

- `Content-Type: text/event-stream`
- Her olay satırı `data: <json>`’dir
- Akış `data: [DONE]` ile sona erer

## Örnekler

Akışsız:

```bash
curl -sS http://127.0.0.1:18789/v1/chat/completions \
  -H 'Authorization: Bearer YOUR_TOKEN' \
  -H 'Content-Type: application/json' \
  -H 'x-openclaw-agent-id: main' \
  -d '{
    "model": "openclaw",
    "messages": [{"role":"user","content":"hi"}]
  }'
```

Akışlı:

```bash
curl -N http://127.0.0.1:18789/v1/chat/completions \
  -H 'Authorization: Bearer YOUR_TOKEN' \
  -H 'Content-Type: application/json' \
  -H 'x-openclaw-agent-id: main' \
  -d '{
    "model": "openclaw",
    "stream": true,
    "messages": [{"role":"user","content":"hi"}]
  }'
```
