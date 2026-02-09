---
summary: "Uso da ferramenta Exec, modos de stdin e suporte a TTY"
read_when:
  - Ao usar ou modificar a ferramenta exec
  - Ao depurar comportamento de stdin ou TTY
title: "Ferramenta Exec"
---

# Ferramenta Exec

Execute comandos de shell no workspace. Suporta execução em primeiro plano + segundo plano via `process`.
Se `process` não for permitido, `exec` executa de forma síncrona e ignora `yieldMs`/`background`.
As sessões em segundo plano são delimitadas por agente; `process` só vê sessões do mesmo agente.

## Parâmetros

- `command` (obrigatório)
- `workdir` (padrão: cwd)
- `env` (substituições chave/valor)
- `yieldMs` (padrão 10000): coloca automaticamente em segundo plano após atraso
- `background` (bool): segundo plano imediatamente
- `timeout` (segundos, padrão 1800): encerra ao expirar
- `pty` (bool): executa em um pseudo-terminal quando disponível (CLIs somente TTY, agentes de código, UIs de terminal)
- `host` (`sandbox | gateway | node`): onde executar
- `security` (`deny | allowlist | full`): modo de aplicação para `gateway`/`node`
- `ask` (`off | on-miss | always`): prompts de aprovação para `gateway`/`node`
- `node` (string): id/nome do nó para `host=node`
- `elevated` (bool): solicita modo elevado (host do Gateway); `security=full` só é forçado quando o elevado resolve para `full`

Notas:

- `host` tem como padrão `sandbox`.
- `elevated` é ignorado quando o sandboxing está desativado (exec já roda no host).
- As aprovações `gateway`/`node` são controladas por `~/.openclaw/exec-approvals.json`.
- `node` requer um nó pareado (aplicativo complementar ou host de nó headless).
- Se vários nós estiverem disponíveis, defina `exec.node` ou `tools.exec.node` para selecionar um.
- Em hosts não Windows, o exec usa `SHELL` quando definido; se `SHELL` for `fish`, ele prefere `bash` (ou `sh`)
  de `PATH` para evitar scripts incompatíveis com fish, depois faz fallback para `SHELL` se nenhum existir.
- A execução no host (`gateway`/`node`) rejeita `env.PATH` e substituições de loader (`LD_*`/`DYLD_*`) para
  evitar sequestro de binários ou código injetado.
- Importante: o sandboxing está **desativado por padrão**. Se o sandboxing estiver desativado, `host=sandbox` executa diretamente no
  host do gateway (sem contêiner) e **não requer aprovações**. Para exigir aprovações, execute com
  `host=gateway` e configure as aprovações do exec (ou habilite o sandboxing).

## Configuração

- `tools.exec.notifyOnExit` (padrão: true): quando true, sessões de exec em segundo plano enfileiram um evento de sistema e solicitam um heartbeat ao sair.
- `tools.exec.approvalRunningNoticeMs` (padrão: 10000): emite um único aviso “em execução” quando um exec com aprovação demora mais que isso (0 desativa).
- `tools.exec.host` (padrão: `sandbox`)
- `tools.exec.security` (padrão: `deny` para sandbox, `allowlist` para gateway + nó quando não definido)
- `tools.exec.ask` (padrão: `on-miss`)
- `tools.exec.node` (padrão: não definido)
- `tools.exec.pathPrepend`: lista de diretórios a serem adicionados antes de `PATH` para execuções do exec.
- `tools.exec.safeBins`: binários seguros somente stdin que podem rodar sem entradas explícitas na allowlist.

Exemplo:

```json5
{
  tools: {
    exec: {
      pathPrepend: ["~/bin", "/opt/oss/bin"],
    },
  },
}
```

### Manipulação de PATH

- `host=gateway`: mescla seu `PATH` do shell de login no ambiente do exec. Substituições de `env.PATH` são
  rejeitadas para execução no host. O daemon em si ainda roda com um `PATH` mínimo:
  - macOS: `/opt/homebrew/bin`, `/usr/local/bin`, `/usr/bin`, `/bin`
  - Linux: `/usr/local/bin`, `/usr/bin`, `/bin`
- `host=sandbox`: executa `sh -lc` (shell de login) dentro do contêiner, então `/etc/profile` pode redefinir `PATH`.
  O OpenClaw adiciona `env.PATH` antes após o carregamento de perfil via uma variável de ambiente interna (sem interpolação de shell);
  `tools.exec.pathPrepend` também se aplica aqui.
- `host=node`: somente substituições de env não bloqueadas que você passar são enviadas ao nó. Substituições de `env.PATH` são
  rejeitadas para execução no host. Hosts de nó headless aceitam `PATH` apenas quando ele adiciona antes o PATH do host do nó
  (sem substituição). Nós macOS descartam totalmente substituições de `PATH`.

Vinculação de nó por agente (use o índice da lista de agentes na configuração):

```bash
openclaw config get agents.list
openclaw config set agents.list[0].tools.exec.node "node-id-or-name"
```

UI de controle: a aba Nodes inclui um pequeno painel “Exec node binding” para as mesmas configurações.

## Substituições de sessão (`/exec`)

Use `/exec` para definir padrões **por sessão** para `host`, `security`, `ask` e `node`.
Envie `/exec` sem argumentos para mostrar os valores atuais.

Exemplo:

```
/exec host=gateway security=allowlist ask=on-miss node=mac-1
```

## Modelo de autorização

`/exec` só é respeitado para **remetentes autorizados** (allowlists de canal/pareamento mais `commands.useAccessGroups`).
Ele atualiza **apenas o estado da sessão** e não grava configuração. Para desativar o exec de forma definitiva, negue-o via
política de ferramentas (`tools.deny: ["exec"]` ou por agente). Aprovações no host ainda se aplicam, a menos que você defina explicitamente
`security=full` e `ask=off`.

## Aprovações do Exec (aplicativo complementar / host do nó)

Agentes em sandbox podem exigir aprovação por solicitação antes que `exec` execute no gateway ou no host do nó.
Veja [Exec approvals](/tools/exec-approvals) para a política, allowlist e fluxo de UI.

Quando aprovações são exigidas, a ferramenta exec retorna imediatamente com
`status: "approval-pending"` e um id de aprovação. Após aprovado (ou negado / expirado),
o Gateway emite eventos de sistema (`Exec finished` / `Exec denied`). Se o comando ainda estiver
em execução após `tools.exec.approvalRunningNoticeMs`, um único aviso `Exec running` é emitido.

## Allowlist + bins seguros

A aplicação da allowlist corresponde **apenas a caminhos de binários resolvidos** (sem correspondência por basename). Quando
`security=allowlist`, comandos de shell são auto-permitidos somente se cada segmento do pipeline estiver
na allowlist ou for um bin seguro. Encadeamento (`;`, `&&`, `||`) e redirecionamentos são rejeitados no
modo de allowlist.

## Exemplos

Primeiro plano:

```json
{ "tool": "exec", "command": "ls -la" }
```

Segundo plano + polling:

```json
{"tool":"exec","command":"npm run build","yieldMs":1000}
{"tool":"process","action":"poll","sessionId":"<id>"}
```

Enviar teclas (estilo tmux):

```json
{"tool":"process","action":"send-keys","sessionId":"<id>","keys":["Enter"]}
{"tool":"process","action":"send-keys","sessionId":"<id>","keys":["C-c"]}
{"tool":"process","action":"send-keys","sessionId":"<id>","keys":["Up","Up","Enter"]}
```

Enviar (somente CR):

```json
{ "tool": "process", "action": "submit", "sessionId": "<id>" }
```

Colar (pulverizado por padrão):

```json
{ "tool": "process", "action": "paste", "sessionId": "<id>", "text": "line1\nline2\n" }
```

## apply_patch (experimental)

`apply_patch` é um subtool de `exec` para edições estruturadas em vários arquivos.
Habilite explicitamente:

```json5
{
  tools: {
    exec: {
      applyPatch: { enabled: true, allowModels: ["gpt-5.2"] },
    },
  },
}
```

Notas:

- Disponível apenas para modelos OpenAI/OpenAI Codex.
- A política de ferramentas ainda se aplica; `allow: ["exec"]` permite implicitamente `apply_patch`.
- A configuração fica em `tools.exec.applyPatch`.
