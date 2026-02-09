---
summary: "Workspace do agente: localização, layout e estratégia de backup"
read_when:
  - Você precisa explicar o workspace do agente ou seu layout de arquivos
  - Você quer fazer backup ou migrar um workspace de agente
title: "Workspace do Agente"
---

# Workspace do agente

O workspace é a casa do agente. É o único diretório de trabalho usado para
ferramentas de arquivos e para o contexto do workspace. Mantenha-o privado e
trate-o como memória.

Isso é separado de `~/.openclaw/`, que armazena configuração, credenciais e
sessões.

**Importante:** o workspace é o **cwd padrão**, não um sandbox rígido. As
ferramentas resolvem caminhos relativos em relação ao workspace, mas caminhos
absolutos ainda podem alcançar outros locais no host, a menos que o sandboxing
esteja habilitado. Se você precisa de isolamento, use
[`agents.defaults.sandbox`](/gateway/sandboxing) (e/ou configuração de sandbox por agente).
Quando o sandboxing está habilitado e `workspaceAccess` não é `"rw"`, as
ferramentas operam dentro de um workspace em sandbox sob `~/.openclaw/sandboxes`, não no
workspace do host.

## Localização padrão

- Padrão: `~/.openclaw/workspace`
- Se `OPENCLAW_PROFILE` estiver definido e não for `"default"`, o padrão passa a
  ser `~/.openclaw/workspace-<profile>`.
- Substituição em `~/.openclaw/openclaw.json`:

```json5
{
  agent: {
    workspace: "~/.openclaw/workspace",
  },
}
```

`openclaw onboard`, `openclaw configure` ou `openclaw setup` criarão o workspace e
semearão os arquivos de bootstrap se estiverem ausentes.

Se você já gerencia os arquivos do workspace por conta própria, pode desativar
a criação de arquivos de bootstrap:

```json5
{ agent: { skipBootstrap: true } }
```

## Pastas extras do workspace

Instalações mais antigas podem ter criado `~/openclaw`. Manter vários
diretórios de workspace pode causar confusão de autenticação ou divergência de
estado, porque apenas um workspace fica ativo por vez.

**Recomendação:** mantenha um único workspace ativo. Se você não usa mais as
pastas extras, arquive-as ou mova-as para a Lixeira (por exemplo `trash ~/openclaw`).
Se você mantiver intencionalmente vários workspaces, garanta que
`agents.defaults.workspace` aponte para o ativo.

`openclaw doctor` avisa quando detecta diretórios extras de workspace.

## Mapa de arquivos do workspace (o que cada arquivo significa)

Estes são os arquivos padrão que o OpenClaw espera dentro do workspace:

- `AGENTS.md`
  - Instruções operacionais para o agente e como ele deve usar a memória.
  - Carregado no início de cada sessão.
  - Bom lugar para regras, prioridades e detalhes de “como se comportar”.

- `SOUL.md`
  - Persona, tom e limites.
  - Carregado em todas as sessões.

- `USER.md`
  - Quem é o usuário e como se dirigir a ele.
  - Carregado em todas as sessões.

- `IDENTITY.md`
  - Nome do agente, vibe e emoji.
  - Criado/atualizado durante o ritual de bootstrap.

- `TOOLS.md`
  - Anotações sobre suas ferramentas e convenções locais.
  - Não controla a disponibilidade de ferramentas; é apenas orientação.

- `HEARTBEAT.md`
  - Checklist pequeno opcional para execuções de heartbeat.
  - Mantenha curto para evitar gasto de tokens.

- `BOOT.md`
  - Checklist de inicialização opcional executado no reinício do gateway quando
    hooks internos estão habilitados.
  - Mantenha curto; use a ferramenta de mensagens para envios de saída.

- `BOOTSTRAP.md`
  - Ritual de primeira execução, único.
  - Criado apenas para um workspace totalmente novo.
  - Exclua após a conclusão do ritual.

- `memory/YYYY-MM-DD.md`
  - Log diário de memória (um arquivo por dia).
  - Recomendado ler hoje + ontem no início da sessão.

- `MEMORY.md` (opcional)
  - Memória de longo prazo curada.
  - Carregar apenas na sessão principal e privada (não em contextos
    compartilhados/de grupo).

Veja [Memory](/concepts/memory) para o fluxo de trabalho e o descarte automático
de memória.

- `skills/` (opcional)
  - Skills específicas do workspace.
  - Substitui Skills gerenciadas/empacotadas quando os nomes colidem.

- `canvas/` (opcional)
  - Arquivos de UI do Canvas para exibição de nós (por exemplo `canvas/index.html`).

Se algum arquivo de bootstrap estiver ausente, o OpenClaw injeta um marcador de
“arquivo ausente” na sessão e continua. Arquivos grandes de bootstrap são
truncados quando injetados; ajuste o limite com `agents.defaults.bootstrapMaxChars` (padrão: 20000).
`openclaw setup` pode recriar padrões ausentes sem sobrescrever arquivos
existentes.

## O que NÃO está no workspace

Eles ficam sob `~/.openclaw/` e NÃO devem ser versionados no repositório do
workspace:

- `~/.openclaw/openclaw.json` (configuração)
- `~/.openclaw/credentials/` (tokens OAuth, chaves de API)
- `~/.openclaw/agents/<agentId>/sessions/` (transcrições de sessão + metadados)
- `~/.openclaw/skills/` (Skills gerenciadas)

Se você precisar migrar sessões ou configuração, copie-os separadamente e
mantenha-os fora do controle de versão.

## Backup com Git (recomendado, privado)

Trate o workspace como memória privada. Coloque-o em um repositório git
**privado** para que fique com backup e recuperável.

Execute estas etapas na máquina onde o Gateway é executado (é lá que o workspace
fica).

### 1. Inicialize o repositório

Se o git estiver instalado, workspaces novos em folha são inicializados
automaticamente. Se este workspace ainda não for um repositório, execute:

```bash
cd ~/.openclaw/workspace
git init
git add AGENTS.md SOUL.md TOOLS.md IDENTITY.md USER.md HEARTBEAT.md memory/
git commit -m "Add agent workspace"
```

### 2. Adicione um remoto privado (opções amigáveis para iniciantes)

Opção A: Interface web do GitHub

1. Crie um novo repositório **privado** no GitHub.
2. Não inicialize com README (evita conflitos de merge).
3. Copie a URL HTTPS do remoto.
4. Adicione o remoto e faça o push:

```bash
git branch -M main
git remote add origin <https-url>
git push -u origin main
```

Opção B: GitHub CLI (`gh`)

```bash
gh auth login
gh repo create openclaw-workspace --private --source . --remote origin --push
```

Opção C: Interface web do GitLab

1. Crie um novo repositório **privado** no GitLab.
2. Não inicialize com README (evita conflitos de merge).
3. Copie a URL HTTPS do remoto.
4. Adicione o remoto e faça o push:

```bash
git branch -M main
git remote add origin <https-url>
git push -u origin main
```

### 3. Atualizações contínuas

```bash
git status
git add .
git commit -m "Update memory"
git push
```

## Não versione segredos

Mesmo em um repositório privado, evite armazenar segredos no workspace:

- Chaves de API, tokens OAuth, senhas ou credenciais privadas.
- Qualquer coisa sob `~/.openclaw/`.
- Dumps brutos de chats ou anexos sensíveis.

Se você precisar armazenar referências sensíveis, use placeholders e mantenha o
segredo real em outro lugar (gerenciador de senhas, variáveis de ambiente ou
`~/.openclaw/`).

Starter sugerido para `.gitignore`:

```gitignore
.DS_Store
.env
**/*.key
**/*.pem
**/secrets*
```

## Movendo o workspace para uma nova máquina

1. Clone o repositório para o caminho desejado (padrão `~/.openclaw/workspace`).
2. Defina `agents.defaults.workspace` para esse caminho em `~/.openclaw/openclaw.json`.
3. Execute `openclaw setup --workspace <path>` para semear quaisquer arquivos ausentes.
4. Se você precisar de sessões, copie `~/.openclaw/agents/<agentId>/sessions/` da
   máquina antiga separadamente.

## Notas avançadas

- O roteamento multiagente pode usar workspaces diferentes por agente. Veja
  [Channel routing](/channels/channel-routing) para a configuração de roteamento.
- Se `agents.defaults.sandbox` estiver habilitado, sessões que não são a principal podem
  usar workspaces em sandbox por sessão sob `agents.defaults.sandbox.workspaceRoot`.
