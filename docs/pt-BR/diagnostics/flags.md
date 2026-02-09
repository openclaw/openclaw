---
summary: "Flags de diagnóstico para logs de depuração direcionados"
read_when:
  - Você precisa de logs de depuração direcionados sem aumentar os níveis globais de logging
  - Você precisa capturar logs específicos de subsistemas para suporte
title: "Flags de Diagnóstico"
---

# Flags de Diagnóstico

As flags de diagnóstico permitem ativar logs de depuração direcionados sem ligar o logging verboso em todo o sistema. As flags são opt-in e não têm efeito a menos que um subsistema as verifique.

## Como funciona

- As flags são strings (não diferenciam maiúsculas de minúsculas).
- Você pode ativar flags na configuração ou via override por variável de ambiente.
- Curingas são suportados:
  - `telegram.*` corresponde a `telegram.http`
  - `*` habilita todas as flags

## Habilitar via configuração

```json
{
  "diagnostics": {
    "flags": ["telegram.http"]
  }
}
```

Múltiplas flags:

```json
{
  "diagnostics": {
    "flags": ["telegram.http", "gateway.*"]
  }
}
```

Reinicie o gateway após alterar as flags.

## Sobrescrita por env (pontual)

```bash
OPENCLAW_DIAGNOSTICS=telegram.http,telegram.payload
```

Desabilitar todas as flags:

```bash
OPENCLAW_DIAGNOSTICS=0
```

## Para onde os logs vão

As flags emitem logs no arquivo padrão de diagnósticos. Por padrão:

```
/tmp/openclaw/openclaw-YYYY-MM-DD.log
```

Se você definir `logging.file`, use esse caminho em vez disso. Os logs são JSONL (um objeto JSON por linha). A redação ainda se aplica com base em `logging.redactSensitive`.

## Extrair logs

Escolha o arquivo de log mais recente:

```bash
ls -t /tmp/openclaw/openclaw-*.log | head -n 1
```

Filtrar diagnósticos HTTP do Telegram:

```bash
rg "telegram http error" /tmp/openclaw/openclaw-*.log
```

Ou acompanhar em tempo real enquanto reproduz:

```bash
tail -f /tmp/openclaw/openclaw-$(date +%F).log | rg "telegram http error"
```

Para gateways remotos, você também pode usar `openclaw logs --follow` (veja [/cli/logs](/cli/logs)).

## Notas

- Se `logging.level` estiver definido mais alto que `warn`, esses logs podem ser suprimidos. O padrão `info` é adequado.
- É seguro deixar as flags habilitadas; elas afetam apenas o volume de logs do subsistema específico.
- Use [/logging](/logging) para alterar destinos de log, níveis e redação.
