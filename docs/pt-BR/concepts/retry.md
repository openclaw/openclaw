---
summary: "Política de retry para chamadas de provedor outbound"
read_when:
  - Atualizando comportamento de retry de provedor ou padrões
  - Debugando erros de envio de provedor ou rate limits
title: "Política de Retry"
---

# Política de retry

## Objetivos

- Retry por requisição HTTP, não por fluxo multi-passo.
- Preservar ordenação retentando apenas o passo atual.
- Evitar duplicar operações não-idempotentes.

## Padrões

- Tentativas: 3
- Max delay cap: 30000 ms
- Jitter: 0.1 (10 percent)
- Padrões de provedor:
  - Telegram min delay: 400 ms
  - Discord min delay: 500 ms

## Comportamento

### Discord

- Retries apenas em erros de rate-limit (HTTP 429).
- Usa Discord `retry_after` quando disponível, caso contrário exponential backoff.

### Telegram

- Retries em erros transitórios (429, timeout, connect/reset/closed, temporarily unavailable).
- Usa `retry_after` quando disponível, caso contrário exponential backoff.
- Erros de parse de Markdown não são retried; eles caem de volta para texto plano.

## Configuração

Defina política de retry por provedor em `~/.openclaw/openclaw.json`:

```json5
{
  channels: {
    telegram: {
      retry: {
        attempts: 3,
        minDelayMs: 400,
        maxDelayMs: 30000,
        jitter: 0.1,
      },
    },
    discord: {
      retry: {
        attempts: 3,
        minDelayMs: 500,
        maxDelayMs: 30000,
        jitter: 0.1,
      },
    },
  },
}
```

## Notas

- Retries se aplicam por requisição (message send, media upload, reaction, poll, sticker).
- Fluxos compostos não reentam passos completados.
