---
summary: "Comando de localização para nós (location.get), modos de permissão e comportamento em segundo plano"
read_when:
  - Adicionar suporte ao nó de localização ou UI de permissões
  - Projetar fluxos de localização em segundo plano + push
title: "Comando de Localização"
---

# Comando de localização (nós)

## TL;DR

- `location.get` é um comando de nó (via `node.invoke`).
- Desativado por padrão.
- As configurações usam um seletor: Desativado / Enquanto em uso / Sempre.
- Alternância separada: Localização precisa.

## Por que um seletor (não apenas um interruptor)

As permissões do SO são multinível. Podemos expor um seletor no app, mas o SO ainda decide a concessão real.

- iOS/macOS: o usuário pode escolher **Enquanto em uso** ou **Sempre** nos prompts/Configurações do sistema. O app pode solicitar upgrade, mas o SO pode exigir as Configurações.
- Android: localização em segundo plano é uma permissão separada; no Android 10+ geralmente requer um fluxo nas Configurações.
- Localização precisa é uma concessão separada (iOS 14+ “Precise”, Android “fine” vs “coarse”).

O seletor na UI define o modo solicitado; a concessão real fica nas configurações do SO.

## Modelo de configurações

Por dispositivo de nó:

- `location.enabledMode`: `off | whileUsing | always`
- `location.preciseEnabled`: bool

Comportamento da UI:

- Selecionar `whileUsing` solicita permissão em primeiro plano.
- Selecionar `always` primeiro garante `whileUsing`, depois solicita segundo plano (ou envia o usuário às Configurações, se necessário).
- Se o SO negar o nível solicitado, reverter para o nível mais alto concedido e mostrar o status.

## Mapeamento de permissões (node.permissions)

Opcional. O nó macOS reporta `location` via o mapa de permissões; iOS/Android podem omitir.

## Comando: `location.get`

Chamado via `node.invoke`.

Parâmetros (sugeridos):

```json
{
  "timeoutMs": 10000,
  "maxAgeMs": 15000,
  "desiredAccuracy": "coarse|balanced|precise"
}
```

Payload de resposta:

```json
{
  "lat": 48.20849,
  "lon": 16.37208,
  "accuracyMeters": 12.5,
  "altitudeMeters": 182.0,
  "speedMps": 0.0,
  "headingDeg": 270.0,
  "timestamp": "2026-01-03T12:34:56.000Z",
  "isPrecise": true,
  "source": "gps|wifi|cell|unknown"
}
```

Erros (códigos estáveis):

- `LOCATION_DISABLED`: seletor está desativado.
- `LOCATION_PERMISSION_REQUIRED`: permissão ausente para o modo solicitado.
- `LOCATION_BACKGROUND_UNAVAILABLE`: app está em segundo plano, mas apenas Enquanto em uso é permitido.
- `LOCATION_TIMEOUT`: sem fix a tempo.
- `LOCATION_UNAVAILABLE`: falha do sistema / sem provedores.

## Comportamento em segundo plano (futuro)

Objetivo: o modelo pode solicitar localização mesmo quando o nó está em segundo plano, mas apenas quando:

- O usuário selecionou **Sempre**.
- O sistema concede localização em segundo plano.
- O app tem permissão para rodar em segundo plano para localização (modo de segundo plano do iOS / serviço em primeiro plano do Android ou permissão especial).

Fluxo acionado por push (futuro):

1. O Gateway envia um push para o nó (push silencioso ou dados FCM).
2. O nó desperta brevemente e solicita a localização do dispositivo.
3. O nó encaminha o payload ao Gateway.

Notas:

- iOS: permissão Sempre + modo de localização em segundo plano são necessários. Push silencioso pode ser limitado; espere falhas intermitentes.
- Android: localização em segundo plano pode exigir um serviço em primeiro plano; caso contrário, espere negação.

## Integração com modelo/ferramentas

- Superfície de ferramentas: a ferramenta `nodes` adiciona a ação `location_get` (nó obrigatório).
- CLI: `openclaw nodes location get --node <id>`.
- Diretrizes do agente: chame apenas quando o usuário tiver habilitado a localização e entender o escopo.

## Cópia de UX (sugerida)

- Desativado: “O compartilhamento de localização está desativado.”
- Enquanto em uso: “Somente quando o OpenClaw estiver aberto.”
- Sempre: “Permitir localização em segundo plano. Requer permissão do sistema.”
- Precisa: “Usar localização GPS precisa. Desative para compartilhar localização aproximada.”
