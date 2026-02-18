---
summary: "Roteamento multi-agente: agentes isolados, contas de canal e bindings"
title: Roteamento Multi-Agente
read_when: "Você quer múltiplos agentes isolados (workspaces + autenticação) em um processo gateway."
status: active
---

# Roteamento Multi-Agente

Objetivo: múltiplos agentes _isolados_ (workspace separado + `agentDir` + sessões), mais múltiplas contas de canal (ex. dois WhatsApps) em um Gateway em execução. Entrada é roteada para um agente via bindings.

## O que é "um agente"?

Um **agente** é um cérebro totalmente scoped com seu próprio:

- **Workspace** (arquivos, AGENTS.md/SOUL.md/USER.md, notas locais, regras de persona).
- **Diretório de estado** (`agentDir`) para perfis de autenticação, registro de modelo e config por agente.
- **Armazenamento de sessão** (histórico de chat + estado de roteamento) sob `~/.openclaw/agents/<agentId>/sessions`.

Perfis de autenticação são **por agente**. Cada agente lê de seu próprio:

```
~/.openclaw/agents/<agentId>/agent/auth-profiles.json
```

Credenciais do agente principal **não** são compartilhadas automaticamente. Nunca reutilize `agentDir` entre agentes (causa colisões de autenticação/sessão). Se você quer compartilhar credenciais, copie `auth-profiles.json` para o `agentDir` do outro agente.

Skills são por agente via pasta `skills/` do workspace de cada um, com skills compartilhadas disponíveis de `~/.openclaw/skills`. Veja [Skills: por agente vs compartilhadas](/tools/skills#per-agent-vs-shared-skills).

O Gateway pode hospedar **um agente** (padrão) ou **muitos agentes** lado a lado.

**Nota de workspace:** o workspace de cada agente é o **cwd padrão**, não um sandbox rígido. Caminhos relativos resolvem dentro do workspace, mas caminhos absolutos podem alcançar outras localizações de host a menos que sandboxing esteja habilitado. Veja [Sandboxing](/gateway/sandboxing).

## Caminhos (mapa rápido)

- Config: `~/.openclaw/openclaw.json` (ou `OPENCLAW_CONFIG_PATH`)
- Diretório de estado: `~/.openclaw` (ou `OPENCLAW_STATE_DIR`)
- Workspace: `~/.openclaw/workspace` (ou `~/.openclaw/workspace-<agentId>`)
- Diretório de agente: `~/.openclaw/agents/<agentId>/agent` (ou `agents.list[].agentDir`)
- Sessões: `~/.openclaw/agents/<agentId>/sessions`

### Modo de agente único (padrão)

Se você não fazer nada, OpenClaw executa um único agente:

- `agentId` padrão é **`main`**.
- Sessões são keyed como `agent:main:<mainKey>`.
- Workspace padrão é `~/.openclaw/workspace` (ou `~/.openclaw/workspace-<profile>` quando `OPENCLAW_PROFILE` é definido).
- Estado padrão é `~/.openclaw/agents/main/agent`.

## Assistente de agente

Use o assistente de agente para adicionar um novo agente isolado:

```bash
openclaw agents add work
```

Depois adicione `bindings` (ou deixe o assistente fazer) para rotear mensagens de entrada.

Verifique com:

```bash
openclaw agents list --bindings
```

## Múltiplos agentes = múltiplas pessoas, múltiplas personalidades

Com **múltiplos agentes**, cada `agentId` se torna uma **persona totalmente isolada**:

- **Diferentes números de telefone/contas** (per canal de conta `accountId`).
- **Diferentes personalidades** (arquivos de workspace por agente como `AGENTS.md` e `SOUL.md`).
- **Autenticação separada + sessões** (sem cross-talk a menos que explicitamente habilitado).
