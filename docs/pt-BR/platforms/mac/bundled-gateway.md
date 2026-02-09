---
summary: "Runtime do Gateway no macOS (serviço launchd externo)"
read_when:
  - Empacotando o OpenClaw.app
  - Depurando o serviço launchd do Gateway no macOS
  - Instalando a CLI do gateway para macOS
title: "Gateway no macOS"
---

# Gateway no macOS (launchd externo)

O OpenClaw.app não inclui mais Node/Bun nem o runtime do Gateway. O app do macOS
espera uma instalação **externa** da CLI `openclaw`, não inicia o Gateway como
um processo filho e gerencia um serviço launchd por usuário para manter o Gateway
em execução (ou se conecta a um Gateway local existente, se já houver um em execução).

## Instale a CLI (obrigatório para o modo local)

Você precisa do Node 22+ no Mac e, em seguida, instalar `openclaw` globalmente:

```bash
npm install -g openclaw@<version>
```

O botão **Install CLI** do app macOS executa o mesmo fluxo via npm/pnpm (bun não é recomendado para o runtime do Gateway).

## Launchd (Gateway como LaunchAgent)

Rótulo:

- `bot.molt.gateway` (ou `bot.molt.<profile>`; o legado `com.openclaw.*` pode permanecer)

Local do plist (por usuário):

- `~/Library/LaunchAgents/bot.molt.gateway.plist`
  (ou `~/Library/LaunchAgents/bot.molt.<profile>.plist`)

Gerenciador:

- O app macOS é responsável pela instalação/atualização do LaunchAgent no modo Local.
- A CLI também pode instalá-lo: `openclaw gateway install`.

Comportamento:

- “OpenClaw Active” habilita/desabilita o LaunchAgent.
- Encerrar o app **não** interrompe o gateway (o launchd o mantém ativo).
- Se um Gateway já estiver em execução na porta configurada, o app se conecta a ele
  em vez de iniciar um novo.

Logs:

- stdout/err do launchd: `/tmp/openclaw/openclaw-gateway.log`

## Compatibilidade de versões

O app macOS verifica a versão do gateway em relação à sua própria versão. Se forem
incompatíveis, atualize a CLI global para corresponder à versão do app.

## Verificação de fumaça

```bash
openclaw --version

OPENCLAW_SKIP_CHANNELS=1 \
OPENCLAW_SKIP_CANVAS_HOST=1 \
openclaw gateway --port 18999 --bind loopback
```

Depois:

```bash
openclaw gateway call health --url ws://127.0.0.1:18999 --timeout 3000
```
