---
summary: "Mover (migrar) uma instalação do OpenClaw de uma máquina para outra"
read_when:
  - Voce esta movendo o OpenClaw para um novo laptop/servidor
  - Voce quer preservar sessoes, autenticacao e logins de canais (WhatsApp, etc.)
title: "Guia de Migracao"
---

# Migrando o OpenClaw para uma nova maquina

Este guia migra um Gateway do OpenClaw de uma maquina para outra **sem refazer a integracao inicial**.

A migracao e simples conceitualmente:

- Copiar o **diretorio de estado** (`$OPENCLAW_STATE_DIR`, padrao: `~/.openclaw/`) — isso inclui configuracao, autenticacao, sessoes e estado dos canais.
- Copiar seu **workspace** (`~/.openclaw/workspace/` por padrao) — isso inclui seus arquivos de agente (memoria, prompts, etc.).

Mas existem armadilhas comuns relacionadas a **perfis**, **permissoes** e **copias parciais**.

## Antes de comecar (o que voce esta migrando)

### 1. Identifique seu diretorio de estado

A maioria das instalacoes usa o padrao:

- **Diretorio de estado:** `~/.openclaw/`

Mas ele pode ser diferente se voce usa:

- `--profile <name>` (geralmente se torna `~/.openclaw-<profile>/`)
- `OPENCLAW_STATE_DIR=/some/path`

Se voce nao tiver certeza, execute na maquina **antiga**:

```bash
openclaw status
```

Procure por mencoes a `OPENCLAW_STATE_DIR` / perfil na saida. Se voce executa varios gateways, repita para cada perfil.

### 2. Identifique seu workspace

Padroes comuns:

- `~/.openclaw/workspace/` (workspace recomendado)
- uma pasta personalizada que voce criou

Seu workspace e onde arquivos como `MEMORY.md`, `USER.md` e `memory/*.md` ficam.

### 3. Entenda o que voce vai preservar

Se voce copiar **ambos** o diretorio de estado e o workspace, voce mantem:

- Configuracao do Gateway (`openclaw.json`)
- Perfis de autenticacao / chaves de API / tokens OAuth
- Historico de sessoes + estado do agente
- Estado dos canais (ex.: login/sessao do WhatsApp)
- Seus arquivos de workspace (memoria, notas de Skills, etc.)

Se voce copiar **apenas** o workspace (por exemplo, via Git), voce **nao** preserva:

- sessões
- credenciais
- logins de canais

Esses ficam em `$OPENCLAW_STATE_DIR`.

## Passos de migracao (recomendado)

### Passo 0 — Faca um backup (maquina antiga)

Na maquina **antiga**, pare o gateway primeiro para que os arquivos nao mudem no meio da copia:

```bash
openclaw gateway stop
```

(Opcional, mas recomendado) arquive o diretorio de estado e o workspace:

```bash
# Adjust paths if you use a profile or custom locations
cd ~
tar -czf openclaw-state.tgz .openclaw

tar -czf openclaw-workspace.tgz .openclaw/workspace
```

Se voce tiver varios perfis/diretorios de estado (ex.: `~/.openclaw-main`, `~/.openclaw-work`), arquive cada um.

### Passo 1 — Instale o OpenClaw na nova maquina

Na maquina **nova**, instale a CLI (e o Node, se necessario):

- Veja: [Install](/install)

Nesta etapa, tudo bem se a integracao inicial criar um `~/.openclaw/` novo — voce vai sobrescreve-lo no proximo passo.

### Passo 2 — Copie o diretorio de estado + workspace para a nova maquina

Copie **ambos**:

- `$OPENCLAW_STATE_DIR` (padrao `~/.openclaw/`)
- seu workspace (padrao `~/.openclaw/workspace/`)

Abordagens comuns:

- `scp` os tarballs e extrair
- `rsync -a` via SSH
- drive externo

Apos copiar, garanta que:

- Diretorios ocultos foram incluidos (ex.: `.openclaw/`)
- A propriedade dos arquivos esta correta para o usuario que executa o gateway

### Passo 3 — Execute o Doctor (migracoes + reparo de servicos)

Na maquina **nova**:

```bash
openclaw doctor
```

O Doctor e o comando “seguro e entediante”. Ele repara servicos, aplica migracoes de configuracao e alerta sobre incompatibilidades.

Em seguida:

```bash
openclaw gateway restart
openclaw status
```

## Armadilhas comuns (e como evita-las)

### Armadilha: incompatibilidade de perfil / diretorio de estado

Se voce executava o gateway antigo com um perfil (ou `OPENCLAW_STATE_DIR`), e o novo gateway usa um diferente, voce vera sintomas como:

- alteracoes de configuracao que nao entram em vigor
- canais ausentes / deslogados
- historico de sessoes vazio

Correcao: execute o gateway/servico usando o **mesmo** perfil/diretorio de estado que voce migrou e, em seguida, execute novamente:

```bash
openclaw doctor
```

### Armadilha: copiar apenas `openclaw.json`

`openclaw.json` nao e suficiente. Muitos provedores armazenam estado em:

- `$OPENCLAW_STATE_DIR/credentials/`
- `$OPENCLAW_STATE_DIR/agents/<agentId>/...`

Sempre migre a pasta `$OPENCLAW_STATE_DIR` inteira.

### Armadilha: permissoes / propriedade

Se voce copiou como root ou trocou de usuario, o gateway pode falhar ao ler credenciais/sessoes.

Correcao: garanta que o diretorio de estado + workspace pertencem ao usuario que executa o gateway.

### Armadilha: migrar entre modos remoto/local

- Se sua UI (WebUI/TUI) aponta para um gateway **remoto**, o host remoto possui o armazenamento de sessoes + workspace.
- Migrar seu laptop nao vai mover o estado do gateway remoto.

Se voce estiver em modo remoto, migre o **host do Gateway**.

### Armadilha: segredos em backups

`$OPENCLAW_STATE_DIR` contem segredos (chaves de API, tokens OAuth, credenciais do WhatsApp). Trate backups como segredos de producao:

- armazene de forma criptografada
- evite compartilhar por canais inseguros
- gire as chaves se suspeitar de exposicao

## Checklist de verificacao

Na nova maquina, confirme:

- `openclaw status` mostra o gateway em execucao
- Seus canais ainda estao conectados (ex.: o WhatsApp nao exige novo pareamento)
- O dashboard abre e mostra sessoes existentes
- Seus arquivos de workspace (memoria, configuracoes) estao presentes

## Relacionado

- [Doctor](/gateway/doctor)
- [Solução de problemas do Gateway](/gateway/troubleshooting)
- [Onde o OpenClaw armazena seus dados?](/help/faq#where-does-openclaw-store-its-data)
