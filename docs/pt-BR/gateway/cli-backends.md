---
summary: "Backends de CLI: fallback somente texto via CLIs de IA locais"
read_when:
  - Você quer um fallback confiável quando provedores de API falham
  - Você está executando Claude Code CLI ou outras CLIs de IA locais e quer reutilizá-las
  - Você precisa de um caminho somente texto, sem ferramentas, que ainda suporte sessões e imagens
title: "Backends de CLI"
---

# Backends de CLI (runtime de fallback)

O OpenClaw pode executar **CLIs de IA locais** como um **fallback somente texto** quando provedores de API estão fora do ar,
limitados por taxa ou temporariamente se comportando mal. Isso é intencionalmente conservador:

- **Ferramentas são desativadas** (sem chamadas de ferramenta).
- **Texto entra → texto sai** (confiável).
- **Sessões são suportadas** (para que turnos de acompanhamento permaneçam coerentes).
- **Imagens podem ser repassadas** se a CLI aceitar caminhos de imagem.

Isso foi projetado como uma **rede de segurança**, e não como o caminho principal. Use quando você
quiser respostas em texto que “sempre funcionam” sem depender de APIs externas.

## Início rápido para iniciantes

Você pode usar o Claude Code CLI **sem nenhuma configuração** (o OpenClaw envia um padrão integrado):

```bash
openclaw agent --message "hi" --model claude-cli/opus-4.6
```

O Codex CLI também funciona imediatamente:

```bash
openclaw agent --message "hi" --model codex-cli/gpt-5.3-codex
```

Se o seu gateway roda sob launchd/systemd e o PATH é mínimo, adicione apenas o
caminho do comando:

```json5
{
  agents: {
    defaults: {
      cliBackends: {
        "claude-cli": {
          command: "/opt/homebrew/bin/claude",
        },
      },
    },
  },
}
```

É isso. Sem chaves, sem configuração extra de autenticação além da própria CLI.

## Usando como fallback

Adicione um backend de CLI à sua lista de fallback para que ele só rode quando os modelos primários falharem:

```json5
{
  agents: {
    defaults: {
      model: {
        primary: "anthropic/claude-opus-4-6",
        fallbacks: ["claude-cli/opus-4.6", "claude-cli/opus-4.5"],
      },
      models: {
        "anthropic/claude-opus-4-6": { alias: "Opus" },
        "claude-cli/opus-4.6": {},
        "claude-cli/opus-4.5": {},
      },
    },
  },
}
```

Notas:

- Se você usar `agents.defaults.models` (lista de permissões), deve incluir `claude-cli/...`.
- Se o provedor primário falhar (autenticação, limites de taxa, timeouts), o OpenClaw
  tentará o backend de CLI em seguida.

## Visão geral da configuração

Todos os backends de CLI ficam em:

```
agents.defaults.cliBackends
```

Cada entrada é identificada por um **id de provedor** (por exemplo, `claude-cli`, `my-cli`).
O id do provedor se torna o lado esquerdo da sua referência de modelo:

```
<provider>/<model>
```

### Exemplo de configuração

```json5
{
  agents: {
    defaults: {
      cliBackends: {
        "claude-cli": {
          command: "/opt/homebrew/bin/claude",
        },
        "my-cli": {
          command: "my-cli",
          args: ["--json"],
          output: "json",
          input: "arg",
          modelArg: "--model",
          modelAliases: {
            "claude-opus-4-6": "opus",
            "claude-opus-4-5": "opus",
            "claude-sonnet-4-5": "sonnet",
          },
          sessionArg: "--session",
          sessionMode: "existing",
          sessionIdFields: ["session_id", "conversation_id"],
          systemPromptArg: "--system",
          systemPromptWhen: "first",
          imageArg: "--image",
          imageMode: "repeat",
          serialize: true,
        },
      },
    },
  },
}
```

## Como funciona

1. **Seleciona um backend** com base no prefixo do provedor (`claude-cli/...`).
2. **Constrói um prompt de sistema** usando o mesmo prompt do OpenClaw + contexto do workspace.
3. **Executa a CLI** com um id de sessão (se suportado) para que o histórico permaneça consistente.
4. **Analisa a saída** (JSON ou texto simples) e retorna o texto final.
5. **Persiste ids de sessão** por backend, para que acompanhamentos reutilizem a mesma sessão da CLI.

## Sessões

- Se a CLI suportar sessões, defina `sessionArg` (por exemplo, `--session-id`) ou
  `sessionArgs` (placeholder `{sessionId}`) quando o ID precisar ser inserido
  em várias flags.
- Se a CLI usar um **subcomando de retomada** com flags diferentes, defina
  `resumeArgs` (substitui `args` ao retomar) e opcionalmente `resumeOutput`
  (para retomadas não-JSON).
- `sessionMode`:
  - `always`: sempre enviar um id de sessão (novo UUID se nenhum estiver armazenado).
  - `existing`: enviar um id de sessão apenas se um tiver sido armazenado antes.
  - `none`: nunca enviar um id de sessão.

## Imagens (repasse)

Se sua CLI aceitar caminhos de imagem, defina `imageArg`:

```json5
imageArg: "--image",
imageMode: "repeat"
```

O OpenClaw gravará imagens base64 em arquivos temporários. Se `imageArg` estiver definido, esses
caminhos são passados como argumentos da CLI. Se `imageArg` estiver ausente, o OpenClaw anexa os
caminhos de arquivo ao prompt (injeção de caminho), o que é suficiente para CLIs que
carregam automaticamente arquivos locais a partir de caminhos simples
(comportamento do Claude Code CLI).

## Entradas / saídas

- `output: "json"` (padrão) tenta analisar JSON e extrair texto + id de sessão.
- `output: "jsonl"` analisa streams JSONL (Codex CLI `--json`) e extrai a
  última mensagem do agente mais `thread_id` quando presente.
- `output: "text"` trata stdout como a resposta final.

Modos de entrada:

- `input: "arg"` (padrão) passa o prompt como o último argumento da CLI.
- `input: "stdin"` envia o prompt via stdin.
- Se o prompt for muito longo e `maxPromptArgChars` estiver definido, stdin é usado.

## Padrões (integrados)

O OpenClaw envia um padrão para `claude-cli`:

- `command: "claude"`
- `args: ["-p", "--output-format", "json", "--dangerously-skip-permissions"]`
- `resumeArgs: ["-p", "--output-format", "json", "--dangerously-skip-permissions", "--resume", "{sessionId}"]`
- `modelArg: "--model"`
- `systemPromptArg: "--append-system-prompt"`
- `sessionArg: "--session-id"`
- `systemPromptWhen: "first"`
- `sessionMode: "always"`

O OpenClaw também envia um padrão para `codex-cli`:

- `command: "codex"`
- `args: ["exec","--json","--color","never","--sandbox","read-only","--skip-git-repo-check"]`
- `resumeArgs: ["exec","resume","{sessionId}","--color","never","--sandbox","read-only","--skip-git-repo-check"]`
- `output: "jsonl"`
- `resumeOutput: "text"`
- `modelArg: "--model"`
- `imageArg: "--image"`
- `sessionMode: "existing"`

Substitua apenas se necessário (comum: caminho absoluto de `command`).

## Limitações

- **Sem ferramentas do OpenClaw** (o backend de CLI nunca recebe chamadas de ferramenta). Algumas CLIs
  ainda podem executar suas próprias ferramentas de agente.
- **Sem streaming** (a saída da CLI é coletada e então retornada).
- **Saídas estruturadas** dependem do formato JSON da CLI.
- **Sessões do Codex CLI** retomam via saída de texto (sem JSONL), o que é menos
  estruturado do que a execução inicial `--json`. As sessões do OpenClaw ainda funcionam
  normalmente.

## Solução de problemas

- **CLI não encontrada**: defina `command` com um caminho completo.
- **Nome de modelo incorreto**: use `modelAliases` para mapear `provider/model` → modelo da CLI.
- **Sem continuidade de sessão**: garanta que `sessionArg` esteja definido e que `sessionMode` não seja
  `none` (o Codex CLI atualmente não consegue retomar com saída JSON).
- **Imagens ignoradas**: defina `imageArg` (e verifique se a CLI suporta caminhos de arquivo).
