---
summary: "Política de retry para chamadas de saída a provedores"
read_when:
  - Atualizando o comportamento ou os padrões de retry do provedor
  - Depurando erros de envio do provedor ou limites de taxa
title: "Política de Retry"
---

# Política de retry

## Objetivos

- Retentar por requisição HTTP, não por fluxo de múltiplas etapas.
- Preservar a ordem ao retentar apenas a etapa atual.
- Evitar duplicar operações não idempotentes.

## Padrões

- Tentativas: 3
- Limite máximo de atraso: 30000 ms
- Jitter: 0.1 (10 por cento)
- Padrões do provedor:
  - Atraso mínimo do Telegram: 400 ms
  - Atraso mínimo do Discord: 500 ms

## Comportamento

### Discord

- Retenta apenas em erros de limite de taxa (HTTP 429).
- Usa `retry_after` quando disponível; caso contrário, backoff exponencial.

### Telegram

- Retenta em erros transitórios (429, timeout, conectar/resetar/fechado, temporariamente indisponível).
- Usa `retry_after` quando disponível; caso contrário, backoff exponencial.
- Erros de parsing de Markdown não são retentados; fazem fallback para texto simples.

## Configuração

Defina a política de retry por provedor em `~/.openclaw/openclaw.json`:

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

- Retries se aplicam por requisição (envio de mensagem, upload de mídia, reação, enquete, sticker).
- Fluxos compostos não retentam etapas concluídas.
