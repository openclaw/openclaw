---
summary: "Ferramentas de depuração: modo de observação, streams brutos do modelo e rastreamento de vazamento de raciocínio"
read_when:
  - Voce precisa inspecionar a saída bruta do modelo para vazamento de raciocínio
  - Voce quer executar o Gateway em modo de observação enquanto itera
  - Voce precisa de um fluxo de trabalho de depuração reproduzível
title: "Depuração"
---

# Depuração

Esta página cobre auxiliares de depuração para saída em streaming, especialmente quando um
provedor mistura raciocínio no texto normal.

## Runtime de depuração substitui

Use `/debug` no chat para definir substituições de configuração **apenas em tempo de execução** (memória, não disco).
`/debug` vem desativado por padrão; habilite com `commands.debug: true`.
Isso é útil quando voce precisa alternar configurações obscuras sem editar `openclaw.json`.

Exemplos:

```
/debug show
/debug set messages.responsePrefix="[openclaw]"
/debug unset messages.responsePrefix
/debug reset
```

`/debug reset` limpa todas as substituições e retorna à configuração em disco.

## Modo de observação do Gateway

Para iteração rápida, execute o gateway sob o observador de arquivos:

```bash
pnpm gateway:watch --force
```

Isso mapeia para:

```bash
tsx watch src/entry.ts gateway --force
```

Adicione quaisquer flags de CLI do gateway após `gateway:watch` e elas serão repassadas
a cada reinício.

## Perfil dev + gateway dev (--dev)

Use o perfil dev para isolar o estado e subir uma configuração segura e descartável para
depuração. Existem **duas** flags `--dev`:

- **`--dev` global (perfil):** isola o estado em `~/.openclaw-dev` e
  define a porta do gateway como padrão para `19001` (portas derivadas mudam junto).
- **`gateway --dev`: diz ao Gateway para criar automaticamente uma configuração padrão +
  workspace** quando ausentes (e pular o BOOTSTRAP.md).

Fluxo recomendado (perfil dev + bootstrap dev):

```bash
pnpm gateway:dev
OPENCLAW_PROFILE=dev openclaw tui
```

Se voce ainda não tiver uma instalação global, execute a CLI via `pnpm openclaw ...`.

O que isso faz:

1. **Isolamento de perfil** (`--dev` global)
   - `OPENCLAW_PROFILE=dev`
   - `OPENCLAW_STATE_DIR=~/.openclaw-dev`
   - `OPENCLAW_CONFIG_PATH=~/.openclaw-dev/openclaw.json`
   - `OPENCLAW_GATEWAY_PORT=19001` (navegador/canvas mudam de acordo)

2. **Bootstrap dev** (`gateway --dev`)
   - Grava uma configuração mínima se ausente (`gateway.mode=local`, bind em loopback).
   - Define `agent.workspace` para o workspace dev.
   - Define `agent.skipBootstrap=true` (sem BOOTSTRAP.md).
   - Inicializa os arquivos do workspace se ausentes:
     `AGENTS.md`, `SOUL.md`, `TOOLS.md`, `IDENTITY.md`, `USER.md`, `HEARTBEAT.md`.
   - Identidade padrão: **C3‑PO** (droide de protocolo).
   - Ignora provedores de canal no modo dev (`OPENCLAW_SKIP_CHANNELS=1`).

Fluxo de reset (início do zero):

```bash
pnpm gateway:dev:reset
```

Nota: `--dev` é uma flag de perfil **global** e é consumida por alguns runners.
Se voce precisar explicitá-la, use a forma de variável de ambiente:

```bash
OPENCLAW_PROFILE=dev openclaw gateway --dev --reset
```

`--reset` apaga configuração, credenciais, sessões e o workspace dev (usando
`trash`, não `rm`), e então recria a configuração dev padrão.

Dica: se um gateway não-dev já estiver em execução (launchd/systemd), pare-o primeiro:

```bash
openclaw gateway stop
```

## Registro de stream bruto (OpenClaw)

O OpenClaw pode registrar o **stream bruto do assistente** antes de qualquer filtragem/formatação.
Esta é a melhor forma de ver se o raciocínio está chegando como deltas de texto simples
(ou como blocos de pensamento separados).

Habilite via CLI:

```bash
pnpm gateway:watch --force --raw-stream
```

Substituição opcional de caminho:

```bash
pnpm gateway:watch --force --raw-stream --raw-stream-path ~/.openclaw/logs/raw-stream.jsonl
```

Env equivalente variares:

```bash
OPENCLAW_RAW_STREAM=1
OPENCLAW_RAW_STREAM_PATH=~/.openclaw/logs/raw-stream.jsonl
```

Arquivo padrão:

`~/.openclaw/logs/raw-stream.jsonl`

## Registro de chunks brutos (pi-mono)

Para capturar **chunks brutos compatíveis com OpenAI** antes de serem analisados em blocos,
o pi-mono expõe um logger separado:

```bash
PI_RAW_STREAM=1
```

Caminho opcional:

```bash
PI_RAW_STREAM_PATH=~/.pi-mono/logs/raw-openai-completions.jsonl
```

Arquivo padrão:

`~/.pi-mono/logs/raw-openai-completions.jsonl`

> Nota: isso é emitido apenas por processos que usam o provedor
> `openai-completions` do pi-mono.

## Notas de segurança

- Logs de stream bruto podem incluir prompts completos, saída de ferramentas e dados do usuário.
- Mantenha os logs locais e exclua-os após a depuração.
- Se compartilhar logs, remova segredos e PII primeiro.
