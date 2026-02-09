---
summary: "Aprovações de exec, listas de permissões e prompts de escape do sandbox"
read_when:
  - Configurando aprovações de exec ou listas de permissões
  - Implementando UX de aprovação de exec no app macOS
  - Revisando prompts de escape do sandbox e implicações
title: "Aprovações de Exec"
---

# Aprovações de exec

As aprovações de exec são o **guardrail do aplicativo complementar / host de nó** para permitir que um agente em sandbox execute
comandos em um host real (`gateway` ou `node`). Pense nisso como um intertravamento de segurança:
os comandos só são permitidos quando política + lista de permissões + (opcionalmente) aprovação do usuário concordam.
As aprovações de exec são **além** da política de ferramentas e do gating elevado (a menos que elevated esteja definido como `full`, o que ignora as aprovações).
A política efetiva é a **mais restritiva** entre `tools.exec.*` e os padrões de aprovações; se um campo de aprovações for omitido, o valor `tools.exec` é usado.

Se a UI do aplicativo complementar **não estiver disponível**, qualquer solicitação que exija um prompt é
resolvida pelo **ask fallback** (padrão: negar).

## Onde se aplica

As aprovações de exec são aplicadas localmente no host de execução:

- **gateway host** → processo `openclaw` na máquina do gateway
- **node host** → runner do nó (aplicativo complementar macOS ou host de nó headless)

Divisão no macOS:

- **serviço do host de nó** encaminha `system.run` para o **app macOS** via IPC local.
- **app macOS** aplica as aprovações + executa o comando no contexto da UI.

## Configurações e armazenamento

As aprovações ficam em um arquivo JSON local no host de execução:

`~/.openclaw/exec-approvals.json`

Exemplo de esquema:

```json
{
  "version": 1,
  "socket": {
    "path": "~/.openclaw/exec-approvals.sock",
    "token": "base64url-token"
  },
  "defaults": {
    "security": "deny",
    "ask": "on-miss",
    "askFallback": "deny",
    "autoAllowSkills": false
  },
  "agents": {
    "main": {
      "security": "allowlist",
      "ask": "on-miss",
      "askFallback": "deny",
      "autoAllowSkills": true,
      "allowlist": [
        {
          "id": "B0C8C0B3-2C2D-4F8A-9A3C-5A4B3C2D1E0F",
          "pattern": "~/Projects/**/bin/rg",
          "lastUsedAt": 1737150000000,
          "lastUsedCommand": "rg -n TODO",
          "lastResolvedPath": "/Users/user/Projects/.../bin/rg"
        }
      ]
    }
  }
}
```

## Controles de política

### Segurança (`exec.security`)

- **deny**: bloqueia todas as solicitações de exec no host.
- **allowlist**: permite apenas comandos presentes na lista de permissões.
- **full**: permite tudo (equivalente a elevated).

### Ask (`exec.ask`)

- **off**: nunca perguntar.
- **on-miss**: perguntar apenas quando a lista de permissões não corresponder.
- **always**: perguntar em todo comando.

### Ask fallback (`askFallback`)

Se um prompt for necessário, mas nenhuma UI estiver acessível, o fallback decide:

- **deny**: bloquear.
- **allowlist**: permitir apenas se a lista de permissões corresponder.
- **full**: permitir.

## Lista de permissões (por agente)

As listas de permissões são **por agente**. Se existirem vários agentes, alterne qual agente você está
editando no app macOS. Os padrões são **correspondências glob sem distinção de maiúsculas/minúsculas**.
Os padrões devem resolver para **caminhos de binário** (entradas apenas com basename são ignoradas).
Entradas legadas `agents.default` são migradas para `agents.main` ao carregar.

Exemplos:

- `~/Projects/**/bin/peekaboo`
- `~/.local/bin/*`
- `/opt/homebrew/bin/rg`

Cada entrada da lista de permissões rastreia:

- **id** UUID estável usado para identidade na UI (opcional)
- **last used** timestamp
- **last used command**
- **last resolved path**

## Auto-permitir CLIs de Skills

Quando **Auto-allow skill CLIs** está ativado, executáveis referenciados por Skills conhecidas
são tratados como permitidos na lista de permissões nos nós (nó macOS ou host de nó headless). Isso usa
`skills.bins` via RPC do Gateway para buscar a lista de bins das Skills. Desative isso se você quiser listas de permissões manuais estritas.

## Safe bins (apenas stdin)

`tools.exec.safeBins` define uma pequena lista de binários **somente stdin** (por exemplo `jq`)
que podem executar no modo de lista de permissões **sem** entradas explícitas na lista de permissões. Os safe bins rejeitam
argumentos posicionais de arquivo e tokens com aparência de caminho, de modo que só possam operar sobre o stream de entrada.
Encadeamento de shell e redirecionamentos não são automaticamente permitidos no modo de lista de permissões.

Encadeamento de shell (`&&`, `||`, `;`) é permitido quando cada segmento de nível superior satisfaz a lista de permissões
(incluindo safe bins ou auto-permissão de Skills). Redirecionamentos continuam não suportados no modo de lista de permissões.
Substituição de comandos (`$()` / crases) é rejeitada durante a análise da lista de permissões, inclusive dentro de
aspas duplas; use aspas simples se precisar de texto literal `$()`.

Safe bins padrão: `jq`, `grep`, `cut`, `sort`, `uniq`, `head`, `tail`, `tr`, `wc`.

## Edição pela Control UI

Use o cartão **Control UI → Nodes → Exec approvals** para editar padrões, substituições
por agente e listas de permissões. Escolha um escopo (Padrões ou um agente), ajuste a política,
adicione/remova padrões da lista de permissões e clique em **Save**. A UI mostra metadados de **last used**
por padrão para que você mantenha a lista organizada.

O seletor de destino escolhe **Gateway** (aprovações locais) ou um **Node**. Os nós
devem anunciar `system.execApprovals.get/set` (app macOS ou host de nó headless).
Se um nó ainda não anunciar aprovações de exec, edite diretamente seu
`~/.openclaw/exec-approvals.json` local.

CLI: `openclaw approvals` oferece suporte à edição no gateway ou no nó (veja [Approvals CLI](/cli/approvals)).

## Fluxo de aprovação

Quando um prompt é necessário, o gateway transmite `exec.approval.requested` para os clientes operadores.
A Control UI e o app macOS resolvem isso via `exec.approval.resolve`, e então o gateway encaminha a
solicitação aprovada para o host de nó.

Quando aprovações são necessárias, a ferramenta exec retorna imediatamente com um id de aprovação. Use esse id para
correlacionar eventos de sistema posteriores (`Exec finished` / `Exec denied`). Se nenhuma decisão chegar antes do
timeout, a solicitação é tratada como timeout de aprovação e exibida como um motivo de negação.

O diálogo de confirmação inclui:

- comando + argumentos
- cwd
- id do agente
- caminho do executável resolvido
- host + metadados de política

Ações:

- **Allow once** → executar agora
- **Always allow** → adicionar à lista de permissões + executar
- **Deny** → bloquear

## Encaminhamento de aprovação para canais de chat

Você pode encaminhar prompts de aprovação de exec para qualquer canal de chat (incluindo canais de plugin) e aprová-los
com `/approve`. Isso usa o pipeline normal de entrega de saída.

Configuração:

```json5
{
  approvals: {
    exec: {
      enabled: true,
      mode: "session", // "session" | "targets" | "both"
      agentFilter: ["main"],
      sessionFilter: ["discord"], // substring or regex
      targets: [
        { channel: "slack", to: "U12345678" },
        { channel: "telegram", to: "123456789" },
      ],
    },
  },
}
```

Responder no chat:

```
/approve <id> allow-once
/approve <id> allow-always
/approve <id> deny
```

### Fluxo de IPC no macOS

```
Gateway -> Node Service (WS)
                 |  IPC (UDS + token + HMAC + TTL)
                 v
             Mac App (UI + approvals + system.run)
```

Notas de segurança:

- Modo de socket Unix `0600`, token armazenado em `exec-approvals.json`.
- Verificação de peer com o mesmo UID.
- Desafio/resposta (nonce + token HMAC + hash da solicitação) + TTL curto.

## Eventos do sistema

O ciclo de vida do exec é exposto como mensagens do sistema:

- `Exec running` (somente se o comando exceder o limite de aviso de execução)
- `Exec finished`
- `Exec denied`

Esses eventos são publicados na sessão do agente após o nó reportar o evento.
Aprovações de exec no host do Gateway emitem os mesmos eventos de ciclo de vida quando o comando termina (e opcionalmente quando executa por mais tempo que o limite).
Execs com aprovação reutilizam o id de aprovação como o `runId` nessas mensagens para facilitar a correlação.

## Implicações

- **full** é poderoso; prefira listas de permissões quando possível.
- **ask** mantém você no controle enquanto ainda permite aprovações rápidas.
- Listas de permissões por agente evitam que aprovações de um agente vazem para outros.
- As aprovações se aplicam apenas a solicitações de exec no host vindas de **remetentes autorizados**. Remetentes não autorizados não podem emitir `/exec`.
- `/exec security=full` é uma conveniência em nível de sessão para operadores autorizados e ignora aprovações por design.
  Para bloquear rigidamente exec no host, defina a segurança de aprovações como `deny` ou negue a ferramenta `exec` via política de ferramentas.

Relacionado:

- [Exec tool](/tools/exec)
- [Elevated mode](/tools/elevated)
- [Skills](/tools/skills)
