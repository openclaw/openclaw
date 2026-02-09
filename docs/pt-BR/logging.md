---
summary: "Visão geral de logging: logs em arquivo, saída no console, tail via CLI e a UI de Controle"
read_when:
  - Você precisa de uma visão geral de logging amigável para iniciantes
  - Você quer configurar níveis ou formatos de log
  - Você está solucionando problemas e precisa encontrar logs rapidamente
title: "Logging"
---

# Logging

O OpenClaw registra logs em dois lugares:

- **Logs em arquivo** (linhas JSON) gravados pelo Gateway.
- **Saída no console** exibida em terminais e na UI de Controle.

Esta página explica onde os logs ficam, como lê-los e como configurar níveis e
formatos de log.

## Onde os logs ficam

Por padrão, o Gateway grava um arquivo de log rotativo em:

`/tmp/openclaw/openclaw-YYYY-MM-DD.log`

A data usa o fuso horário local do host do gateway.

Você pode sobrescrever isso em `~/.openclaw/openclaw.json`:

```json
{
  "logging": {
    "file": "/path/to/openclaw.log"
  }
}
```

## Como ler os logs

### CLI: tail ao vivo (recomendado)

Use a CLI para fazer tail do arquivo de log do gateway via RPC:

```bash
openclaw logs --follow
```

Modos de saída:

- **Sessões TTY**: linhas de log estruturadas, bonitas e coloridas.
- **Sessões não TTY**: texto simples.
- `--json`: JSON delimitado por linhas (um evento de log por linha).
- `--plain`: força texto simples em sessões TTY.
- `--no-color`: desativa cores ANSI.

No modo JSON, a CLI emite objetos marcados com `type`:

- `meta`: metadados do stream (arquivo, cursor, tamanho)
- `log`: entrada de log analisada
- `notice`: dicas de truncamento / rotação
- `raw`: linha de log não analisada

Se o Gateway estiver inacessível, a CLI imprime uma dica curta para executar:

```bash
openclaw doctor
```

### UI de Controle (web)

A aba **Logs** da UI de Controle faz tail do mesmo arquivo usando `logs.tail`.
Veja [/web/control-ui](/web/control-ui) para saber como abri-la.

### Logs somente por canal

Para filtrar a atividade por canal (WhatsApp/Telegram/etc), use:

```bash
openclaw channels logs --channel whatsapp
```

## Formatos de log

### Logs em arquivo (JSONL)

Cada linha no arquivo de log é um objeto JSON. A CLI e a UI de Controle analisam
essas entradas para renderizar saída estruturada (tempo, nível, subsistema,
mensagem).

### Saída no console

Os logs do console são **cientes de TTY** e formatados para legibilidade:

- Prefixos de subsistema (ex.: `gateway/channels/whatsapp`)
- Coloração por nível (info/warn/error)
- Modo compacto opcional ou JSON

A formatação do console é controlada por `logging.consoleStyle`.

## Configurando o logging

Toda a configuração de logging fica sob `logging` em `~/.openclaw/openclaw.json`.

```json
{
  "logging": {
    "level": "info",
    "file": "/tmp/openclaw/openclaw-YYYY-MM-DD.log",
    "consoleLevel": "info",
    "consoleStyle": "pretty",
    "redactSensitive": "tools",
    "redactPatterns": ["sk-.*"]
  }
}
```

### Níveis de log

- `logging.level`: nível dos **logs em arquivo** (JSONL).
- `logging.consoleLevel`: nível de verbosidade do **console**.

`--verbose` afeta apenas a saída no console; não altera os níveis dos logs em arquivo.

### Estilos de console

`logging.consoleStyle`:

- `pretty`: amigável para humanos, colorido, com timestamps.
- `compact`: saída mais enxuta (melhor para sessões longas).
- `json`: JSON por linha (para processadores de log).

### Redação

Resumos de ferramentas podem redigir tokens sensíveis antes de chegarem ao console:

- `logging.redactSensitive`: `off` | `tools` (padrão: `tools`)
- `logging.redactPatterns`: lista de strings regex para sobrescrever o conjunto padrão

A redação afeta **apenas a saída no console** e não altera os logs em arquivo.

## Diagnósticos + OpenTelemetry

Diagnósticos são eventos estruturados e legíveis por máquina para execuções de
modelo **e** telemetria de fluxo de mensagens (webhooks, enfileiramento, estado
de sessão). Eles **não** substituem logs; existem para alimentar métricas,
traces e outros exporters.

Eventos de diagnóstico são emitidos em-processo, mas exporters só se conectam
quando diagnósticos + o plugin exporter estão habilitados.

### OpenTelemetry vs OTLP

- **OpenTelemetry (OTel)**: o modelo de dados + SDKs para traces, métricas e logs.
- **OTLP**: o protocolo de transporte usado para exportar dados OTel para um
  coletor/backend.
- O OpenClaw exporta via **OTLP/HTTP (protobuf)** atualmente.

### Sinais exportados

- **Métricas**: contadores + histogramas (uso de tokens, fluxo de mensagens,
  enfileiramento).
- **Traces**: spans para uso de modelo + processamento de webhook/mensagem.
- **Logs**: exportados via OTLP quando `diagnostics.otel.logs` está habilitado. O volume
  de logs pode ser alto; leve em conta `logging.level` e filtros do exporter.

### Catálogo de eventos de diagnóstico

Uso de modelo:

- `model.usage`: tokens, custo, duração, contexto, provedor/modelo/canal,
  ids de sessão.

Fluxo de mensagens:

- `webhook.received`: ingresso de webhook por canal.
- `webhook.processed`: webhook tratado + duração.
- `webhook.error`: erros do handler de webhook.
- `message.queued`: mensagem enfileirada para processamento.
- `message.processed`: resultado + duração + erro opcional.

Fila + sessão:

- `queue.lane.enqueue`: enfileiramento em faixa da fila de comandos + profundidade.
- `queue.lane.dequeue`: desenfileiramento da faixa da fila de comandos + tempo de espera.
- `session.state`: transição de estado de sessão + motivo.
- `session.stuck`: aviso de sessão travada + idade.
- `run.attempt`: metadados de tentativa/reexecução.
- `diagnostic.heartbeat`: contadores agregados (webhooks/fila/sessão).

### Habilitar diagnósticos (sem exporter)

Use isto se você quiser eventos de diagnóstico disponíveis para plugins ou
destinos personalizados:

```json
{
  "diagnostics": {
    "enabled": true
  }
}
```

### Flags de diagnóstico (logs direcionados)

Use flags para ativar logs de debug extras e direcionados sem aumentar
`logging.level`.
As flags não diferenciam maiúsculas/minúsculas e suportam
curingas (ex.: `telegram.*` ou `*`).

```json
{
  "diagnostics": {
    "flags": ["telegram.http"]
  }
}
```

Sobrescrita por env (pontual):

```
OPENCLAW_DIAGNOSTICS=telegram.http,telegram.payload
```

Notas:

- Logs de flags vão para o arquivo de log padrão (o mesmo de `logging.file`).
- A saída ainda é redigida de acordo com `logging.redactSensitive`.
- Guia completo: [/diagnostics/flags](/diagnostics/flags).

### Exportar para OpenTelemetry

Os diagnósticos podem ser exportados via o plugin `diagnostics-otel` (OTLP/HTTP). Isso funciona com qualquer coletor/backend OpenTelemetry que aceite OTLP/HTTP.

```json
{
  "plugins": {
    "allow": ["diagnostics-otel"],
    "entries": {
      "diagnostics-otel": {
        "enabled": true
      }
    }
  },
  "diagnostics": {
    "enabled": true,
    "otel": {
      "enabled": true,
      "endpoint": "http://otel-collector:4318",
      "protocol": "http/protobuf",
      "serviceName": "openclaw-gateway",
      "traces": true,
      "metrics": true,
      "logs": true,
      "sampleRate": 0.2,
      "flushIntervalMs": 60000
    }
  }
}
```

Notas:

- Você também pode habilitar o plugin com `openclaw plugins enable diagnostics-otel`.
- `protocol` atualmente suporta apenas `http/protobuf`. `grpc` é ignorado.
- As métricas incluem uso de tokens, custo, tamanho de contexto, duração da
  execução e contadores/histogramas de fluxo de mensagens (webhooks,
  enfileiramento, estado de sessão, profundidade/espera da fila).
- Traces/métricas podem ser ativados/desativados com `traces` /
  `metrics` (padrão: ligado). Traces incluem spans de uso de modelo
  mais spans de processamento de webhook/mensagem quando habilitados.
- Defina `headers` quando seu coletor exigir autenticação.
- Variáveis de ambiente suportadas: `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_SERVICE_NAME`,
  `OTEL_EXPORTER_OTLP_PROTOCOL`.

### Métricas exportadas (nomes + tipos)

Uso de modelo:

- `openclaw.tokens` (contador, attrs: `openclaw.token`, `openclaw.channel`,
  `openclaw.provider`, `openclaw.model`)
- `openclaw.cost.usd` (contador, attrs: `openclaw.channel`, `openclaw.provider`,
  `openclaw.model`)
- `openclaw.run.duration_ms` (histograma, attrs: `openclaw.channel`,
  `openclaw.provider`, `openclaw.model`)
- `openclaw.context.tokens` (histograma, attrs: `openclaw.context`,
  `openclaw.channel`, `openclaw.provider`, `openclaw.model`)

Fluxo de mensagens:

- `openclaw.webhook.received` (contador, attrs: `openclaw.channel`,
  `openclaw.webhook`)
- `openclaw.webhook.error` (contador, attrs: `openclaw.channel`,
  `openclaw.webhook`)
- `openclaw.webhook.duration_ms` (histograma, attrs: `openclaw.channel`,
  `openclaw.webhook`)
- `openclaw.message.queued` (contador, attrs: `openclaw.channel`,
  `openclaw.source`)
- `openclaw.message.processed` (contador, attrs: `openclaw.channel`,
  `openclaw.outcome`)
- `openclaw.message.duration_ms` (histograma, attrs: `openclaw.channel`,
  `openclaw.outcome`)

Filas + sessões:

- `openclaw.queue.lane.enqueue` (contador, attrs: `openclaw.lane`)
- `openclaw.queue.lane.dequeue` (contador, attrs: `openclaw.lane`)
- `openclaw.queue.depth` (histograma, attrs: `openclaw.lane` ou
  `openclaw.channel=heartbeat`)
- `openclaw.queue.wait_ms` (histograma, attrs: `openclaw.lane`)
- `openclaw.session.state` (contador, attrs: `openclaw.state`, `openclaw.reason`)
- `openclaw.session.stuck` (contador, attrs: `openclaw.state`)
- `openclaw.session.stuck_age_ms` (histograma, attrs: `openclaw.state`)
- `openclaw.run.attempt` (contador, attrs: `openclaw.attempt`)

### Spans exportados (nomes + principais atributos)

- `openclaw.model.usage`
  - `openclaw.channel`, `openclaw.provider`, `openclaw.model`
  - `openclaw.sessionKey`, `openclaw.sessionId`
  - `openclaw.tokens.*` (input/output/cache_read/cache_write/total)
- `openclaw.webhook.processed`
  - `openclaw.channel`, `openclaw.webhook`, `openclaw.chatId`
- `openclaw.webhook.error`
  - `openclaw.channel`, `openclaw.webhook`, `openclaw.chatId`,
    `openclaw.error`
- `openclaw.message.processed`
  - `openclaw.channel`, `openclaw.outcome`, `openclaw.chatId`,
    `openclaw.messageId`, `openclaw.sessionKey`, `openclaw.sessionId`,
    `openclaw.reason`
- `openclaw.session.stuck`
  - `openclaw.state`, `openclaw.ageMs`, `openclaw.queueDepth`,
    `openclaw.sessionKey`, `openclaw.sessionId`

### Amostragem + flush

- Amostragem de traces: `diagnostics.otel.sampleRate` (0.0–1.0, apenas spans raiz).
- Intervalo de exportação de métricas: `diagnostics.otel.flushIntervalMs` (mín. 1000ms).

### Notas de protocolo

- Endpoints OTLP/HTTP podem ser definidos via `diagnostics.otel.endpoint` ou
  `OTEL_EXPORTER_OTLP_ENDPOINT`.
- Se o endpoint já contiver `/v1/traces` ou `/v1/metrics`, ele é usado como está.
- Se o endpoint já contiver `/v1/logs`, ele é usado como está para logs.
- `diagnostics.otel.logs` habilita a exportação de logs OTLP para a saída do logger principal.

### Comportamento da exportação de logs

- Logs OTLP usam os mesmos registros estruturados gravados em `logging.file`.
- Respeitam `logging.level` (nível de log em arquivo). A redação do console **não**
  se aplica aos logs OTLP.
- Instalações de alto volume devem preferir amostragem/filtragem no coletor OTLP.

## Dicas de solução de problemas

- **Gateway não alcançável?** Execute `openclaw doctor` primeiro.
- **Logs vazios?** Verifique se o Gateway está em execução e gravando no caminho
  do arquivo em `logging.file`.
- **Precisa de mais detalhes?** Defina `logging.level` como `debug` ou
  `trace` e tente novamente.
