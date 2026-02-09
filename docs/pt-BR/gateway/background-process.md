---
summary: "Execução em segundo plano e gerenciamento de processos"
read_when:
  - Ao adicionar ou modificar o comportamento de exec em segundo plano
  - Ao depurar tarefas de exec de longa duração
title: "Exec em Segundo Plano e Ferramenta de Processo"
---

# Exec em Segundo Plano + Ferramenta de Processo

O OpenClaw executa comandos de shell por meio da ferramenta `exec` e mantém tarefas de longa duração na memória. A ferramenta `process` gerencia essas sessões em segundo plano.

## ferramenta exec

Parâmetros principais:

- `command` (obrigatório)
- `yieldMs` (padrão 10000): vai automaticamente para segundo plano após este atraso
- `background` (bool): executar imediatamente em segundo plano
- `timeout` (segundos, padrão 1800): encerra o processo após este tempo limite
- `elevated` (bool): executar no host se o modo elevado estiver habilitado/permitido
- Precisa de um TTY real? Defina `pty: true`.
- `workdir`, `env`

Comportamento:

- Execuções em primeiro plano retornam a saída diretamente.
- Quando vai para segundo plano (explícito ou por tempo limite), a ferramenta retorna `status: "running"` + `sessionId` e um pequeno trecho final.
- A saída é mantida na memória até que a sessão seja consultada (polled) ou limpa.
- Se a ferramenta `process` não for permitida, `exec` é executado de forma síncrona e ignora `yieldMs`/`background`.

## Ponte de processo filho

Ao iniciar processos filhos de longa duração fora das ferramentas exec/process (por exemplo, reinícios de CLI ou auxiliares do gateway), anexe o helper de ponte de processo filho para que sinais de término sejam encaminhados e os listeners sejam desacoplados na saída/erro. Isso evita processos órfãos no systemd e mantém o comportamento de desligamento consistente entre plataformas.

Sobrescritas de ambiente:

- `PI_BASH_YIELD_MS`: yield padrão (ms)
- `PI_BASH_MAX_OUTPUT_CHARS`: limite de saída em memória (caracteres)
- `OPENCLAW_BASH_PENDING_MAX_OUTPUT_CHARS`: limite de stdout/stderr pendente por stream (caracteres)
- `PI_BASH_JOB_TTL_MS`: TTL para sessões finalizadas (ms, limitado a 1m–3h)

Configuração (preferencial):

- `tools.exec.backgroundMs` (padrão 10000)
- `tools.exec.timeoutSec` (padrão 1800)
- `tools.exec.cleanupMs` (padrão 1800000)
- `tools.exec.notifyOnExit` (padrão true): enfileira um evento do sistema + solicita heartbeat quando um exec em segundo plano é encerrado.

## ferramenta process

Ações:

- `list`: sessões em execução + finalizadas
- `poll`: drenar nova saída de uma sessão (também informa o status de saída)
- `log`: ler a saída agregada (suporta `offset` + `limit`)
- `write`: enviar stdin (`data`, `eof` opcional)
- `kill`: encerrar uma sessão em segundo plano
- `clear`: remover uma sessão finalizada da memória
- `remove`: matar se estiver em execução; caso contrário, limpar se finalizada

Notas:

- Apenas sessões em segundo plano são listadas/persistidas na memória.
- As sessões são perdidas na reinicialização do processo (sem persistência em disco).
- Os logs da sessão só são salvos no histórico do chat se você executar `process poll/log` e o resultado da ferramenta for registrado.
- `process` tem escopo por agente; ele só vê sessões iniciadas por esse agente.
- `process list` inclui um `name` derivado (verbo do comando + alvo) para varreduras rápidas.
- `process log` usa `offset`/`limit` baseados em linha (omita `offset` para obter as últimas N linhas).

## Exemplos

Executar uma tarefa longa e consultar depois:

```json
{ "tool": "exec", "command": "sleep 5 && echo done", "yieldMs": 1000 }
```

```json
{ "tool": "process", "action": "poll", "sessionId": "<id>" }
```

Iniciar imediatamente em segundo plano:

```json
{ "tool": "exec", "command": "npm run build", "background": true }
```

Enviar stdin:

```json
{ "tool": "process", "action": "write", "sessionId": "<id>", "data": "y\n" }
```
