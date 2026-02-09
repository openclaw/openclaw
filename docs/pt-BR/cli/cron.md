---
summary: "Referência da CLI para `openclaw cron` (agendar e executar jobs em segundo plano)"
read_when:
  - Você quer jobs e ativações agendadas
  - Você está depurando a execução e os logs do cron
title: "cron"
---

# `openclaw cron`

Gerencie jobs de cron para o agendador do Gateway.

Relacionado:

- Jobs de cron: [Jobs de cron](/automation/cron-jobs)

Dica: execute `openclaw cron --help` para ver toda a superfície de comandos.

Nota: jobs isolados `cron add` usam por padrão a entrega `--announce`. Use `--no-deliver` para manter a
saída interna. `--deliver` permanece como um alias obsoleto para `--announce`.

Nota: jobs de execução única (`--at`) são excluídos após o sucesso por padrão. Use `--keep-after-run` para mantê-los.

Nota: jobs recorrentes agora usam backoff exponencial de tentativas após erros consecutivos (30s → 1m → 5m → 15m → 60m) e, em seguida, retornam ao agendamento normal após a próxima execução bem-sucedida.

## Edições comuns

Atualize as configurações de entrega sem alterar a mensagem:

```bash
openclaw cron edit <job-id> --announce --channel telegram --to "123456789"
```

Desative a entrega para um job isolado:

```bash
openclaw cron edit <job-id> --no-deliver
```

Anuncie em um canal específico:

```bash
openclaw cron edit <job-id> --announce --channel slack --to "channel:C1234567890"
```
