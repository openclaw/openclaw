---
title: Sandbox vs Política de Ferramentas vs Elevado
summary: "Por que uma ferramenta é bloqueada: runtime de sandbox, política de permitir/negar ferramentas e portões de exec elevado"
read_when: "Você cai na 'prisão do sandbox' ou vê uma recusa de ferramenta/elevado e quer a chave de configuração exata para mudar."
status: active
---

# Sandbox vs Política de Ferramentas vs Elevado

O OpenClaw tem três controles relacionados (mas diferentes):

1. **Sandbox** (`agents.defaults.sandbox.*` / `agents.list[].sandbox.*`) decide **onde as ferramentas são executadas** (Docker vs host).
2. **Política de ferramentas** (`tools.*`, `tools.sandbox.tools.*`, `agents.list[].tools.*`) decide **quais ferramentas estão disponíveis/permitidas**.
3. **Elevado** (`tools.elevated.*`, `agents.list[].tools.elevated.*`) é uma **válvula de escape apenas para exec** para executar no host quando você está em sandbox.

## Depuração rápida

Use o inspetor para ver o que o OpenClaw está _realmente_ fazendo:

```bash
openclaw sandbox explain
openclaw sandbox explain --session agent:main:main
openclaw sandbox explain --agent work
openclaw sandbox explain --json
```

Ele imprime:

- modo/escopo/acesso ao workspace efetivos do sandbox
- se a sessão está atualmente em sandbox (principal vs não principal)
- permitir/negar efetivo de ferramentas no sandbox (e se veio de agente/global/padrão)
- portões de elevado e caminhos de chaves de correção

## Sandbox: onde as ferramentas são executadas

O sandboxing é controlado por `agents.defaults.sandbox.mode`:

- `"off"`: tudo é executado no host.
- `"non-main"`: apenas sessões não principais ficam em sandbox (surpresa comum para grupos/canais).
- `"all"`: tudo fica em sandbox.

Veja [Sandboxing](/gateway/sandboxing) para a matriz completa (escopo, mounts de workspace, imagens).

### Bind mounts (verificação rápida de segurança)

- `docker.binds` _atravessa_ o sistema de arquivos do sandbox: o que você montar fica visível dentro do contêiner com o modo que você definir (`:ro` ou `:rw`).
- O padrão é leitura-escrita se você omitir o modo; prefira `:ro` para código-fonte/segredos.
- `scope: "shared"` ignora binds por agente (apenas binds globais se aplicam).
- Vincular `/var/run/docker.sock` efetivamente entrega o controle do host ao sandbox; faça isso apenas de forma intencional.
- O acesso ao workspace (`workspaceAccess: "ro"`/`"rw"`) é independente dos modos de bind.

## Política de ferramentas: quais ferramentas existem/podem ser chamadas

Duas camadas importam:

- **Perfil de ferramentas**: `tools.profile` e `agents.list[].tools.profile` (lista de permissões base)
- **Perfil de ferramentas do provedor**: `tools.byProvider[provider].profile` e `agents.list[].tools.byProvider[provider].profile`
- **Política global/por agente de ferramentas**: `tools.allow`/`tools.deny` e `agents.list[].tools.allow`/`agents.list[].tools.deny`
- **Política de ferramentas do provedor**: `tools.byProvider[provider].allow/deny` e `agents.list[].tools.byProvider[provider].allow/deny`
- **Política de ferramentas do sandbox** (aplica-se apenas quando em sandbox): `tools.sandbox.tools.allow`/`tools.sandbox.tools.deny` e `agents.list[].tools.sandbox.tools.*`

Regras gerais:

- `deny` sempre vence.
- Se `allow` não estiver vazio, todo o resto é tratado como bloqueado.
- Política de ferramentas é o bloqueio definitivo: `/exec` não pode sobrescrever uma ferramenta `exec` negada.
- `/exec` apenas altera padrões da sessão para remetentes autorizados; não concede acesso a ferramentas.
  As chaves de ferramentas do provedor aceitam `provider` (ex.: `google-antigravity`) ou `provider/model` (ex.: `openai/gpt-5.2`).

### Grupos de ferramentas (atalhos)

As políticas de ferramentas (global, agente, sandbox) suportam entradas `group:*` que se expandem para várias ferramentas:

```json5
{
  tools: {
    sandbox: {
      tools: {
        allow: ["group:runtime", "group:fs", "group:sessions", "group:memory"],
      },
    },
  },
}
```

Grupos disponíveis:

- `group:runtime`: `exec`, `bash`, `process`
- `group:fs`: `read`, `write`, `edit`, `apply_patch`
- `group:sessions`: `sessions_list`, `sessions_history`, `sessions_send`, `sessions_spawn`, `session_status`
- `group:memory`: `memory_search`, `memory_get`
- `group:ui`: `browser`, `canvas`
- `group:automation`: `cron`, `gateway`
- `group:messaging`: `message`
- `group:nodes`: `nodes`
- `group:openclaw`: todas as ferramentas internas do OpenClaw (exclui plugins de provedores)

## Elevado: “executar no host” apenas para exec

Elevado **não** concede ferramentas extras; ele só afeta `exec`.

- Se você estiver em sandbox, `/elevated on` (ou `exec` com `elevated: true`) executa no host (aprovações ainda podem se aplicar).
- Use `/elevated full` para pular aprovações de exec para a sessão.
- Se você já estiver executando direto, elevado é efetivamente um no-op (ainda com portões).
- Elevado **não** é escopado por skill e **não** sobrescreve permitir/negar de ferramentas.
- `/exec` é separado de elevado. Ele apenas ajusta padrões de exec por sessão para remetentes autorizados.

Portões:

- Ativação: `tools.elevated.enabled` (e opcionalmente `agents.list[].tools.elevated.enabled`)
- Listas de permissões de remetentes: `tools.elevated.allowFrom.<provider>` (e opcionalmente `agents.list[].tools.elevated.allowFrom.<provider>`)

Veja [Elevated Mode](/tools/elevated).

## Correções comuns de “prisão do sandbox”

### “Ferramenta X bloqueada pela política de ferramentas do sandbox”

Chaves de correção (escolha uma):

- Desativar o sandbox: `agents.defaults.sandbox.mode=off` (ou por agente `agents.list[].sandbox.mode=off`)
- Permitir a ferramenta dentro do sandbox:
  - remover de `tools.sandbox.tools.deny` (ou por agente `agents.list[].tools.sandbox.tools.deny`)
  - ou adicionar a `tools.sandbox.tools.allow` (ou permitir por agente)

### “Achei que isso era principal, por que está em sandbox?”

No modo `"non-main"`, chaves de grupo/canal _não_ são principais. Use a chave da sessão principal (mostrada por `sandbox explain`) ou mude o modo para `"off"`.
