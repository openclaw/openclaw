---
summary: "Workspace do agente: localização, layout e estratégia de backup"
read_when:
  - Você precisa explicar o workspace do agente ou seu layout de arquivo
  - Você quer fazer backup ou migrar um workspace de agente
title: "Workspace do Agente"
---

# Workspace do agente

O workspace é a casa do agente. É o único diretório de trabalho usado para ferramentas de arquivo e para contexto de workspace. Mantenha-o privado e trate-o como memória.

Isso é separado de `~/.openclaw/`, que armazena config, credenciais e sessões.

**Importante:** o workspace é o **cwd padrão**, não um sandbox rígido. Ferramentas resolvem caminhos relativos contra o workspace, mas caminhos absolutos ainda podem alcançar outro lugar no host a menos que sandboxing esteja habilitado. Se você precisar de isolamento, use [`agents.defaults.sandbox`](/gateway/sandboxing) (e/ou config de sandbox por agente).
Quando sandboxing está habilitado e `workspaceAccess` não é `"rw"`, ferramentas operam dentro de um workspace sandbox sob `~/.openclaw/sandboxes`, não seu workspace de host.

## Localização padrão

- Padrão: `~/.openclaw/workspace`
- Se `OPENCLAW_PROFILE` estiver definido e não for `"default"`, o padrão se torna `~/.openclaw/workspace-<profile>`.
- Sobrescrever em `~/.openclaw/openclaw.json`:

```json5
{
  agent: {
    workspace: "~/.openclaw/workspace",
  },
}
```

`openclaw onboard`, `openclaw configure`, ou `openclaw setup` criará o workspace e plantará os arquivos de bootstrap se estiverem faltando.

Se você já gerenciar os arquivos de workspace você mesmo, você pode desabilitar criação de arquivo de bootstrap:

```json5
{ agent: { skipBootstrap: true } }
```

## Pastas de workspace extra

Instalações mais antigas podem ter criado `~/openclaw`. Manter vários diretórios de workspace pode causar drift de autenticação confusa ou de estado, porque apenas um workspace está ativo por vez.

**Recomendação:** mantenha um único workspace ativo. Se você não usar mais os folders extras, arquive ou mova-os para a Lixeira (por exemplo `trash ~/openclaw`).
Se você intencionalmente manter múltiplos workspaces, certifique-se de que `agents.defaults.workspace` aponta para o ativo.

`openclaw doctor` avisa quando detecta diretórios de workspace extras.

## Mapa de arquivo do workspace (o que cada arquivo significa)

Estes são os arquivos padrão que OpenClaw espera dentro do workspace:

- `AGENTS.md`
  - Instruções operacionais para o agente e como deve usar memória.
  - Carregado no início de cada sessão.
  - Um bom lugar para regras, prioridades e detalhes de "como se comportar".

- `SOUL.md`
  - Persona, tom e limites.
  - Carregado cada sessão.

- `USER.md`
  - Quem é o usuário e como abordá-lo.
  - Carregado cada sessão.

- `IDENTITY.md`
  - Nome do agente, vibe e emoji.
  - Criado/atualizado durante o ritual de bootstrap.

- `TOOLS.md`
  - Notas sobre suas ferramentas locais e convenções.
  - Não controla disponibilidade de ferramenta; é apenas orientação.

- `HEARTBEAT.md`
  - Checklist opcional minúsculo para execuções de heartbeat.
  - Mantenha breve para evitar queima de token.

- `BOOT.md`
  - Checklist de inicialização opcional executado no reinício do gateway quando ganchos internos estão habilitados.
  - Mantenha breve; use a ferramenta de mensagem para envios de saída.

- `BOOTSTRAP.md`
  - Ritual de primeira execução único.
  - Apenas criado para um workspace totalmente novo.
  - Exclua-o após o ritual estar completo.

- `memory/YYYY-MM-DD.md`
  - Log diário de memória (um arquivo por dia).
  - Recomendado ler hoje + ontem no início da sessão.

- `MEMORY.md` (opcional)
  - Memória de longo prazo curada.
  - Só carregue na sessão principal privada (não contextos compartilhados/grupo).

Veja [Memória](/pt-BR/concepts/memory) para fluxo de trabalho e flush de memória automática.

- `skills/` (opcional)
  - Skills específicas de workspace.
  - Sobrescreve skills gerenciadas/agrupadas quando nomes colidem.

- `canvas/` (opcional)
  - Arquivos de UI Canvas para exibições de nó (por exemplo `canvas/index.html`).

Se algum arquivo de bootstrap estiver faltando, OpenClaw injeta um marcador "arquivo faltando" na sessão e continua. Arquivos de bootstrap grandes são truncados quando injetados; ajuste limites com `agents.defaults.bootstrapMaxChars` (padrão: 20000) e `agents.defaults.bootstrapTotalMaxChars` (padrão: 150000).
`openclaw setup` pode recriar padrões faltando sem sobrescrever arquivos existentes.

## O que NÃO está no workspace

Estes vivem sob `~/.openclaw/` e NÃO devem ser commitados para o repo do workspace:

- `~/.openclaw/openclaw.json` (config)
- `~/.openclaw/credentials/` (tokens OAuth, chaves de API)
- `~/.openclaw/agents/<agentId>/sessions/` (transcrições de sessão + metadados)
- `~/.openclaw/skills/` (skills gerenciadas)

Se você precisar migrar sessões ou config, copie-os separadamente e mantenha-os fora do controle de versão.

## Backup Git (recomendado, privado)

Trate o workspace como memória privada. Coloque-o em um repo git **privado** para que seja feito backup e recuperável.

Execute essas etapas na máquina onde o Gateway é executado (é onde o workspace vive).

### 1) Inicializar o repo

Se git estiver instalado, workspaces novíssimas são inicializadas automaticamente. Se este workspace não é já um repo, execute:

```bash
cd ~/.openclaw/workspace
git init
git add AGENTS.md SOUL.md TOOLS.md IDENTITY.md USER.md HEARTBEAT.md memory/
git commit -m "Add agent workspace"
```

### 2) Adicionar um remote privado (opções amigáveis para iniciantes)

Opção A: GitHub web UI

1. Crie um novo repositório **privado** no GitHub.
2. Não inicialize com um README (evita conflitos de merge).
3. Copie a URL remota HTTPS.
4. Adicione o remote e envie:

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

Opção C: GitLab web UI

1. Crie um novo repositório **privado** no GitLab.
2. Não inicialize com um README (evita conflitos de merge).
3. Copie a URL remota HTTPS.
4. Adicione o remote e envie:

```bash
git branch -M main
git remote add origin <https-url>
git push -u origin main
```

### 3) Atualizações contínuas

```bash
git status
git add .
git commit -m "Update memory"
git push
```

## Não comita segredos

Mesmo em um repo privado, evite armazenar segredos no workspace:

- Chaves de API, tokens OAuth, senhas ou credenciais privadas.
- Qualquer coisa sob `~/.openclaw/`.
- Despejo bruto de chats ou anexos sensíveis.

Se você deve armazenar referências sensíveis, use placeholders e mantenha o segredo real em outro lugar (gerenciador de senhas, variáveis de ambiente, ou `~/.openclaw/`).

Iniciador `.gitignore` sugerido:

```gitignore
.DS_Store
.env
**/*.key
**/*.pem
**/secrets*
```

## Movendo o workspace para uma nova máquina

1. Clone o repo para o caminho desejado (padrão `~/.openclaw/workspace`).
2. Defina `agents.defaults.workspace` para esse caminho em `~/.openclaw/openclaw.json`.
3. Execute `openclaw setup --workspace <path>` para plantar qualquer arquivo faltando.
4. Se você precisar de sessões, copie `~/.openclaw/agents/<agentId>/sessions/` dá máquina antiga separadamente.

## Notas avançadas

- Roteamento multi-agente pode usar diferentes workspaces por agente. Veja [Roteamento de canal](/channels/channel-routing) para configuração de roteamento.
- Se `agents.defaults.sandbox` estiver habilitado, sessões não-principais podem usar workspaces sandbox por-sessão sob `agents.defaults.sandbox.workspaceRoot`.
