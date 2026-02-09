---
title: CLI do Sandbox
summary: "Gerencie contêineres de sandbox e inspecione a política efetiva do sandbox"
read_when: "Você está gerenciando contêineres de sandbox ou depurando o comportamento de sandbox/política de ferramentas."
status: active
---

# CLI do Sandbox

Gerencie contêineres de sandbox baseados em Docker para execução isolada de agentes.

## Visão geral

O OpenClaw pode executar agentes em contêineres Docker isolados por segurança. Os comandos `sandbox` ajudam você a gerenciar esses contêineres, especialmente após atualizações ou mudanças de configuração.

## Comandos

### `openclaw sandbox explain`

Inspecione o modo/escopo/acesso ao workspace **efetivo** do sandbox, a política de ferramentas do sandbox e os gates elevados (com caminhos das chaves de configuração de correção).

```bash
openclaw sandbox explain
openclaw sandbox explain --session agent:main:main
openclaw sandbox explain --agent work
openclaw sandbox explain --json
```

### `openclaw sandbox list`

Liste todos os contêineres de sandbox com seu status e configuração.

```bash
openclaw sandbox list
openclaw sandbox list --browser  # List only browser containers
openclaw sandbox list --json     # JSON output
```

**A saída inclui:**

- Nome e status do contêiner (em execução/parado)
- Imagem Docker e se corresponde à configuração
- Idade (tempo desde a criação)
- Tempo ocioso (tempo desde o último uso)
- Sessão/agente associado

### `openclaw sandbox recreate`

Remova contêineres de sandbox para forçar a recriação com imagens/configurações atualizadas.

```bash
openclaw sandbox recreate --all                # Recreate all containers
openclaw sandbox recreate --session main       # Specific session
openclaw sandbox recreate --agent mybot        # Specific agent
openclaw sandbox recreate --browser            # Only browser containers
openclaw sandbox recreate --all --force        # Skip confirmation
```

**Opções:**

- `--all`: Recriar todos os contêineres de sandbox
- `--session <key>`: Recriar contêiner para uma sessão específica
- `--agent <id>`: Recriar contêineres para um agente específico
- `--browser`: Recriar apenas contêineres de navegador
- `--force`: Ignorar o prompt de confirmação

**Importante:** Os contêineres são recriados automaticamente quando o agente é usado novamente.

## Casos de uso

### Após atualizar imagens Docker

```bash
# Pull new image
docker pull openclaw-sandbox:latest
docker tag openclaw-sandbox:latest openclaw-sandbox:bookworm-slim

# Update config to use new image
# Edit config: agents.defaults.sandbox.docker.image (or agents.list[].sandbox.docker.image)

# Recreate containers
openclaw sandbox recreate --all
```

### Após alterar a configuração do sandbox

```bash
# Edit config: agents.defaults.sandbox.* (or agents.list[].sandbox.*)

# Recreate to apply new config
openclaw sandbox recreate --all
```

### Após alterar setupCommand

```bash
openclaw sandbox recreate --all
# or just one agent:
openclaw sandbox recreate --agent family
```

### Apenas para um agente específico

```bash
# Update only one agent's containers
openclaw sandbox recreate --agent alfred
```

## Por que isso é necessário?

**Problema:** Quando você atualiza imagens Docker do sandbox ou a configuração:

- Contêineres existentes continuam em execução com configurações antigas
- Os contêineres só são removidos após 24h de inatividade
- Agentes usados regularmente mantêm contêineres antigos em execução indefinidamente

**Solução:** Use `openclaw sandbox recreate` para forçar a remoção de contêineres antigos. Eles serão recriados automaticamente com as configurações atuais quando forem necessários novamente.

Dica: prefira `openclaw sandbox recreate` em vez de `docker rm` manual. Ele usa o esquema de nomes de contêineres do Gateway e evita incompatibilidades quando chaves de escopo/sessão mudam.

## Configuração

As configurações do sandbox ficam em `~/.openclaw/openclaw.json` sob `agents.defaults.sandbox` (substituições por agente ficam em `agents.list[].sandbox`):

```jsonc
{
  "agents": {
    "defaults": {
      "sandbox": {
        "mode": "all", // off, non-main, all
        "scope": "agent", // session, agent, shared
        "docker": {
          "image": "openclaw-sandbox:bookworm-slim",
          "containerPrefix": "openclaw-sbx-",
          // ... more Docker options
        },
        "prune": {
          "idleHours": 24, // Auto-prune after 24h idle
          "maxAgeDays": 7, // Auto-prune after 7 days
        },
      },
    },
  },
}
```

## Veja também

- [Documentação do Sandbox](/gateway/sandboxing)
- [Configuração de Agente](/concepts/agent-workspace)
- [Comando Doctor](/gateway/doctor) - Verifique a configuração do sandbox
