---
summary: "Plugin Zalo Personal: login por QR + mensagens via zca-cli (instalação do plugin + configuração de canal + CLI + ferramenta)"
read_when:
  - Você quer suporte ao Zalo Personal (não oficial) no OpenClaw
  - Você está configurando ou desenvolvendo o plugin zalouser
title: "Plugin Zalo Personal"
---

# Zalo Personal (plugin)

Suporte ao Zalo Personal para o OpenClaw por meio de um plugin, usando `zca-cli` para automatizar uma conta normal de usuário do Zalo.

> **Aviso:** A automação não oficial pode levar à suspensão/banimento da conta. Use por sua conta e risco.

## Naming

O ID do canal é `zalouser` para deixar explícito que isso automatiza uma **conta pessoal de usuário do Zalo** (não oficial). Mantemos `zalo` reservado para uma possível integração futura com a API oficial do Zalo.

## Onde ele roda

Este plugin roda **dentro do processo do Gateway**.

Se você usa um Gateway remoto, instale/configure-o na **máquina que executa o Gateway** e, em seguida, reinicie o Gateway.

## Instalação

### Opção A: instalar a partir do npm

```bash
openclaw plugins install @openclaw/zalouser
```

Reinicie o Gateway depois.

### Opção B: instalar a partir de uma pasta local (dev)

```bash
openclaw plugins install ./extensions/zalouser
cd ./extensions/zalouser && pnpm install
```

Reinicie o Gateway depois.

## Pré-requisito: zca-cli

A máquina do Gateway deve ter `zca` em `PATH`:

```bash
zca --version
```

## Configuração

A configuração do canal fica em `channels.zalouser` (não em `plugins.entries.*`):

```json5
{
  channels: {
    zalouser: {
      enabled: true,
      dmPolicy: "pairing",
    },
  },
}
```

## CLI

```bash
openclaw channels login --channel zalouser
openclaw channels logout --channel zalouser
openclaw channels status --probe
openclaw message send --channel zalouser --target <threadId> --message "Hello from OpenClaw"
openclaw directory peers list --channel zalouser --query "name"
```

## Ferramenta do agente

Nome da ferramenta: `zalouser`

Ações: `send`, `image`, `link`, `friends`, `groups`, `me`, `status`
