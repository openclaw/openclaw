---
summary: "Sandbox por agente + restrições de ferramentas, precedência e exemplos"
title: Sandbox e Ferramentas Multiagente
read_when: "Você quer sandboxing por agente ou políticas de permitir/negar ferramentas por agente em um gateway multiagente."
status: active
---

# Configuração de Sandbox e Ferramentas Multiagente

## Visão geral

Cada agente em uma configuração multiagente agora pode ter seu próprio:

- **Configuração de sandbox** (`agents.list[].sandbox` substitui `agents.defaults.sandbox`)
- **Restrições de ferramentas** (`tools.allow` / `tools.deny`, além de `agents.list[].tools`)

Isso permite executar vários agentes com perfis de segurança diferentes:

- Assistente pessoal com acesso total
- Agentes de família/trabalho com ferramentas restritas
- Agentes voltados ao público em sandboxes

`setupCommand` pertence a `sandbox.docker` (global ou por agente) e é executado uma vez
quando o contêiner é criado.

A autenticação é por agente: cada agente lê de seu próprio repositório de autenticação `agentDir` em:

```
~/.openclaw/agents/<agentId>/agent/auth-profiles.json
```

As credenciais **não** são compartilhadas entre agentes. Nunca reutilize `agentDir` entre agentes.
Se você quiser compartilhar credenciais, copie `auth-profiles.json` para o `agentDir` do outro agente.

Para entender como o sandboxing se comporta em tempo de execução, veja [Sandboxing](/gateway/sandboxing).
Para depurar “por que isso está bloqueado?”, veja [Sandbox vs Tool Policy vs Elevated](/gateway/sandbox-vs-tool-policy-vs-elevated) e `openclaw sandbox explain`.

---

## Exemplos de configuração

### Exemplo 1: Agente pessoal + agente familiar restrito

```json
{
  "agents": {
    "list": [
      {
        "id": "main",
        "default": true,
        "name": "Personal Assistant",
        "workspace": "~/.openclaw/workspace",
        "sandbox": { "mode": "off" }
      },
      {
        "id": "family",
        "name": "Family Bot",
        "workspace": "~/.openclaw/workspace-family",
        "sandbox": {
          "mode": "all",
          "scope": "agent"
        },
        "tools": {
          "allow": ["read"],
          "deny": ["exec", "write", "edit", "apply_patch", "process", "browser"]
        }
      }
    ]
  },
  "bindings": [
    {
      "agentId": "family",
      "match": {
        "provider": "whatsapp",
        "accountId": "*",
        "peer": {
          "kind": "group",
          "id": "120363424282127706@g.us"
        }
      }
    }
  ]
}
```

**Resultado:**

- Agente `main`: executa no host, acesso total às ferramentas
- Agente `family`: executa no Docker (um contêiner por agente), apenas a ferramenta `read`

---

### Exemplo 2: Agente de trabalho com sandbox compartilhado

```json
{
  "agents": {
    "list": [
      {
        "id": "personal",
        "workspace": "~/.openclaw/workspace-personal",
        "sandbox": { "mode": "off" }
      },
      {
        "id": "work",
        "workspace": "~/.openclaw/workspace-work",
        "sandbox": {
          "mode": "all",
          "scope": "shared",
          "workspaceRoot": "/tmp/work-sandboxes"
        },
        "tools": {
          "allow": ["read", "write", "apply_patch", "exec"],
          "deny": ["browser", "gateway", "discord"]
        }
      }
    ]
  }
}
```

---

### Exemplo 2b: Perfil global de programação + agente apenas de mensagens

```json
{
  "tools": { "profile": "coding" },
  "agents": {
    "list": [
      {
        "id": "support",
        "tools": { "profile": "messaging", "allow": ["slack"] }
      }
    ]
  }
}
```

**Resultado:**

- agentes padrão recebem ferramentas de programação
- agente `support` é apenas de mensagens (+ ferramenta Slack)

---

### Exemplo 3: Diferentes modos de sandbox por agente

```json
{
  "agents": {
    "defaults": {
      "sandbox": {
        "mode": "non-main", // Global default
        "scope": "session"
      }
    },
    "list": [
      {
        "id": "main",
        "workspace": "~/.openclaw/workspace",
        "sandbox": {
          "mode": "off" // Override: main never sandboxed
        }
      },
      {
        "id": "public",
        "workspace": "~/.openclaw/workspace-public",
        "sandbox": {
          "mode": "all", // Override: public always sandboxed
          "scope": "agent"
        },
        "tools": {
          "allow": ["read"],
          "deny": ["exec", "write", "edit", "apply_patch"]
        }
      }
    ]
  }
}
```

---

## Precedência de configuração

Quando existem configurações globais (`agents.defaults.*`) e específicas do agente (`agents.list[].*`):

### Configuração de sandbox

As configurações específicas do agente substituem as globais:

```
agents.list[].sandbox.mode > agents.defaults.sandbox.mode
agents.list[].sandbox.scope > agents.defaults.sandbox.scope
agents.list[].sandbox.workspaceRoot > agents.defaults.sandbox.workspaceRoot
agents.list[].sandbox.workspaceAccess > agents.defaults.sandbox.workspaceAccess
agents.list[].sandbox.docker.* > agents.defaults.sandbox.docker.*
agents.list[].sandbox.browser.* > agents.defaults.sandbox.browser.*
agents.list[].sandbox.prune.* > agents.defaults.sandbox.prune.*
```

**Notas:**

- `agents.list[].sandbox.{docker,browser,prune}.*` substitui `agents.defaults.sandbox.{docker,browser,prune}.*` para esse agente (ignorado quando o escopo do sandbox resolve para `"shared"`).

### Restrições de ferramentas

A ordem de filtragem é:

1. **Perfil de ferramentas** (`tools.profile` ou `agents.list[].tools.profile`)
2. **Perfil de ferramentas do provedor** (`tools.byProvider[provider].profile` ou `agents.list[].tools.byProvider[provider].profile`)
3. **Política global de ferramentas** (`tools.allow` / `tools.deny`)
4. **Política de ferramentas do provedor** (`tools.byProvider[provider].allow/deny`)
5. **Política de ferramentas específica do agente** (`agents.list[].tools.allow/deny`)
6. **Política do provedor do agente** (`agents.list[].tools.byProvider[provider].allow/deny`)
7. **Política de ferramentas do sandbox** (`tools.sandbox.tools` ou `agents.list[].tools.sandbox.tools`)
8. **Política de ferramentas de subagente** (`tools.subagents.tools`, se aplicável)

Cada nível pode restringir ainda mais as ferramentas, mas não pode conceder novamente ferramentas negadas em níveis anteriores.
Se `agents.list[].tools.sandbox.tools` estiver definido, ele substitui `tools.sandbox.tools` para esse agente.
Se `agents.list[].tools.profile` estiver definido, ele substitui `tools.profile` para esse agente.
As chaves de ferramentas do provedor aceitam `provider` (por exemplo, `google-antigravity`) ou `provider/model` (por exemplo, `openai/gpt-5.2`).

### Grupos de ferramentas (atalhos)

Políticas de ferramentas (globais, por agente, de sandbox) oferecem suporte a entradas `group:*` que se expandem para várias ferramentas concretas:

- `group:runtime`: `exec`, `bash`, `process`
- `group:fs`: `read`, `write`, `edit`, `apply_patch`
- `group:sessions`: `sessions_list`, `sessions_history`, `sessions_send`, `sessions_spawn`, `session_status`
- `group:memory`: `memory_search`, `memory_get`
- `group:ui`: `browser`, `canvas`
- `group:automation`: `cron`, `gateway`
- `group:messaging`: `message`
- `group:nodes`: `nodes`
- `group:openclaw`: todas as ferramentas OpenClaw integradas (exclui plugins de provedores)

### Modo Elevated

`tools.elevated` é a linha de base global (lista de permissões baseada no remetente). `agents.list[].tools.elevated` pode restringir ainda mais o elevated para agentes específicos (ambos devem permitir).

Padrões de mitigação:

- Negar `exec` para agentes não confiáveis (`agents.list[].tools.deny: ["exec"]`)
- Evitar permitir remetentes que roteiam para agentes restritos
- Desativar elevated globalmente (`tools.elevated.enabled: false`) se você quiser apenas execução em sandbox
- Desativar elevated por agente (`agents.list[].tools.elevated.enabled: false`) para perfis sensíveis

---

## Migração a partir de agente único

**Antes (agente único):**

```json
{
  "agents": {
    "defaults": {
      "workspace": "~/.openclaw/workspace",
      "sandbox": {
        "mode": "non-main"
      }
    }
  },
  "tools": {
    "sandbox": {
      "tools": {
        "allow": ["read", "write", "apply_patch", "exec"],
        "deny": []
      }
    }
  }
}
```

**Depois (multiagente com perfis diferentes):**

```json
{
  "agents": {
    "list": [
      {
        "id": "main",
        "default": true,
        "workspace": "~/.openclaw/workspace",
        "sandbox": { "mode": "off" }
      }
    ]
  }
}
```

Configurações legadas `agent.*` são migradas por `openclaw doctor`; prefira `agents.defaults` + `agents.list` daqui para frente.

---

## Exemplos de restrição de ferramentas

### Agente somente leitura

```json
{
  "tools": {
    "allow": ["read"],
    "deny": ["exec", "write", "edit", "apply_patch", "process"]
  }
}
```

### Agente de execução segura (sem modificações de arquivos)

```json
{
  "tools": {
    "allow": ["read", "exec", "process"],
    "deny": ["write", "edit", "apply_patch", "browser", "gateway"]
  }
}
```

### Agente apenas de comunicação

```json
{
  "tools": {
    "allow": ["sessions_list", "sessions_send", "sessions_history", "session_status"],
    "deny": ["exec", "write", "edit", "apply_patch", "read", "browser"]
  }
}
```

---

## Armadilha comum: "non-main"

`agents.defaults.sandbox.mode: "non-main"` é baseado em `session.mainKey` (padrão `"main"`),
não no id do agente. Sessões de grupo/canal sempre recebem suas próprias chaves, então
são tratadas como non-main e serão colocadas em sandbox. Se você quiser que um agente nunca
use sandbox, defina `agents.list[].sandbox.mode: "off"`.

---

## Testes

Após configurar sandbox e ferramentas multiagente:

1. **Verifique a resolução do agente:**

   ```exec
   openclaw agents list --bindings
   ```

2. **Verifique os contêineres de sandbox:**

   ```exec
   docker ps --filter "name=openclaw-sbx-"
   ```

3. **Teste as restrições de ferramentas:**
   - Envie uma mensagem que exija ferramentas restritas
   - Verifique se o agente não consegue usar ferramentas negadas

4. **Monitore os logs:**

   ```exec
   tail -f "${OPENCLAW_STATE_DIR:-$HOME/.openclaw}/logs/gateway.log" | grep -E "routing|sandbox|tools"
   ```

---

## Solução de problemas

### Agente não está em sandbox apesar de `mode: "all"`

- Verifique se há um `agents.defaults.sandbox.mode` global que o substitui
- A configuração específica do agente tem precedência, então defina `agents.list[].sandbox.mode: "all"`

### Ferramentas ainda disponíveis apesar da lista de negação

- Verifique a ordem de filtragem de ferramentas: global → agente → sandbox → subagente
- Cada nível só pode restringir ainda mais, não conceder novamente
- Verifique nos logs: `[tools] filtering tools for agent:${agentId}`

### Contêiner não isolado por agente

- Defina `scope: "agent"` na configuração de sandbox específica do agente
- O padrão é `"session"`, que cria um contêiner por sessão

---

## Veja também

- [Roteamento Multiagente](/concepts/multi-agent)
- [Configuração de Sandbox](/gateway/configuration#agentsdefaults-sandbox)
- [Gerenciamento de Sessões](/concepts/session)
