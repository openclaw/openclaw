---
summary: "Static host ng Loopback WebChat at paggamit ng Gateway WS para sa chat UI"
read_when:
  - Pag-debug o pag-configure ng access sa WebChat
title: "WebChat"
---

# WebChat (Gateway WebSocket UI)

Status: ang macOS/iOS SwiftUI chat UI ay direktang kumokonekta sa Gateway WebSocket.

## Ano ito

- Isang native na chat UI para sa Gateway (walang embedded browser at walang local static server).
- Ginagamit ang parehong mga session at routing rules gaya ng ibang mga channel.
- Deterministic routing: ang mga sagot ay palaging bumabalik sa WebChat.

## Mabilis na pagsisimula

1. Simulan ang Gateway.
2. Buksan ang WebChat UI (macOS/iOS app) o ang chat tab ng Control UI.
3. Tiyaking naka-configure ang Gateway auth (kinakailangan bilang default, kahit sa local loopback).

## Paano ito gumagana (behavior)

- Kumokonekta ang UI sa Gateway WebSocket at gumagamit ng `chat.history`, `chat.send`, at `chat.inject`.
- Ang `chat.inject` ay direktang nagdaragdag ng assistant note sa transcript at bina-broadcast ito sa UI (walang agent run).
- Palaging kinukuha ang history mula sa Gateway (walang local file watching).
- Kapag hindi maabot ang Gateway, read-only ang WebChat.

## Remote na paggamit

- Ang remote mode ay nagtu-tunnel ng Gateway WebSocket sa SSH/Tailscale.
- Hindi mo kailangang magpatakbo ng hiwalay na WebChat server.

## Reference ng konpigurasyon (WebChat)

Buong konpigurasyon: [Configuration](/gateway/configuration)

Mga opsyon ng channel:

- No dedicated `webchat.*` block. WebChat uses the gateway endpoint + auth settings below.

Kaugnay na mga global na opsyon:

- `gateway.port`, `gateway.bind`: WebSocket host/port.
- `gateway.auth.mode`, `gateway.auth.token`, `gateway.auth.password`: WebSocket auth.
- `gateway.remote.url`, `gateway.remote.token`, `gateway.remote.password`: remote Gateway target.
- `session.*`: session storage at mga default ng pangunahing key.
