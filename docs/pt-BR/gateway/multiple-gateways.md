---
summary: "Execute vários Gateways do OpenClaw em um único host (isolamento, portas e perfis)"
read_when:
  - Executando mais de um Gateway na mesma máquina
  - Você precisa de configuração/estado/portas isolados por Gateway
title: "Múltiplos Gateways"
---

# Múltiplos Gateways (mesmo host)

A maioria das configurações deve usar um único Gateway, porque um único Gateway pode lidar com várias conexões de mensagens e agentes. Se você precisar de isolamento ou redundância mais fortes (por exemplo, um bot de resgate), execute Gateways separados com perfis/portas isolados.

## Checklist de isolamento (obrigatório)

- `OPENCLAW_CONFIG_PATH` — arquivo de configuração por instância
- `OPENCLAW_STATE_DIR` — sessões, credenciais e caches por instância
- `agents.defaults.workspace` — raiz do workspace por instância
- `gateway.port` (ou `--port`) — único por instância
- Portas derivadas (browser/canvas) não devem se sobrepor

Se qualquer um desses for compartilhado, você enfrentará condições de corrida de configuração e conflitos de portas.

## Recomendado: perfis (`--profile`)

Os perfis fazem o escopo automático de `OPENCLAW_STATE_DIR` + `OPENCLAW_CONFIG_PATH` e adicionam sufixos aos nomes dos serviços.

```bash
# main
openclaw --profile main setup
openclaw --profile main gateway --port 18789

# rescue
openclaw --profile rescue setup
openclaw --profile rescue gateway --port 19001
```

Serviços por perfil:

```bash
openclaw --profile main gateway install
openclaw --profile rescue gateway install
```

## Guia do bot de resgate

Execute um segundo Gateway no mesmo host com o seu próprio:

- perfil/configuração
- diretório de estado
- workspace
- porta base (mais portas derivadas)

Isso mantém o bot de resgate isolado do bot principal, para que ele possa depurar ou aplicar alterações de configuração se o bot principal estiver fora do ar.

Espaçamento de portas: deixe pelo menos 20 portas entre as portas base para que as portas derivadas de browser/canvas/CDP nunca colidam.

### Como instalar (bot de resgate)

```bash
# Main bot (existing or fresh, without --profile param)
# Runs on port 18789 + Chrome CDC/Canvas/... Ports
openclaw onboard
openclaw gateway install

# Rescue bot (isolated profile + ports)
openclaw --profile rescue onboard
# Notes:
# - workspace name will be postfixed with -rescue per default
# - Port should be at least 18789 + 20 Ports,
#   better choose completely different base port, like 19789,
# - rest of the onboarding is the same as normal

# To install the service (if not happened automatically during onboarding)
openclaw --profile rescue gateway install
```

## Mapeamento de portas (derivadas)

Porta base = `gateway.port` (ou `OPENCLAW_GATEWAY_PORT` / `--port`).

- porta do serviço de controle do browser = base + 2 (somente local loopback)
- `canvasHost.port = base + 4`
- As portas CDP do perfil do browser são alocadas automaticamente a partir de `browser.controlPort + 9 .. + 108`

Se você sobrescrever qualquer uma delas na configuração ou em variáveis de ambiente, deve mantê-las únicas por instância.

## Notas de Browser/CDP (armadilha comum)

- **Não** fixe `browser.cdpUrl` nos mesmos valores em várias instâncias.
- Cada instância precisa de sua própria porta de controle do browser e intervalo de CDP (derivado da porta do gateway).
- Se você precisar de portas CDP explícitas, defina `browser.profiles.<name>.cdpPort` por instância.
- Chrome remoto: use `browser.profiles.<name>.cdpUrl` (por perfil, por instância).

## Exemplo manual com env

```bash
OPENCLAW_CONFIG_PATH=~/.openclaw/main.json \
OPENCLAW_STATE_DIR=~/.openclaw-main \
openclaw gateway --port 18789

OPENCLAW_CONFIG_PATH=~/.openclaw/rescue.json \
OPENCLAW_STATE_DIR=~/.openclaw-rescue \
openclaw gateway --port 19001
```

## Verificações rápidas

```bash
openclaw --profile main status
openclaw --profile rescue status
openclaw --profile rescue browser status
```
