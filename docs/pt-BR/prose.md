---
summary: "OpenProse: fluxos de trabalho .prose, comandos de barra e estado no OpenClaw"
read_when:
  - Você quer executar ou escrever fluxos de trabalho .prose
  - Você quer habilitar o plugin OpenProse
  - Você precisa entender o armazenamento de estado
title: "OpenProse"
---

# OpenProse

OpenProse é um formato de fluxo de trabalho portátil, orientado a markdown, para orquestrar sessões de IA. No OpenClaw, ele é distribuído como um plugin que instala um pacote de Skills do OpenProse além de um comando de barra `/prose`. Os programas vivem em arquivos `.prose` e podem gerar vários subagentes com controle de fluxo explícito.

Site oficial: [https://www.prose.md](https://www.prose.md)

## O que ele pode fazer

- Pesquisa e síntese com múltiplos agentes e paralelismo explícito.
- Fluxos de trabalho repetíveis e seguros para aprovação (revisão de código, triagem de incidentes, pipelines de conteúdo).
- Programas `.prose` reutilizáveis que você pode executar em runtimes de agentes compatíveis.

## Instalar + habilitar

Plugins incluídos vêm desativados por padrão. Habilite o OpenProse:

```bash
openclaw plugins enable open-prose
```

Reinicie o Gateway após habilitar o plugin.

Checkout de dev/local: `openclaw plugins install ./extensions/open-prose`

Documentos relacionados: [Plugins](/tools/plugin), [Manifesto de plugin](/plugins/manifest), [Skills](/tools/skills).

## Comando de barra

O OpenProse registra `/prose` como um comando de Skill invocável pelo usuário. Ele direciona para as instruções da VM do OpenProse e usa ferramentas do OpenClaw por baixo dos panos.

Comandos comuns:

```
/prose help
/prose run <file.prose>
/prose run <handle/slug>
/prose run <https://example.com/file.prose>
/prose compile <file.prose>
/prose examples
/prose update
```

## Exemplo: um arquivo `.prose` simples

```prose
# Research + synthesis with two agents running in parallel.

input topic: "What should we research?"

agent researcher:
  model: sonnet
  prompt: "You research thoroughly and cite sources."

agent writer:
  model: opus
  prompt: "You write a concise summary."

parallel:
  findings = session: researcher
    prompt: "Research {topic}."
  draft = session: writer
    prompt: "Summarize {topic}."

session "Merge the findings + draft into a final answer."
context: { findings, draft }
```

## Localização de arquivos

O OpenProse mantém o estado em `.prose/` no seu workspace:

```
.prose/
├── .env
├── runs/
│   └── {YYYYMMDD}-{HHMMSS}-{random}/
│       ├── program.prose
│       ├── state.md
│       ├── bindings/
│       └── agents/
└── agents/
```

Agentes persistentes em nível de usuário ficam em:

```
~/.prose/agents/
```

## Modos de estado

O OpenProse oferece suporte a vários backends de estado:

- **filesystem** (padrão): `.prose/runs/...`
- **in-context**: transitório, para programas pequenos
- **sqlite** (experimental): requer o binário `sqlite3`
- **postgres** (experimental): requer `psql` e uma string de conexão

Notas:

- sqlite/postgres são opcionais e experimentais.
- As credenciais do postgres fluem para os logs de subagentes; use um DB dedicado com privilégios mínimos.

## Programas remotos

`/prose run <handle/slug>` resolve para `https://p.prose.md/<handle>/<slug>`.
URLs diretas são buscadas como estão. Isso usa a ferramenta `web_fetch` (ou `exec` para POST). Isto usa a ferramenta `web_fetch` (ou `exec` para POST).

## Mapeamento de runtime do OpenClaw

Programas OpenProse mapeiam para primitivas do OpenClaw:

| Conceito do OpenProse                 | Ferramenta do OpenClaw |
| ------------------------------------- | ---------------------- |
| Iniciar sessão / Ferramenta de tarefa | `sessions_spawn`       |
| Leitura/gravação de arquivos          | `read` / `write`       |
| Busca Web                             | `web_fetch`            |

Se a lista de permissões de ferramentas bloquear essas ferramentas, os programas OpenProse falharão. Veja [Configuração de Skills](/tools/skills-config).

## Segurança + aprovações

Trate arquivos `.prose` como código. Revise antes de executar. Use listas de permissões de ferramentas do OpenClaw e portões de aprovação para controlar efeitos colaterais.

Para fluxos de trabalho determinísticos e com aprovação obrigatória, compare com [Lobster](/tools/lobster).
