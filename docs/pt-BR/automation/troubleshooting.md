---
summary: "Solucione problemas de agendamento e entrega de cron e heartbeat"
read_when:
  - Cron não foi executado
  - Cron foi executado, mas nenhuma mensagem foi entregue
  - Heartbeat parece silencioso ou ignorado
title: "Solução de problemas de automação"
---

# Solução de problemas de automação

Use esta página para problemas de agendamento e entrega (`cron` + `heartbeat`).

## Escada de comandos

```bash
openclaw status
openclaw gateway status
openclaw logs --follow
openclaw doctor
openclaw channels status --probe
```

Em seguida, execute as verificações de automação:

```bash
openclaw cron status
openclaw cron list
openclaw system heartbeat last
```

## Cron não dispara

```bash
openclaw cron status
openclaw cron list
openclaw cron runs --id <jobId> --limit 20
openclaw logs --follow
```

Uma boa saída se parece com:

- `cron status` reporta habilitado e um `nextWakeAtMs` futuro.
- O job está habilitado e tem um agendamento/fuso horário válido.
- `cron runs` mostra `ok` ou um motivo explícito de pulo.

Assinaturas comuns:

- `cron: scheduler disabled; jobs will not run automatically` → cron desabilitado na configuração/variáveis de ambiente.
- `cron: timer tick failed` → tick do agendador falhou; inspecione o contexto de pilha/logs ao redor.
- `reason: not-due` na saída de execução → execução manual chamada sem `--force` e o job ainda não estava devido.

## Cron disparou, mas não houve entrega

```bash
openclaw cron runs --id <jobId> --limit 20
openclaw cron list
openclaw channels status --probe
openclaw logs --follow
```

Uma boa saída se parece com:

- O status da execução é `ok`.
- O modo/alvo de entrega estão definidos para jobs isolados.
- A sonda do canal reporta o canal de destino conectado.

Assinaturas comuns:

- A execução teve sucesso, mas o modo de entrega é `none` → nenhuma mensagem externa é esperada.
- Alvo de entrega ausente/inválido (`channel`/`to`) → a execução pode ter sucesso internamente, mas pular a saída.
- Erros de autenticação do canal (`unauthorized`, `missing_scope`, `Forbidden`) → entrega bloqueada por credenciais/permissões do canal.

## Heartbeat suprimido ou ignorado

```bash
openclaw system heartbeat last
openclaw logs --follow
openclaw config get agents.defaults.heartbeat
openclaw channels status --probe
```

Uma boa saída se parece com:

- Heartbeat habilitado com intervalo diferente de zero.
- O último resultado de heartbeat é `ran` (ou o motivo do pulo é compreendido).

Assinaturas comuns:

- `heartbeat skipped` com `reason=quiet-hours` → fora de `activeHours`.
- `requests-in-flight` → pista principal ocupada; heartbeat adiado.
- `empty-heartbeat-file` → `HEARTBEAT.md` existe, mas não tem conteúdo acionável.
- `alerts-disabled` → configurações de visibilidade suprimem mensagens de heartbeat de saída.

## Pegadinhas de fuso horário e activeHours

```bash
openclaw config get agents.defaults.heartbeat.activeHours
openclaw config get agents.defaults.heartbeat.activeHours.timezone
openclaw config get agents.defaults.userTimezone || echo "agents.defaults.userTimezone not set"
openclaw cron list
openclaw logs --follow
```

Regras rápidas:

- `Config path not found: agents.defaults.userTimezone` significa que a chave não está definida; o heartbeat recorre ao fuso horário do host (ou `activeHours.timezone` se definido).
- Cron sem `--tz` usa o fuso horário do host do gateway.
- O `activeHours` do heartbeat usa a resolução de fuso horário configurada (`user`, `local` ou IANA explícito).
- Timestamps ISO sem fuso horário são tratados como UTC para agendamentos de cron `at`.

Assinaturas comuns:

- Jobs executam no horário de relógio errado após mudanças no fuso horário do host.
- Heartbeat sempre ignorado durante o seu período diurno porque `activeHours.timezone` está errado.

Relacionado:

- [/automation/cron-jobs](/automation/cron-jobs)
- [/gateway/heartbeat](/gateway/heartbeat)
- [/automation/cron-vs-heartbeat](/automation/cron-vs-heartbeat)
- [/concepts/timezone](/concepts/timezone)
