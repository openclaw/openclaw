# Plano: Agente de Criação de Sites via WhatsApp

## Decisão: OpenClaw + Lovable API ✓

**Stack Completa:**
- **OpenClaw** - Gateway WhatsApp + orquestração
- **Lovable API** - Criação de sites
- **Playwright MCP** - Screenshots de referências
- **Stripe MCP** - Pagamentos (cobrança única + assinatura)

---

## Guardrails: Mantendo o Agente Focado

### Problema
Sem limitações, o agente pode virar um "faz-tudo" e responder qualquer pedido do cliente, perdendo o foco no objetivo de criar sites.

### Solução: System Prompt com Escopo Definido

```markdown
## IDENTIDADE
Você é um assistente especializado EXCLUSIVAMENTE em criação de sites.
Seu nome é [Nome do Agente].

## OBJETIVO ÚNICO
Ajudar clientes a criar sites profissionais seguindo este workflow:
1. Coletar briefing do projeto
2. Mostrar referências de design
3. Criar o site via Lovable
4. Entregar o site com domínio personalizado

## ESCOPO PERMITIDO
✅ Perguntas sobre o site a ser criado
✅ Discussão de design, cores, funcionalidades
✅ Mostrar referências e templates
✅ Status do projeto em andamento
✅ Alterações no site durante criação
✅ Informações sobre preços e prazos
✅ Envio de links de pagamento (Stripe)
✅ Confirmação de pagamento e entrega

## FORA DO ESCOPO (RECUSAR EDUCADAMENTE)
❌ Perguntas gerais não relacionadas a sites
❌ Pedidos para fazer outras tarefas (pesquisas, textos, etc.)
❌ Suporte técnico de outros sistemas
❌ Conversas pessoais ou off-topic

## RESPOSTA PADRÃO PARA FORA DO ESCOPO
"Desculpe, sou especializado apenas em criação de sites!
Se você tem interesse em criar um site profissional para seu negócio,
posso te ajudar. Caso contrário, não consigo auxiliar com esse assunto."

## WORKFLOW OBRIGATÓRIO
Sempre seguir estas etapas na ordem:
1. BRIEFING → Não avançar sem ter: tipo de negócio, objetivo do site
2. REFERÊNCIAS → Mostrar opções antes de criar
3. APROVAÇÃO → Cliente deve aprovar design antes de criar
4. CRIAÇÃO → Só criar após aprovação
5. REVISÕES → Máximo 3 rodadas de ajustes
6. ENTREGA → Confirmar satisfação antes de finalizar
```

### Implementação no OpenClaw

No OpenClaw, isso é configurado via **System Prompt** no arquivo de configuração:

```yaml
# openclaw/config/agents/website-builder.yaml
name: "Website Builder Agent"
model: "claude-sonnet-4-20250514"
system_prompt: |
  [Cole o system prompt acima aqui]

allowed_tools:
  - whatsapp-mcp      # Comunicação
  - playwright-mcp    # Screenshots
  - lovable-api       # Criar sites
  - stripe-mcp        # Pagamentos
  # NÃO incluir outros MCPs que permitam ações fora do escopo

blocked_patterns:
  - "me ajuda com"
  - "pode fazer"
  - "preciso de um texto"
  - "pesquisa sobre"
```

---

## Isolamento de Contexto por Cliente

### Problema
Sem isolamento, mensagens de diferentes clientes podem se misturar, causando:
- Agente responder sobre o site do Cliente A para o Cliente B
- Perda de contexto do briefing
- Confusão no workflow

### Solução: Session Management do OpenClaw

O OpenClaw já possui **Session Router** nativo que isola conversas automaticamente.

#### Como Funciona

```
Cliente A (WhatsApp: +55119999-0001)
    ↓
Session Key: agent:website-builder:whatsapp:+5511999990001
    ↓
Memória isolada: memory/+5511999990001/MEMORY.md
    ↓
Contexto separado: briefing, referências, status do projeto
```

```
Cliente B (WhatsApp: +55119999-0002)
    ↓
Session Key: agent:website-builder:whatsapp:+5511999990002
    ↓
Memória isolada: memory/+5511999990002/MEMORY.md
    ↓
Contexto totalmente independente do Cliente A
```

#### Configuração no OpenClaw

```yaml
# config/session.yaml
session:
  dmScope: "per-peer"           # Cada número = sessão separada
  groupScope: "per-group"       # Cada grupo = sessão separada
  memoryPath: "memory/{peerId}" # Pasta separada por cliente

  # Concorrência
  laneQueue:
    enabled: true               # Evita race conditions
    maxConcurrent: 5            # Máx conversas simultâneas
```

#### Estrutura de Memória por Cliente

```
openclaw/
├── memory/
│   ├── +5511999990001/          # Cliente A
│   │   ├── MEMORY.md            # Memória persistente
│   │   ├── 2026-02-03.md        # Log diário
│   │   └── project.json         # Estado do projeto
│   │       {
│   │         "status": "aguardando_aprovacao",
│   │         "briefing": {...},
│   │         "referencias": [...],
│   │         "lovable_project_id": "abc123"
│   │       }
│   │
│   ├── +5511999990002/          # Cliente B
│   │   ├── MEMORY.md
│   │   └── project.json
│   │       {
│   │         "status": "coletando_briefing",
│   │         "briefing": null
│   │       }
```

#### Estado do Projeto por Cliente

```python
# skills/session_manager.py

class ClientSession:
    def __init__(self, phone_number):
        self.phone = phone_number
        self.session_path = f"memory/{phone_number}"

    def get_state(self):
        """Retorna estado atual do projeto deste cliente"""
        return load_json(f"{self.session_path}/project.json")

    def update_state(self, **kwargs):
        """Atualiza estado sem afetar outros clientes"""
        state = self.get_state()
        state.update(kwargs)
        save_json(f"{self.session_path}/project.json", state)

    def get_context_for_llm(self):
        """Carrega contexto específico deste cliente para o prompt"""
        return f"""
        ## Cliente Atual: {self.phone}
        ## Status: {self.get_state()['status']}
        ## Briefing: {self.get_state().get('briefing', 'Não coletado')}
        ## Histórico: {self.load_memory()}
        """

# Uso no handler de mensagens
def handle_message(phone_number, message):
    session = ClientSession(phone_number)
    context = session.get_context_for_llm()

    # LLM recebe apenas contexto deste cliente
    response = llm.generate(
        system_prompt + context,
        message
    )
    return response
```

#### Diagrama de Isolamento

```
┌─────────────────────────────────────────────────────────────┐
│                    MENSAGENS WHATSAPP                       │
│  [+55..001: "oi"]  [+55..002: "muda cor"]  [+55..001: "ok"] │
└──────────────────────────┬──────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────┐
│                    SESSION ROUTER                           │
│            Roteia por phone_number (peer_id)                │
└──────┬───────────────────┬───────────────────┬──────────────┘
       │                   │                   │
       ▼                   ▼                   ▼
┌──────────────┐   ┌──────────────┐   ┌──────────────┐
│ Session 001  │   │ Session 002  │   │ Session 001  │
│              │   │              │   │ (mesma)      │
│ Contexto A   │   │ Contexto B   │   │ Contexto A   │
│ Memória A    │   │ Memória B    │   │ Memória A    │
└──────────────┘   └──────────────┘   └──────────────┘
       │                   │                   │
       ▼                   ▼                   ▼
┌─────────────────────────────────────────────────────────────┐
│                       LLM (Claude)                          │
│  Cada request recebe APENAS o contexto da sessão atual      │
└─────────────────────────────────────────────────────────────┘
```

#### Lane Queue (Concorrência)

```python
# Evita que duas mensagens do mesmo cliente sejam processadas ao mesmo tempo
# (ex: cliente manda "oi" e "tudo bem" em sequência rápida)

lane_queue = {
    "+5511999990001": Lock(),  # Processa uma msg por vez
    "+5511999990002": Lock(),
}

async def process_message(phone, message):
    async with lane_queue[phone]:
        # Garante ordem cronológica por cliente
        # Outros clientes não são bloqueados
        await handle_message(phone, message)
```

### Técnicas Adicionais de Controle

1. **Whitelist de Intenções**
```python
ALLOWED_INTENTS = [
    "criar_site",
    "ver_referencias",
    "alterar_design",
    "status_projeto",
    "informacoes_preco",
    "aprovar_design",
    "pagar",
    "ver_cobranca",
    "confirmar_pagamento"
]

def classify_intent(message):
    # Classifica a intenção do usuário
    # Se não estiver na whitelist, recusa educadamente
```

2. **Estado da Conversa (FSM)**
```
ESTADOS:
  INICIAL → COLETANDO_BRIEFING → MOSTRANDO_REFERENCIAS →
  AGUARDANDO_APROVACAO → CRIANDO_SITE → REVISOES → FINALIZADO

Regra: Só permitir ações válidas para o estado atual
Ex: Não pode pedir "cria o site" se ainda está em COLETANDO_BRIEFING
```

3. **Limitação de MCPs**
- Só carregar MCPs necessários para o workflow
- Não dar acesso a ferramentas genéricas (bash, file system, etc.)

---

## Arquitetura Proposta

```
┌─────────────────────────────────────────────────────────────┐
│                    CLIENTE (WhatsApp)                        │
└──────────────────────────┬──────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────┐
│                    OPENCLAW (Gateway)                        │
│  - Atendimento conversacional                               │
│  - Memória persistente do cliente                           │
│  - Orquestração do workflow                                 │
│  - Integração WhatsApp nativa                               │
└──────────────────────────┬──────────────────────────────────┘
                           │
           ┌───────────────┼───────────────┐
           ▼               ▼               ▼
┌──────────────┐  ┌──────────────┐  ┌──────────────┐
│ PLAYWRIGHT   │  │ LOVABLE      │  │ STRIPE MCP   │
│ MCP          │  │ API          │  │              │
│              │  │              │  │              │
│ - Screenshot │  │ - Criar site │  │ - Cobrança   │
│   referências│  │ - Deploy     │  │ - Assinatura │
└──────────────┘  └──────────────┘  └──────────────┘
```

---

## Workflow Detalhado

### Fase 1: Atendimento Inicial (OpenClaw)
1. Cliente envia mensagem no WhatsApp
2. OpenClaw coleta briefing (tipo de negócio, estilo, cores, funcionalidades)
3. Pergunta se cliente tem referências ou precisa de sugestões

### Fase 2: Pesquisa de Referências
**Opção A - Cliente não tem referências:**
- OpenClaw aciona **Playwright MCP** para:
  - Navegar em ThemeForest, Dribbble, Awwwards
  - Buscar por categoria do negócio
  - Tirar screenshots das melhores opções
  - Enviar 3-5 opções via WhatsApp para aprovação

**Opção B - Cliente tem referências:**
- Cliente envia URL ou imagem
- Playwright MCP faz screenshot para contexto

### Fase 3: Criação do Site

**Via Lovable API:**
- API permite criar sites programaticamente
- Já inclui hosting
- Custom domain disponível ($25/mês plano Pro)
- Rápido para prototipar

### Fase 4: Deploy e Domain
1. Site criado é deployado automaticamente
2. **Custom domain:** Configurar DNS para domínio personalizado
3. Mascarar origem (Lovable) com domínio próprio

### Fase 5: Cobrança (Stripe MCP)
1. Gerar **Payment Link** para cobrança única
2. Criar **Subscription** para mensalidade
3. Enviar links via WhatsApp
4. Monitorar pagamento via webhook

---

## Workflow de Desenvolvimento (Claude Code + GitHub + Coolify)

### Visão Geral

```
┌─────────────────────────────────────────────────────────────┐
│                    DESENVOLVIMENTO                          │
│                                                             │
│   Você + Claude Code → Edita código → git push             │
│                                                             │
└──────────────────────────┬──────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────┐
│                    GITHUB                                   │
│                                                             │
│   Repo: seu-usuario/website-builder-agent                   │
│   - Webhook configurado pelo Coolify                        │
│                                                             │
└──────────────────────────┬──────────────────────────────────┘
                           │ (webhook automático)
                           ▼
┌─────────────────────────────────────────────────────────────┐
│                    COOLIFY                                  │
│                                                             │
│   - Detecta push no GitHub                                  │
│   - Build do Docker Compose                                 │
│   - Deploy automático                                       │
│   - Logs e monitoramento na UI                              │
│                                                             │
└──────────────────────────┬──────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────┐
│                    OPENCLAW (Container)                     │
│                                                             │
│   - Atende clientes 24/7 no WhatsApp                        │
│   - Memória persistente por cliente                         │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### Fluxo de Desenvolvimento

#### 1. Desenvolver Localmente com Claude Code

```bash
cd website-builder-agent
claude

# Exemplos de comandos:
> "Adiciona validação no briefing para exigir tipo de negócio"
> "Melhora o skill de busca de referências para incluir Dribbble"
> "Corrige bug no payment-handler quando Stripe retorna erro"
```

#### 2. Testar Localmente

```bash
docker-compose up -d
docker-compose logs -f openclaw
```

#### 3. Commit e Push

```bash
> "Faz commit das alterações e push para o GitHub"
```

#### 4. Deploy Automático (Coolify)

```
Claude Code → git push → GitHub → Webhook → Coolify → Build + Deploy
```

**Setup no Coolify:**
1. Conectar GitHub ao Coolify (Settings → GitHub App)
2. New Resource → Docker Compose → Selecionar repo
3. Auto-deploy já vem habilitado
4. Variáveis de ambiente na UI do Coolify

---

## Estrutura do Projeto

```
website-builder-agent/
├── openclaw/
│   ├── config/
│   │   ├── mcps.json          # MCPs: whatsapp, playwright, stripe
│   │   ├── session.yaml       # Isolamento por cliente
│   │   └── agents/
│   │       └── website-builder.yaml  # System prompt + guardrails
│   └── skills/
│       ├── briefing.js        # Coleta de briefing
│       ├── reference-search.js # Busca referências
│       ├── site-creator.js    # Integração Lovable API
│       ├── payment-handler.js # Stripe: cobrança + assinatura
│       └── deploy-handler.js  # Deploy + custom domain
├── templates/
│   └── messages/              # Templates de mensagem WhatsApp
├── data/                      # Ignorado no Git (volume Docker)
│   ├── memory/               # Memória persistente dos clientes
│   └── logs/
├── docker-compose.yml
├── Dockerfile
├── .env.example
├── .gitignore
└── README.md
```

---

## Arquivos de Configuração

### docker-compose.yml

```yaml
version: '3.8'

services:
  openclaw:
    build: .
    container_name: website-builder-agent
    restart: unless-stopped
    env_file:
      - .env
    volumes:
      - ./openclaw/config:/app/config
      - ./openclaw/skills:/app/skills
      - ./data/memory:/app/memory
      - ./data/logs:/app/logs
    ports:
      - "3000:3000"
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:3000/health"]
      interval: 30s
      timeout: 10s
      retries: 3
```

### .env.example

```bash
# APIs
ANTHROPIC_API_KEY=sk-ant-...
LOVABLE_API_KEY=...
STRIPE_SECRET_KEY=sk_live_...
STRIPE_WEBHOOK_SECRET=whsec_...

# WhatsApp
WHATSAPP_SESSION_PATH=/app/data/whatsapp

# OpenClaw
OPENCLAW_GATEWAY_TOKEN=seu-token-seguro
DEFAULT_MODEL=claude-sonnet-4-20250514

# Produção
NODE_ENV=production
LOG_LEVEL=info
```

### .gitignore

```gitignore
.env
*.key
*.pem
data/
memory/
node_modules/
*.log
.DS_Store
```

---

## Custos Projetados

**MVP (início):**
| Item | Custo/mês |
|------|-----------|
| Claude API | $100-200 |
| VPS (Coolify) | $20-40 |
| Lovable Pro | $25-50 |
| WhatsApp (pessoal) | $0 |
| Stripe | 2.9% + $0.30/tx |
| **Total** | **~$145-290** |

**Escala (20+ clientes):**
| Item | Custo/mês |
|------|-----------|
| Claude API | $200-400 |
| VPS | $40-80 |
| Lovable Pro/Team | $50-100 |
| WhatsApp Business API | $50-100 |
| Stripe | 2.9% + $0.30/tx |
| **Total** | **~$340-680** |

**Receita potencial:** 20 sites × R$500-2000 = R$10.000-40.000/mês

---

## Próximos Passos

1. [ ] Criar repositório GitHub
2. [ ] Configurar OpenClaw base
3. [ ] Implementar skill de briefing
4. [ ] Integrar Playwright MCP (screenshots)
5. [ ] Integrar Lovable API
6. [ ] Integrar Stripe MCP
7. [ ] Configurar Coolify para deploy
8. [ ] Testes end-to-end
9. [ ] Lançamento MVP
