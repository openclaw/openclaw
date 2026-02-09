---
summary: "Tratamento de data e hora em envelopes, prompts, ferramentas e conectores"
read_when:
  - Você está alterando como os timestamps são mostrados ao modelo ou aos usuários
  - Você está depurando a formatação de horário em mensagens ou na saída do prompt do sistema
title: "Data e Hora"
---

# Data & Hora

O OpenClaw usa por padrão **hora local do host para timestamps de transporte** e **fuso horário do usuário apenas no prompt do sistema**.
Os timestamps do provedor são preservados para que as ferramentas mantenham suas semânticas nativas (o horário atual está disponível via `session_status`).

## Envelopes de mensagem (local por padrão)

Mensagens de entrada são envolvidas com um timestamp (precisão de minuto):

```
[Provider ... 2026-01-05 16:26 PST] message text
```

Esse timestamp do envelope é **local ao host por padrão**, independentemente do fuso horário do provedor.

Você pode substituir esse comportamento:

```json5
{
  agents: {
    defaults: {
      envelopeTimezone: "local", // "utc" | "local" | "user" | IANA timezone
      envelopeTimestamp: "on", // "on" | "off"
      envelopeElapsed: "on", // "on" | "off"
    },
  },
}
```

- `envelopeTimezone: "utc"` usa UTC.
- `envelopeTimezone: "local"` usa o fuso horário do host.
- `envelopeTimezone: "user"` usa `agents.defaults.userTimezone` (volta para o fuso horário do host).
- Use um fuso horário IANA explícito (por exemplo, `"America/Chicago"`) para uma zona fixa.
- `envelopeTimestamp: "off"` remove timestamps absolutos dos cabeçalhos do envelope.
- `envelopeElapsed: "off"` remove sufixos de tempo decorrido (o estilo `+2m`).

### Exemplos

**Local (padrão):**

```
[WhatsApp +1555 2026-01-18 00:19 PST] hello
```

**Fuso horário do usuário:**

```
[WhatsApp +1555 2026-01-18 00:19 CST] hello
```

**Tempo decorrido habilitado:**

```
[WhatsApp +1555 +30s 2026-01-18T05:19Z] follow-up
```

## Prompt do sistema: Data & Hora atuais

Se o fuso horário do usuário for conhecido, o prompt do sistema inclui uma seção dedicada
**Data & Hora atuais** apenas com o **fuso horário** (sem relógio/formato de hora)
para manter o cache do prompt estável:

```
Time zone: America/Chicago
```

Quando o agente precisa do horário atual, use a ferramenta `session_status`; o cartão
de status inclui uma linha de timestamp.

## Linhas de eventos do sistema (local por padrão)

Eventos de sistema enfileirados inseridos no contexto do agente são prefixados com um timestamp usando a
mesma seleção de fuso horário dos envelopes de mensagem (padrão: local do host).

```
System: [2026-01-12 12:19:17 PST] Model switched.
```

### Configurar fuso horário do usuário + formato

```json5
{
  agents: {
    defaults: {
      userTimezone: "America/Chicago",
      timeFormat: "auto", // auto | 12 | 24
    },
  },
}
```

- `userTimezone` define o **fuso horário local do usuário** para o contexto do prompt.
- `timeFormat` controla a **exibição 12h/24h** no prompt. `auto` segue as preferências do SO.

## Detecção de formato de hora (automática)

Quando `timeFormat: "auto"`, o OpenClaw inspeciona a preferência do SO (macOS/Windows)
e recorre à formatação por localidade. O valor detectado é **armazenado em cache por processo**
para evitar chamadas repetidas ao sistema.

## Cargas de ferramentas + conectores (hora bruta do provedor + campos normalizados)

As ferramentas de canal retornam **timestamps nativos do provedor** e adicionam campos normalizados para consistência:

- `timestampMs`: milissegundos desde a época (UTC)
- `timestampUtc`: string ISO 8601 em UTC

Os campos brutos do provedor são preservados para que nada seja perdido.

- Slack: strings semelhantes a epoch da API
- Discord: timestamps ISO em UTC
- Telegram/WhatsApp: timestamps numéricos/ISO específicos do provedor

Se você precisar de hora local, converta-a posteriormente usando o fuso horário conhecido.

## Documentos relacionados

- [Prompt do sistema](/concepts/system-prompt)
- [Fusos horários](/concepts/timezone)
- [Mensagens](/concepts/messages)
