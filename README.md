# 🌈 Iris — AI Assistant by QualiApps

> Fork do [OpenClaw](https://github.com/openclaw/openclaw) com identidade visual, plugins customizados e memória vetorial.

**Upstream:** [openclaw/openclaw](https://github.com/openclaw/openclaw)
**Branch de produção:** `iris/production`
**Upstream tracking:** `origin/main`

---

## Índice

1. [O que é a Iris?](#o-que-é-a-iris)
2. [Regra de Ouro: Isolamento](#regra-de-ouro-isolamento)
3. [Setup Rápido](#setup-rápido)
4. [Plugins Customizados](#plugins-customizados)
5. [Supabase: Tabelas e Migrations](#supabase-tabelas-e-migrations)
6. [Memória Vetorial (Embeddings)](#memória-vetorial-embeddings)
7. [Scripts Utilitários](#scripts-utilitários)
8. [Crons e Automações](#crons-e-automações)
9. [Configuração (openclaw.json)](#configuração-openclawjson)
10. [Atualizando do Upstream](#atualizando-do-upstream)
11. [Checklist de Deploy em Nova Máquina](#checklist-de-deploy-em-nova-máquina)

---

## O que é a Iris?

Iris é uma assistente de IA pessoal e empresarial criada pela [QualiApps](https://qualiapps.com.br), rodando em cima do OpenClaw. Ela opera via WhatsApp, Telegram e painel web, com memória persistente, plugins customizados e integrações com Google Workspace.

---

## Regra de Ouro: Isolamento

> **Este é um fork. Merges com upstream são inevitáveis.**
> Toda customização DEVE ser isolada para facilitar merges futuros.

1. **Plugins primeiro.** Feature pode ser plugin em `extensions/`? Faça como plugin.
2. **Config antes de código.** Resolve via `openclaw.json`? Não toque no source.
3. **Patches mínimos.** Se precisa alterar `src/`, mínimo necessário.
4. **PR upstream sempre.** Todo patch funcional deve virar PR pro upstream.
5. **Branding separado de lógica.** Branding é nosso pra sempre.
6. **Nunca commitar em `origin/main`.** Sempre em `iris/production`.

---

## Setup Rápido

### Pré-requisitos

- Node.js 22+
- pnpm
- Python 3.10+ (para scripts de indexação/busca)
- Conta Supabase (free tier funciona)
- API keys: Anthropic, OpenAI (embeddings)

### Build

```bash
pnpm install
pnpm build
node scripts/ui.js build
```

### Rodar o gateway

```bash
node dist/entry.js gateway start --port 18789
```

---

## Plugins Customizados

Os plugins próprios da Iris ficam em `extensions/` e são carregados via `plugins.load.paths` no `openclaw.json`.

### chat-history-supabase

Salva todas as mensagens (inbound + outbound) no Supabase em tempo real.

| Item      | Detalhe                                                   |
| --------- | --------------------------------------------------------- |
| Pasta     | `extensions/chat-history-supabase/`                       |
| Hooks     | `message_received`, `message_sent`, `message_transcribed` |
| Tabela    | `chat_messages`                                           |
| Migration | `extensions/chat-history-supabase/migration.sql`          |
| UI        | `/conversations` no painel web (iframe)                   |

**Config no openclaw.json:**

```json
"chat-history-supabase": {
  "enabled": true,
  "config": {
    "supabaseUrl": "https://SEU-PROJETO.supabase.co",
    "supabaseServiceKey": "eyJ...",
    "supabaseAnonKey": "eyJ..."
  }
}
```

### iris-handover

Gera um documento de handover estruturado antes de cada compactação de sessão. Salva local + Supabase com embedding vetorial.

| Item         | Detalhe                                                                               |
| ------------ | ------------------------------------------------------------------------------------- |
| Pasta        | `extensions/iris-handover/`                                                           |
| Hook         | `before_compaction`                                                                   |
| Tabela       | `handovers` (Supabase)                                                                |
| Migration    | `extensions/iris-handover/migration.sql`                                              |
| Output local | `memory/handover.md` (sobrescreve) + `memory/handovers/YYYY-MM-DD_HHhMM.md` (arquivo) |
| LLM          | Chamada API separada via @anthropic-ai/sdk (Sonnet)                                   |
| Embedding    | OpenAI text-embedding-3-small (1536 dims)                                             |

**Como funciona:**

1. Sessão atinge limite de contexto, sistema inicia compactação
2. Hook `before_compaction` dispara o plugin
3. Plugin lê: conversa, contatos, SOUL.md, handover anterior, daily log
4. Faz chamada API pro Anthropic (Sonnet) com prompt estruturado
5. Salva handover em `memory/handover.md` (lido pelo boot-md na próxima sessão)
6. Salva cópia com timestamp em `memory/handovers/`
7. Salva no Supabase com embedding gerado via OpenAI
8. Compactação normal do OpenClaw continua

**Config no openclaw.json:**

```json
"iris-handover": {
  "enabled": true,
  "config": {
    "anthropicApiKey": "${ANTHROPIC_API_KEY}",
    "supabaseUrl": "https://SEU-PROJETO.supabase.co",
    "supabaseServiceKey": "eyJ...",
    "model": "claude-sonnet-4-20250514",
    "ownerName": "NomeDoUsuario",
    "aiName": "Iris",
    "language": "pt-BR",
    "maxLines": 150,
    "contactsFile": "contacts-briefing.json",
    "soulFile": "SOUL.md",
    "outputFile": "memory/handover.md"
  }
}
```

---

## Supabase: Tabelas e Migrations

### Tabelas

| Tabela          | Plugin/Script         | Descrição                                 | Migration                                        |
| --------------- | --------------------- | ----------------------------------------- | ------------------------------------------------ |
| `chat_messages` | chat-history-supabase | Todas as mensagens (in/out) com metadata  | `extensions/chat-history-supabase/migration.sql` |
| `handovers`     | iris-handover         | Handovers com embedding vetorial          | `extensions/iris-handover/migration.sql`         |
| `memories`      | scripts (cron)        | Arquivos .md indexados com embedding      | Criada pelo `index_memories.py`                  |
| `sessions`      | scripts (cron)        | Conversas curadas indexadas com embedding | Criada pelo `index_sessions.py`                  |

### Como rodar migrations

1. Acesse o Supabase Dashboard > SQL Editor
2. Cole o conteúdo de cada arquivo `migration.sql`
3. Execute

**Ordem recomendada:**

1. `extensions/chat-history-supabase/migration.sql` (tabela chat_messages)
2. `extensions/iris-handover/migration.sql` (tabela handovers + função search_handovers)

### Funções SQL customizadas

| Função                                                | Tabela    | Descrição                                 |
| ----------------------------------------------------- | --------- | ----------------------------------------- |
| `search_handovers(query_embedding, threshold, count)` | handovers | Busca handovers por similaridade vetorial |

### Pós-migration

- [ ] Ativar **Realtime** na tabela `chat_messages` (Supabase Dashboard > Database > Replication)
- [ ] Verificar RLS policies estão ativas

---

## Memória Vetorial (Embeddings)

A Iris usa pgvector no Supabase para busca semântica em três fontes:

### 1. Memórias (arquivos .md)

- **Tabela:** `memories`
- **Indexação:** cron noturno `index_memories.py` (02:00)
- **Modelo:** OpenAI text-embedding-3-small (1536 dims)
- **Busca:** `python scripts/search_all.py "query" --only-memories`

### 2. Sessões (conversas curadas)

- **Tabela:** `sessions`
- **Indexação:** cron noturno `index_sessions.py` (01:30)
- **Curadoria prévia:** cron noturno `curate_daily.py` (01:00)
- **Busca:** `python scripts/search_all.py "query" --only-sessions`

### 3. Handovers

- **Tabela:** `handovers`
- **Indexação:** automática no momento da geração (plugin iris-handover)
- **Busca:** `python scripts/search_handovers.py "query"`

### Busca unificada

```bash
python scripts/search_all.py "urban permuta emival"          # busca em tudo
python scripts/search_all.py "urban" --only-memories         # só arquivos
python scripts/search_all.py "urban" --only-sessions         # só conversas
python scripts/search_handovers.py "contexto emocional"      # só handovers
python scripts/search_handovers.py --list                    # listar recentes
```

### Fallback

Se pgvector estiver offline ou arquivo for muito recente (< 24h), a Iris usa `memory_search` (Gemini) como fallback.

---

## Scripts Utilitários

| Script                                  | Função                                            |
| --------------------------------------- | ------------------------------------------------- |
| `scripts/search_all.py`                 | Busca semântica unificada (memories + sessions)   |
| `scripts/search_handovers.py`           | Busca semântica nos handovers                     |
| `scripts/index_memories.py`             | Indexa arquivos .md no Supabase (cron noturno)    |
| `scripts/index_sessions.py`             | Indexa sessões curadas no Supabase (cron noturno) |
| `scripts/curate_daily.py`               | Curadoria diária das conversas (cron noturno)     |
| `scripts/fetch_url.py`                  | Web scraping com Scrapling (bypassa anti-bot)     |
| `scripts/generate_contacts_briefing.py` | Gera contacts-briefing.json dos contatos          |

### Dependências Python

```bash
pip install httpx openai python-docx pymupdf yt-dlp scrapling youtube-transcript-api
```

---

## Crons e Automações

Crons são definidos em `~/.openclaw/cron/jobs.json` (formato CronStoreFile).

**IMPORTANTE:** Jobs NÃO vão no openclaw.json! O campo `cron` no openclaw.json é só config (enabled, store path). Zod `.strict()` rejeita chaves extras.

| Cron               | Horário             | Função                    |
| ------------------ | ------------------- | ------------------------- |
| Curadoria sessões  | 01:00               | `curate_daily.py`         |
| Indexação sessões  | 01:30               | `index_sessions.py`       |
| Indexação memórias | 02:00               | `index_memories.py`       |
| Heartbeat          | cada 6h             | Verificação de pendências |
| Email check        | seg-sex 7h-19h (1h) | Classifica emails         |

---

## Configuração (openclaw.json)

Arquivo principal: `~/.openclaw/openclaw.json`

### Seções importantes

| Seção                        | O que configura                                            |
| ---------------------------- | ---------------------------------------------------------- |
| `agents.defaults.model`      | Modelo padrão (ex: claude-opus-4-6)                        |
| `agents.defaults.workspace`  | Pasta do workspace (SOUL.md, MEMORY.md, etc.)              |
| `agents.defaults.compaction` | Modo de compactação e reserveTokensFloor                   |
| `agents.defaults.replyMode`  | "tool-only" para forçar uso do message tool                |
| `plugins.load.paths`         | Array de caminhos dos plugins customizados                 |
| `plugins.entries`            | Config de cada plugin (enabled + config)                   |
| `hooks.internal`             | Hooks internos (boot-md, message-logger, pattern-detector) |
| `channels`                   | Configuração dos canais (WhatsApp, Telegram)               |
| `bindings`                   | Mapeamento de chats para agentes                           |

### Validação Zod .strict()

O openclaw.json usa Zod `.strict()`. **ZERO campos extras permitidos.** Qualquer chave desconhecida = config inválido = gateway não inicia.

---

## Atualizando do Upstream

```bash
git fetch origin main
git log iris/production..origin/main --oneline
git merge origin/main
# resolver conflitos (branding = nosso, patches = nosso até PR aceito, resto = deles)
pnpm build
node scripts/ui.js build
```

Detalhes em [MERGE-GUIDE.md](./MERGE-GUIDE.md).

---

## Checklist de Deploy em Nova Máquina

### 1. Ambiente

- [ ] Node.js 22+ instalado
- [ ] pnpm instalado
- [ ] Python 3.10+ instalado com pip
- [ ] Git configurado

### 2. Repositório

```bash
git clone https://github.com/qualiobra/iris.git
cd iris
pnpm install
pnpm build
node scripts/ui.js build
```

### 3. Supabase

- [ ] Criar projeto no Supabase (ou usar existente)
- [ ] Habilitar extensão pgvector: `CREATE EXTENSION IF NOT EXISTS vector;`
- [ ] Rodar migration: `extensions/chat-history-supabase/migration.sql`
- [ ] Rodar migration: `extensions/iris-handover/migration.sql`
- [ ] Ativar Realtime na tabela `chat_messages`
- [ ] Anotar: URL do projeto, service_role key, anon key

### 4. API Keys

- [ ] Anthropic API key (agente principal + handover plugin)
- [ ] OpenAI API key (embeddings text-embedding-3-small)
- [ ] Definir como variáveis de ambiente ou no openclaw.json

### 5. Configuração

- [ ] Copiar/adaptar `openclaw.json` para `~/.openclaw/openclaw.json`
- [ ] Configurar `plugins.load.paths` com caminhos dos plugins:
  ```json
  "paths": [
    "CAMINHO/extensions/chat-history-supabase",
    "CAMINHO/extensions/iris-handover"
  ]
  ```
- [ ] Configurar `plugins.entries` com credenciais Supabase para ambos plugins
- [ ] Configurar canais (WhatsApp e/ou Telegram)
- [ ] Configurar bindings (quais chats vão pra qual agente)

### 6. Workspace

- [ ] Criar pasta do workspace (ex: `~/clawd/`)
- [ ] Criar arquivos base: `SOUL.md`, `USER.md`, `MEMORY.md`, `HEARTBEAT.md`, `AGENTS.md`
- [ ] Criar `contacts-briefing.json` (mapa de contatos phone -> nome)
- [ ] Criar pasta `memory/` para handovers e daily logs
- [ ] Criar pasta `scripts/` e copiar scripts de indexação/busca

### 7. Scripts Python

```bash
pip install httpx openai python-docx pymupdf yt-dlp scrapling youtube-transcript-api
```

### 8. Crons (após gateway rodando)

- [ ] Curadoria sessões: `curate_daily.py` às 01:00
- [ ] Indexação sessões: `index_sessions.py` às 01:30
- [ ] Indexação memórias: `index_memories.py` às 02:00
- [ ] Heartbeat: a cada 6h
- [ ] Criar via `/cron` no chat ou API

### 9. Iniciar

```bash
node dist/entry.js gateway start --port 18789
```

### 10. Verificar

- [ ] Gateway respondendo em `http://localhost:PORTA`
- [ ] WhatsApp/Telegram conectado
- [ ] Enviar mensagem teste, verificar se aparece no Supabase (`chat_messages`)
- [ ] Plugin iris-handover carregado (verificar logs do gateway)
- [ ] Busca vetorial: `python scripts/search_all.py "teste"`

---

## Status dos Patches

| Patch                    | Descrição                             | PR Upstream        |
| ------------------------ | ------------------------------------- | ------------------ |
| sessionKey fix           | sessionKey em deliverOutboundPayloads | ✅ Aceito (#27584) |
| senderMetadata           | Metadata do remetente nos plugins     | ⏳ Pendente        |
| replyMode tool-only      | Default tool-only pra agentes         | ⏳ Pendente        |
| normalizeBrazilianMobile | Normaliza +55 DDD9                    | ⏳ Pendente        |
| message_transcribed      | Hook pra transcrição de áudio         | ⏳ Pendente        |

**Meta:** zero patches. Tudo aceito upstream. Só branding fica.

---

_Mantido por Iris 🌈 — QualiApps_
