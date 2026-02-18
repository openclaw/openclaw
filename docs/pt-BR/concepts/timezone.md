---
summary: "Tratamento de timezone para agentes, envelopes e prompts"
read_when:
  - Você precisa entender como timestamps são normalizados para o modelo
  - Configurando o timezone do usuário para system prompts
title: "Timezones"
---

# Timezones

OpenClaw padroniza timestamps para que o modelo veja um **tempo de referência único**.

## Envelopes de mensagem (local por padrão)

Mensagens de entrada são envoltas em um envelope como:

```
[Provider ... 2026-01-05 16:26 PST] message text
```

O timestamp no envelope é **host-local por padrão**, com precisão de minutos.

Você pode sobrescrever com:

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
- `envelopeTimezone: "user"` usa `agents.defaults.userTimezone` (volta para timezone de host).
- Use um timezone IANA explícito (ex. `"Europe/Vienna"`) para um offset fixo.
- `envelopeTimestamp: "off"` remove timestamps absolutos de headers de envelope.
- `envelopeElapsed: "off"` remove sufixos de tempo decorrido (o estilo `+2m`).

### Exemplos

**Local (padrão):**

```
[Signal Alice +1555 2026-01-18 00:19 PST] hello
```

**Timezone fixo:**

```
[Signal Alice +1555 2026-01-18 06:19 GMT+1] hello
```

**Tempo decorrido:**

```
[Signal Alice +1555 +2m 2026-01-18T05:19Z] follow-up
```

## Payloads de ferramenta (dados brutos de provedor + campos normalizados)

Chamadas de ferramenta (`channels.discord.readMessages`, `channels.slack.readMessages`, etc.) retornam **timestamps brutos de provedor**.
Também anexamos campos normalizados para consistência:

- `timestampMs` (UTC epoch milliseconds)
- `timestampUtc` (string ISO 8601 UTC)

Campos brutos de provedor são preservados.

## Timezone do usuário para o system prompt

Defina `agents.defaults.userTimezone` para dizer ao modelo o fuso horário local do usuário. Se não definido, OpenClaw resolve o **timezone de host em tempo de execução** (sem escrita de config).

```json5
{
  agents: { defaults: { userTimezone: "America/Chicago" } },
}
```
