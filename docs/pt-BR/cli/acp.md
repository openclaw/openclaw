---
summary: "Execute a ponte ACP para integrações com IDEs"
read_when:
  - Configurando integrações de IDE baseadas em ACP
  - Depurando o roteamento de sessões ACP para o Gateway
title: "acp"
---

# acp

Execute a ponte ACP (Agent Client Protocol) que se comunica com um OpenClaw Gateway.

Este comando fala ACP via stdio para IDEs e encaminha prompts para o Gateway
via WebSocket. Ele mantém as sessões ACP mapeadas para chaves de sessão do Gateway.

## Uso

```bash
openclaw acp

# Remote Gateway
openclaw acp --url wss://gateway-host:18789 --token <token>

# Attach to an existing session key
openclaw acp --session agent:main:main

# Attach by label (must already exist)
openclaw acp --session-label "support inbox"

# Reset the session key before the first prompt
openclaw acp --session agent:main:main --reset-session
```

## Cliente ACP (debug)

Use o cliente ACP integrado para verificar rapidamente a ponte sem um IDE.
Ele inicia a ponte ACP e permite que você digite prompts de forma interativa.

```bash
openclaw acp client

# Point the spawned bridge at a remote Gateway
openclaw acp client --server-args --url wss://gateway-host:18789 --token <token>

# Override the server command (default: openclaw)
openclaw acp client --server "node" --server-args openclaw.mjs acp --url ws://127.0.0.1:19001
```

## Como usar

Use ACP quando um IDE (ou outro cliente) fala Agent Client Protocol e você quer
que ele controle uma sessão do OpenClaw Gateway.

1. Certifique-se de que o Gateway esteja em execução (local ou remoto).
2. Configure o destino do Gateway (configuração ou flags).
3. Aponte seu IDE para executar `openclaw acp` via stdio.

Exemplo de configuração (persistida):

```bash
openclaw config set gateway.remote.url wss://gateway-host:18789
openclaw config set gateway.remote.token <token>
```

Exemplo de execução direta (sem gravar configuração):

```bash
openclaw acp --url wss://gateway-host:18789 --token <token>
```

## Selecionando agentes

O ACP não escolhe agentes diretamente. Ele roteia pela chave de sessão do Gateway.

Use chaves de sessão com escopo de agente para direcionar um agente específico:

```bash
openclaw acp --session agent:main:main
openclaw acp --session agent:design:main
openclaw acp --session agent:qa:bug-123
```

Cada sessão ACP mapeia para uma única chave de sessão do Gateway. Um agente pode ter
muitas sessões; o ACP usa por padrão uma sessão `acp:<uuid>` isolada, a menos que
você substitua a chave ou o rótulo.

## Configuração do editor Zed

Adicione um agente ACP personalizado em `~/.config/zed/settings.json` (ou use a UI de Configurações do Zed):

```json
{
  "agent_servers": {
    "OpenClaw ACP": {
      "type": "custom",
      "command": "openclaw",
      "args": ["acp"],
      "env": {}
    }
  }
}
```

Para direcionar um Gateway ou agente específico:

```json
{
  "agent_servers": {
    "OpenClaw ACP": {
      "type": "custom",
      "command": "openclaw",
      "args": [
        "acp",
        "--url",
        "wss://gateway-host:18789",
        "--token",
        "<token>",
        "--session",
        "agent:design:main"
      ],
      "env": {}
    }
  }
}
```

No Zed, abra o painel Agent e selecione “OpenClaw ACP” para iniciar um thread.

## Mapeamento de sessões

Por padrão, as sessões ACP recebem uma chave de sessão do Gateway isolada com um prefixo `acp:`.
Para reutilizar uma sessão conhecida, passe uma chave de sessão ou rótulo:

- `--session <key>`: use uma chave de sessão específica do Gateway.
- `--session-label <label>`: resolva uma sessão existente por rótulo.
- `--reset-session`: gere um novo id de sessão para essa chave (mesma chave, nova transcrição).

Se o seu cliente ACP oferecer suporte a metadados, você pode substituir por sessão:

```json
{
  "_meta": {
    "sessionKey": "agent:main:main",
    "sessionLabel": "support inbox",
    "resetSession": true
  }
}
```

Saiba mais sobre chaves de sessão em [/concepts/session](/concepts/session).

## Opções

- `--url <url>`: URL do WebSocket do Gateway (padrão: gateway.remote.url quando configurado).
- `--token <token>`: token de autenticação do Gateway.
- `--password <password>`: senha de autenticação do Gateway.
- `--session <key>`: chave de sessão padrão.
- `--session-label <label>`: rótulo de sessão padrão a resolver.
- `--require-existing`: falhar se a chave/rótulo da sessão não existir.
- `--reset-session`: redefinir a chave de sessão antes do primeiro uso.
- `--no-prefix-cwd`: não prefixar prompts com o diretório de trabalho.
- `--verbose, -v`: logs detalhados para stderr.

### Opções de `acp client`

- `--cwd <dir>`: diretório de trabalho para a sessão ACP.
- `--server <command>`: comando do servidor ACP (padrão: `openclaw`).
- `--server-args <args...>`: argumentos extras passados para o servidor ACP.
- `--server-verbose`: habilitar logs detalhados no servidor ACP.
- `--verbose, -v`: logs detalhados do cliente.
