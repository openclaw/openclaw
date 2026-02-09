---
summary: "Tratamento de fuso horário para agentes, envelopes e prompts"
read_when:
  - Você precisa entender como os timestamps são normalizados para o modelo
  - Configurar o fuso horário do usuário para prompts do sistema
title: "Fusos horários"
---

# Fusos horários

O OpenClaw padroniza timestamps para que o modelo veja uma **única referência de tempo**.

## Envelopes de mensagem (local por padrão)

Mensagens de entrada são encapsuladas em um envelope como:

```
[Provider ... 2026-01-05 16:26 PST] message text
```

O timestamp no envelope é **local ao host por padrão**, com precisão de minutos.

Você pode substituir isso com:

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
- `envelopeTimezone: "user"` usa `agents.defaults.userTimezone` (retorna ao fuso horário do host).
- Use um fuso horário IANA explícito (por exemplo, `"Europe/Vienna"`) para um deslocamento fixo.
- `envelopeTimestamp: "off"` remove timestamps absolutos dos cabeçalhos do envelope.
- `envelopeElapsed: "off"` remove sufixos de tempo decorrido (o estilo `+2m`).

### Exemplos

**Local (padrão):**

```
[Signal Alice +1555 2026-01-18 00:19 PST] hello
```

**Fuso horário fixo:**

```
[Signal Alice +1555 2026-01-18 06:19 GMT+1] hello
```

**Tempo decorrido:**

```
[Signal Alice +1555 +2m 2026-01-18T05:19Z] follow-up
```

## Payloads de ferramentas (dados brutos do provedor + campos normalizados)

Chamadas de ferramentas (`channels.discord.readMessages`, `channels.slack.readMessages`, etc.) retornam **timestamps brutos do provedor**.
Também anexamos campos normalizados para consistência:

- `timestampMs` (milissegundos de época UTC)
- `timestampUtc` (string ISO 8601 UTC)

Os campos brutos do provedor são preservados.

## Fuso horário do usuário para o prompt do sistema

Defina `agents.defaults.userTimezone` para informar ao modelo o fuso horário local do usuário. Se estiver
não definido, o OpenClaw resolve o **fuso horário do host em tempo de execução** (sem gravar configuração).

```json5
{
  agents: { defaults: { userTimezone: "America/Chicago" } },
}
```

O prompt do sistema inclui:

- seção `Current Date & Time` com hora local e fuso horário
- `Time format: 12-hour` ou `24-hour`

Você pode controlar o formato do prompt com `agents.defaults.timeFormat` (`auto` | `12` | `24`).

Veja [Date & Time](/date-time) para o comportamento completo e exemplos.
