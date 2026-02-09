---
summary: "Plano de refatoração: roteamento do host de exec, aprovações de nó e runner headless"
read_when:
  - Ao projetar roteamento do host de exec ou aprovações de exec
  - Ao implementar runner de nó + IPC de UI
  - Ao adicionar modos de segurança do host de exec e comandos slash
title: "Refatoração do Host de Exec"
---

# Plano de refatoração do host de exec

## Objetivos

- Adicionar `exec.host` + `exec.security` para rotear a execução entre **sandbox**, **gateway** e **node**.
- Manter padrões **seguros**: nenhuma execução entre hosts sem habilitação explícita.
- Separar a execução em um **serviço runner headless** com UI opcional (app macOS) via IPC local.
- Fornecer política **por agente**, lista de permissões, modo de pergunta e vínculo de nó.
- Oferecer suporte a **modos de pergunta** que funcionem _com_ ou _sem_ listas de permissões.
- Multiplataforma: socket Unix + autenticação por token (paridade macOS/Linux/Windows).

## Não objetivos

- Nenhuma migração de lista de permissões legada ou suporte a esquema legado.
- Sem PTY/streaming para exec em nó (apenas saída agregada).
- Nenhuma nova camada de rede além da Bridge + Gateway existentes.

## Decisões (bloqueadas)

- **Chaves de configuração:** `exec.host` + `exec.security` (override por agente permitido).
- **Elevação:** manter `/elevated` como um alias para acesso total ao gateway.
- **Padrão de pergunta:** `on-miss`.
- **Armazenamento de aprovações:** `~/.openclaw/exec-approvals.json` (JSON, sem migração legada).
- **Runner:** serviço de sistema headless; o app de UI hospeda um socket Unix para aprovações.
- **Identidade do nó:** usar o `nodeId` existente.
- **Autenticação de socket:** socket Unix + token (multiplataforma); dividir depois se necessário.
- **Estado do host de nó:** `~/.openclaw/node.json` (id do nó + token de pareamento).
- **Host de exec no macOS:** executar `system.run` dentro do app macOS; o serviço host do nó encaminha solicitações via IPC local.
- **Sem helper XPC:** manter socket Unix + token + verificações de par.

## Conceitos-chave

### Host

- `sandbox`: Docker exec (comportamento atual).
- `gateway`: exec no host do gateway.
- `node`: exec no runner de nó via Bridge (`system.run`).

### Modo de segurança

- `deny`: sempre bloquear.
- `allowlist`: permitir apenas correspondências.
- `full`: permitir tudo (equivalente a elevado).

### Modo de pergunta

- `off`: nunca perguntar.
- `on-miss`: perguntar apenas quando a lista de permissões não corresponder.
- `always`: perguntar sempre.

Perguntar é **independente** da lista de permissões; a lista pode ser usada com `always` ou `on-miss`.

### Resolução de política (por exec)

1. Resolver `exec.host` (parâmetro da ferramenta → override do agente → padrão global).
2. Resolver `exec.security` e `exec.ask` (mesma precedência).
3. Se o host for `sandbox`, prosseguir com exec local em sandbox.
4. Se o host for `gateway` ou `node`, aplicar a política de segurança + pergunta nesse host.

## Segurança padrão

- Padrão `exec.host = sandbox`.
- Padrão `exec.security = deny` para `gateway` e `node`.
- Padrão `exec.ask = on-miss` (relevante apenas se a segurança permitir).
- Se nenhum vínculo de nó estiver definido, **o agente pode direcionar para qualquer nó**, mas apenas se a política permitir.

## Superfície de configuração

### Parâmetros da ferramenta

- `exec.host` (opcional): `sandbox | gateway | node`.
- `exec.security` (opcional): `deny | allowlist | full`.
- `exec.ask` (opcional): `off | on-miss | always`.
- `exec.node` (opcional): id/nome do nó a usar quando `host=node`.

### Chaves de configuração (global)

- `tools.exec.host`
- `tools.exec.security`
- `tools.exec.ask`
- `tools.exec.node` (vínculo padrão de nó)

### Chaves de configuração (por agente)

- `agents.list[].tools.exec.host`
- `agents.list[].tools.exec.security`
- `agents.list[].tools.exec.ask`
- `agents.list[].tools.exec.node`

### Alias

- `/elevated on` = definir `tools.exec.host=gateway`, `tools.exec.security=full` para a sessão do agente.
- `/elevated off` = restaurar configurações anteriores de exec para a sessão do agente.

## Armazenamento de aprovações (JSON)

Caminho: `~/.openclaw/exec-approvals.json`

Propósito:

- Política local + listas de permissões para o **host de execução** (gateway ou runner de nó).
- Fallback de pergunta quando nenhuma UI estiver disponível.
- Credenciais de IPC para clientes de UI.

Esquema proposto (v1):

```json
{
  "version": 1,
  "socket": {
    "path": "~/.openclaw/exec-approvals.sock",
    "token": "base64-opaque-token"
  },
  "defaults": {
    "security": "deny",
    "ask": "on-miss",
    "askFallback": "deny"
  },
  "agents": {
    "agent-id-1": {
      "security": "allowlist",
      "ask": "on-miss",
      "allowlist": [
        {
          "pattern": "~/Projects/**/bin/rg",
          "lastUsedAt": 0,
          "lastUsedCommand": "rg -n TODO",
          "lastResolvedPath": "/Users/user/Projects/.../bin/rg"
        }
      ]
    }
  }
}
```

Notas:

- Nenhum formato de lista de permissões legado.
- `askFallback` aplica-se apenas quando `ask` é exigido e nenhuma UI está acessível.
- Permissões de arquivo: `0600`.

## Serviço runner (headless)

### Funções

- Aplicar `exec.security` + `exec.ask` localmente.
- Executar comandos do sistema e retornar a saída.
- Emitir eventos da Bridge para o ciclo de vida do exec (opcional, mas recomendado).

### Ciclo de vida do serviço

- Launchd/daemon no macOS; serviço de sistema no Linux/Windows.
- O JSON de aprovações é local ao host de execução.
- A UI hospeda um socket Unix local; runners conectam sob demanda.

## Integração de UI (app macOS)

### IPC

- Socket Unix em `~/.openclaw/exec-approvals.sock` (0600).
- Token armazenado em `exec-approvals.json` (0600).
- Verificações de par: apenas mesmo UID.
- Desafio/resposta: nonce + HMAC(token, hash-da-solicitação) para evitar replay.
- TTL curto (ex.: 10s) + payload máximo + limite de taxa.

### Fluxo de pergunta (host de exec do app macOS)

1. O serviço de nó recebe `system.run` do gateway.
2. O serviço de nó conecta-se ao socket local e envia o prompt/solicitação de exec.
3. O app valida par + token + HMAC + TTL e então mostra o diálogo se necessário.
4. O app executa o comando no contexto da UI e retorna a saída.
5. O serviço de nó retorna a saída ao gateway.

Se a UI estiver ausente:

- Aplicar `askFallback` (`deny|allowlist|full`).

### Diagrama (SCI)

```
Agent -> Gateway -> Bridge -> Node Service (TS)
                         |  IPC (UDS + token + HMAC + TTL)
                         v
                     Mac App (UI + TCC + system.run)
```

## Identidade + vínculo de nó

- Usar o `nodeId` existente do pareamento da Bridge.
- Modelo de vínculo:
  - `tools.exec.node` restringe o agente a um nó específico.
  - Se não definido, o agente pode escolher qualquer nó (a política ainda aplica os padrões).
- Resolução de seleção de nó:
  - `nodeId` correspondência exata
  - `displayName` (normalizado)
  - `remoteIp`
  - prefixo `nodeId` (>= 6 caracteres)

## Eventing

### Quem vê os eventos

- Eventos do sistema são **por sessão** e mostrados ao agente no próximo prompt.
- Armazenados no gateway em uma fila em memória (`enqueueSystemEvent`).

### Texto do evento

- `Exec started (node=<id>, id=<runId>)`
- `Exec finished (node=<id>, id=<runId>, code=<code>)` + cauda opcional da saída
- `Exec denied (node=<id>, id=<runId>, <reason>)`

### Transporte

Opção A (recomendada):

- O runner envia frames da Bridge `event` `exec.started` / `exec.finished`.
- O Gateway `handleBridgeEvent` mapeia isso para `enqueueSystemEvent`.

Opção B:

- A ferramenta do Gateway `exec` lida diretamente com o ciclo de vida (apenas síncrono).

## Fluxos de exec

### Host sandbox

- Comportamento existente `exec` (Docker ou host quando fora de sandbox).
- PTY suportado apenas no modo não sandbox.

### Host do Gateway

- O processo do Gateway executa em sua própria máquina.
- Aplica `exec-approvals.json` local (segurança/pergunta/lista de permissões).

### Host de nó

- O Gateway chama `node.invoke` com `system.run`.
- O runner aplica aprovações locais.
- O runner retorna stdout/stderr agregados.
- Eventos opcionais da Bridge para início/fim/negação.

## Tampas de saída

- Limitar stdout+stderr combinados em **200k**; manter **cauda de 20k** para eventos.
- Truncar com um sufixo claro (ex.: `"… (truncated)"`).

## Comandos slash

- `/exec host=<sandbox|gateway|node> security=<deny|allowlist|full> ask=<off|on-miss|always> node=<id>`
- Overrides por agente e por sessão; não persistentes a menos que salvos via configuração.
- `/elevated on|off|ask|full` permanece um atalho para `host=gateway security=full` (com `full` pulando aprovações).

## História entre plataformas

- O serviço runner é o alvo portátil de execução.
- A UI é opcional; se ausente, aplica-se `askFallback`.
- Windows/Linux suportam o mesmo JSON de aprovações + protocolo de socket.

## Fases de implementação

### Fase 1: configuração + roteamento de exec

- Adicionar esquema de configuração para `exec.host`, `exec.security`, `exec.ask`, `exec.node`.
- Atualizar o encanamento da ferramenta para respeitar `exec.host`.
- Adicionar o comando slash `/exec` e manter o alias `/elevated`.

### Fase 2: armazenamento de aprovações + aplicação no gateway

- Implementar leitor/escritor de `exec-approvals.json`.
- Aplicar lista de permissões + modos de pergunta para o host `gateway`.
- Adicionar limites de saída.

### Fase 3: aplicação no runner de nó

- Atualizar o runner de nó para aplicar lista de permissões + pergunta.
- Adicionar ponte de prompt via socket Unix para a UI do app macOS.
- Conectar `askFallback`.

### Fase 4: eventos

- Adicionar eventos da Bridge de nó → gateway para o ciclo de vida do exec.
- Mapear para `enqueueSystemEvent` nos prompts do agente.

### Fase 5: polimento da UI

- App Mac: editor de lista de permissões, seletor por agente, UI de política de pergunta.
- Controles de vínculo de nó (opcional).

## Plano de testes

- Testes unitários: correspondência de lista de permissões (glob + case-insensitive).
- Testes unitários: precedência de resolução de política (parâmetro da ferramenta → override do agente → global).
- Testes de integração: fluxos de negar/permitir/perguntar do runner de nó.
- Testes de eventos da Bridge: evento de nó → roteamento de evento de sistema.

## Riscos em aberto

- Indisponibilidade da UI: garantir que `askFallback` seja respeitado.
- Comandos de longa duração: confiar em timeout + limites de saída.
- Ambiguidade multi-nó: erro a menos que haja vínculo de nó ou parâmetro explícito de nó.

## Documentos relacionados

- [Exec tool](/tools/exec)
- [Exec approvals](/tools/exec-approvals)
- [Nodes](/nodes)
- [Elevated mode](/tools/elevated)
