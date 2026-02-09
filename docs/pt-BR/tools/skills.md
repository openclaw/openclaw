---
summary: "Skills: gerenciadas vs workspace, regras de gating e conexão de config/env"
read_when:
  - Adicionar ou modificar skills
  - Alterar gating de skills ou regras de carregamento
title: "Skills"
---

# Skills (OpenClaw)

O OpenClaw usa pastas de skill **compatíveis com [AgentSkills](https://agentskills.io)** para ensinar o agente a usar ferramentas. Cada skill é um diretório que contém um `SKILL.md` com frontmatter YAML e instruções. O OpenClaw carrega **skills empacotadas** mais substituições locais opcionais e as filtra no momento do carregamento com base no ambiente, na configuração e na presença de binários.

## Locais e precedência

As skills são carregadas de **três** lugares:

1. **Skills empacotadas**: enviadas com a instalação (pacote npm ou OpenClaw.app)
2. **Skills gerenciadas/locais**: `~/.openclaw/skills`
3. **Skills de workspace**: `<workspace>/skills`

Se houver conflito de nome de skill, a precedência é:

`<workspace>/skills` (mais alta) → `~/.openclaw/skills` → skills empacotadas (mais baixa)

Além disso, você pode configurar pastas extras de skills (menor precedência) via
`skills.load.extraDirs` em `~/.openclaw/openclaw.json`.

## Skills por agente vs compartilhadas

Em configurações **multiagente**, cada agente tem seu próprio workspace. Isso significa:

- **Skills por agente** ficam em `<workspace>/skills` apenas para esse agente.
- **Skills compartilhadas** ficam em `~/.openclaw/skills` (gerenciadas/locais) e são visíveis
  para **todos os agentes** na mesma máquina.
- **Pastas compartilhadas** também podem ser adicionadas via `skills.load.extraDirs` (menor
  precedência) se você quiser um pacote comum de skills usado por vários agentes.

Se o mesmo nome de skill existir em mais de um lugar, aplica-se a precedência usual:
workspace vence, depois gerenciada/local e, por fim, empacotada.

## Plugins + skills

Plugins podem enviar suas próprias skills listando diretórios `skills` em
`openclaw.plugin.json` (caminhos relativos à raiz do plugin). As skills do plugin são carregadas
quando o plugin é ativado e participam das regras normais de precedência de skills.
Você pode aplicar gating a elas via `metadata.openclaw.requires.config` na entrada de configuração do plugin. Veja [Plugins](/tools/plugin) para descoberta/configuração e [Tools](/tools) para a
superfície de ferramentas que essas skills ensinam.

## ClawHub (instalação + sincronização)

O ClawHub é o registro público de skills do OpenClaw. Navegue em
[https://clawhub.com](https://clawhub.com). Use-o para descobrir, instalar, atualizar e fazer backup de skills.
Guia completo: [ClawHub](/tools/clawhub).

Fluxos comuns:

- Instalar uma skill no seu workspace:
  - `clawhub install <skill-slug>`
- Atualizar todas as skills instaladas:
  - `clawhub update --all`
- Sincronizar (varrer + publicar atualizações):
  - `clawhub sync --all`

Por padrão, `clawhub` instala em `./skills` sob o diretório de trabalho atual
(ou recorre ao workspace do OpenClaw configurado). O OpenClaw identifica isso como
`<workspace>/skills` na próxima sessão.

## Notas de segurança

- Trate skills de terceiros como **código não confiável**. Leia-as antes de habilitar.
- Prefira execuções em sandbox para entradas não confiáveis e ferramentas arriscadas. Veja [Sandboxing](/gateway/sandboxing).
- `skills.entries.*.env` e `skills.entries.*.apiKey` injetam segredos no processo **host**
  para aquele turno do agente (não no sandbox). Mantenha segredos fora de prompts e logs.
- Para um modelo de ameaças mais amplo e checklists, veja [Security](/gateway/security).

## Formato (AgentSkills + compatível com Pi)

`SKILL.md` deve incluir pelo menos:

```markdown
---
name: nano-banana-pro
description: Generate or edit images via Gemini 3 Pro Image
---
```

Notas:

- Seguimos a especificação AgentSkills para layout/intenção.
- O parser usado pelo agente embutido suporta apenas chaves de frontmatter de **linha única**.
- `metadata` deve ser um **objeto JSON de linha única**.
- Use `{baseDir}` nas instruções para referenciar o caminho da pasta da skill.
- Chaves opcionais de frontmatter:
  - `homepage` — URL exibida como “Website” na UI de Skills do macOS (também suportado via `metadata.openclaw.homepage`).
  - `user-invocable` — `true|false` (padrão: `true`). Quando `true`, a skill é exposta como um comando de barra para o usuário.
  - `disable-model-invocation` — `true|false` (padrão: `false`). Quando `true`, a skill é excluída do prompt do modelo (ainda disponível via invocação do usuário).
  - `command-dispatch` — `tool` (opcional). Quando definido como `tool`, o comando de barra ignora o modelo e despacha diretamente para uma ferramenta.
  - `command-tool` — nome da ferramenta a invocar quando `command-dispatch: tool` estiver definido.
  - `command-arg-mode` — `raw` (padrão). Para despacho de ferramenta, encaminha a string bruta de argumentos para a ferramenta (sem parsing do core).

    A ferramenta é invocada com os parâmetros:
    `{ command: "<raw args>", commandName: "<slash command>", skillName: "<skill name>" }`.

## Gating (filtros em tempo de carregamento)

O OpenClaw **filtra skills no momento do carregamento** usando `metadata` (JSON de linha única):

```markdown
---
name: nano-banana-pro
description: Generate or edit images via Gemini 3 Pro Image
metadata:
  {
    "openclaw":
      {
        "requires": { "bins": ["uv"], "env": ["GEMINI_API_KEY"], "config": ["browser.enabled"] },
        "primaryEnv": "GEMINI_API_KEY",
      },
  }
---
```

Campos sob `metadata.openclaw`:

- `always: true` — sempre incluir a skill (ignora outros gates).
- `emoji` — emoji opcional usado pela UI de Skills do macOS.
- `homepage` — URL opcional exibida como “Website” na UI de Skills do macOS.
- `os` — lista opcional de plataformas (`darwin`, `linux`, `win32`). Se definido, a skill só é elegível nesses SOs.
- `requires.bins` — lista; cada item deve existir em `PATH`.
- `requires.anyBins` — lista; pelo menos um deve existir em `PATH`.
- `requires.env` — lista; a variável de ambiente deve existir **ou** ser fornecida na configuração.
- `requires.config` — lista de caminhos `openclaw.json` que devem ser truthy.
- `primaryEnv` — nome da variável de ambiente associada a `skills.entries.<name>.apiKey`.
- `install` — array opcional de especificações de instalador usadas pela UI de Skills do macOS (brew/node/go/uv/download).

Nota sobre sandboxing:

- `requires.bins` é verificado no **host** no momento do carregamento da skill.
- Se um agente estiver em sandbox, o binário também deve existir **dentro do container**.
  Instale-o via `agents.defaults.sandbox.docker.setupCommand` (ou uma imagem customizada).
  `setupCommand` roda uma vez após o container ser criado.
  Instalações de pacotes também exigem saída de rede, um FS raiz gravável e um usuário root no sandbox.
  Exemplo: a skill `summarize` (`skills/summarize/SKILL.md`) precisa do CLI `summarize`
  no container do sandbox para rodar ali.

Exemplo de instalador:

```markdown
---
name: gemini
description: Use Gemini CLI for coding assistance and Google search lookups.
metadata:
  {
    "openclaw":
      {
        "emoji": "♊️",
        "requires": { "bins": ["gemini"] },
        "install":
          [
            {
              "id": "brew",
              "kind": "brew",
              "formula": "gemini-cli",
              "bins": ["gemini"],
              "label": "Install Gemini CLI (brew)",
            },
          ],
      },
  }
---
```

Notas:

- Se vários instaladores forem listados, o gateway escolhe **uma única** opção preferida (brew quando disponível, caso contrário node).
- Se todos os instaladores forem `download`, o OpenClaw lista cada entrada para que você veja os artefatos disponíveis.
- As especificações de instalador podem incluir `os: ["darwin"|"linux"|"win32"]` para filtrar opções por plataforma.
- Instalações Node respeitam `skills.install.nodeManager` em `openclaw.json` (padrão: npm; opções: npm/pnpm/yarn/bun).
  Isso afeta apenas **instalações de skills**; o runtime do Gateway ainda deve ser Node
  (Bun não é recomendado para WhatsApp/Telegram).
- Instalações Go: se `go` estiver ausente e `brew` estiver disponível, o gateway instala o Go via Homebrew primeiro e define `GOBIN` para o `bin` do Homebrew quando possível.
- Instalações por download: `url` (obrigatório), `archive` (`tar.gz` | `tar.bz2` | `zip`), `extract` (padrão: auto quando um arquivo compactado é detectado), `stripComponents`, `targetDir` (padrão: `~/.openclaw/tools/<skillKey>`).

Se nenhum `metadata.openclaw` estiver presente, a skill é sempre elegível (a menos que
esteja desabilitada na configuração ou bloqueada por `skills.allowBundled` para skills empacotadas).

## Substituições de configuração (`~/.openclaw/openclaw.json`)

Skills empacotadas/gerenciadas podem ser alternadas e receber valores de env:

```json5
{
  skills: {
    entries: {
      "nano-banana-pro": {
        enabled: true,
        apiKey: "GEMINI_KEY_HERE",
        env: {
          GEMINI_API_KEY: "GEMINI_KEY_HERE",
        },
        config: {
          endpoint: "https://example.invalid",
          model: "nano-pro",
        },
      },
      peekaboo: { enabled: true },
      sag: { enabled: false },
    },
  },
}
```

Nota: se o nome da skill contiver hífens, coloque a chave entre aspas (JSON5 permite chaves entre aspas).

As chaves de configuração correspondem ao **nome da skill** por padrão. Se uma skill definir
`metadata.openclaw.skillKey`, use essa chave sob `skills.entries`.

Regras:

- `enabled: false` desabilita a skill mesmo se estiver empacotada/instalada.
- `env`: injetada **apenas se** a variável ainda não estiver definida no processo.
- `apiKey`: conveniência para skills que declaram `metadata.openclaw.primaryEnv`.
- `config`: bolsa opcional para campos customizados por skill; chaves customizadas devem ficar aqui.
- `allowBundled`: allowlist opcional apenas para skills **empacotadas**. Se definido, apenas
  skills empacotadas na lista são elegíveis (skills gerenciadas/workspace não são afetadas).

## Injeção de ambiente (por execução de agente)

Quando uma execução de agente começa, o OpenClaw:

1. Lê os metadados da skill.
2. Aplica quaisquer `skills.entries.<key>.env` ou `skills.entries.<key>.apiKey` a
   `process.env`.
3. Constrói o prompt do sistema com skills **elegíveis**.
4. Restaura o ambiente original após o término da execução.

Isso é **escopado à execução do agente**, não a um ambiente global de shell.

## Snapshot de sessão (performance)

O OpenClaw cria um snapshot das skills elegíveis **quando uma sessão começa** e reutiliza essa lista para turnos subsequentes na mesma sessão. Alterações em skills ou configuração entram em vigor na próxima nova sessão.

As skills também podem atualizar no meio da sessão quando o watcher de skills está habilitado ou quando um novo nó remoto elegível aparece (veja abaixo). Pense nisso como um **hot reload**: a lista atualizada é usada no próximo turno do agente.

## Nós macOS remotos (Gateway Linux)

Se o Gateway estiver rodando no Linux, mas um **nó macOS** estiver conectado **com `system.run` permitido** (segurança de aprovações Exec não definida como `deny`), o OpenClaw pode tratar skills exclusivas de macOS como elegíveis quando os binários necessários estiverem presentes nesse nó. O agente deve executar essas skills via a ferramenta `nodes` (normalmente `nodes.run`).

Isso depende do nó relatar seu suporte a comandos e de uma sondagem de binários via `system.run`. Se o nó macOS ficar offline posteriormente, as skills permanecem visíveis; as invocações podem falhar até o nó se reconectar.

## Skills watcher (autoatualização)

Por padrão, o OpenClaw observa pastas de skills e atualiza o snapshot de skills quando arquivos `SKILL.md` mudam. Configure isso em `skills.load`:

```json5
{
  skills: {
    load: {
      watch: true,
      watchDebounceMs: 250,
    },
  },
}
```

## Impacto em tokens (lista de skills)

Quando skills são elegíveis, o OpenClaw injeta uma lista XML compacta de skills disponíveis no prompt do sistema (via `formatSkillsForPrompt` em `pi-coding-agent`). O custo é determinístico:

- **Overhead base (apenas quando ≥1 skill):** 195 caracteres.
- **Por skill:** 97 caracteres + o comprimento dos valores `<name>`, `<description>` e `<location>` escapados em XML.

Fórmula (caracteres):

```
total = 195 + Σ (97 + len(name_escaped) + len(description_escaped) + len(location_escaped))
```

Notas:

- O escape XML expande `& < > " '` em entidades (`&amp;`, `&lt;`, etc.), aumentando o comprimento.
- A contagem de tokens varia por tokenizer de modelo. Uma estimativa no estilo OpenAI é ~4 chars/token, então **97 chars ≈ 24 tokens** por skill mais os comprimentos reais dos campos.

## Ciclo de vida de skills gerenciadas

O OpenClaw envia um conjunto base de skills como **skills empacotadas** como parte da
instalação (pacote npm ou OpenClaw.app). `~/.openclaw/skills` existe para substituições locais
(por exemplo, fixar/patchar uma skill sem alterar a cópia empacotada). Skills de workspace pertencem ao usuário e substituem ambas em conflitos de nome.

## Referência de configuração

Veja [Skills config](/tools/skills-config) para o esquema completo de configuração.

## Procurando mais skills?

Navegue em [https://clawhub.com](https://clawhub.com).

---
