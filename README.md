# 🌈 Iris — AI Assistant by QualiApps

> Fork do [OpenClaw](https://github.com/openclaw/openclaw) com identidade visual e patches funcionais próprios.

---

## O que é a Iris?

Iris é uma assistente de IA pessoal e empresarial criada pela [QualiApps](https://qualiapps.com.br), rodando em cima do OpenClaw. Ela opera via WhatsApp, Telegram e painel web, com memória persistente, plugins customizados e integrações com Google Workspace.

**Upstream:** [openclaw/openclaw](https://github.com/openclaw/openclaw)  
**Branch de produção:** `iris/production`  
**Upstream tracking:** `origin/main`

---

## ⚠️ Regra de Ouro: Isolamento de Features

> **Este é um fork. Merges com upstream são inevitáveis.**  
> Toda customização DEVE ser isolada para facilitar merges futuros.

### Como criar features neste fork

1. **Plugins primeiro.** Se a feature pode ser um plugin em `extensions/`, faça como plugin. Plugins vivem em pasta separada e NUNCA conflitam com upstream.

2. **Config antes de código.** Se dá pra resolver via `openclaw.json`, não toque no source.

3. **Patches mínimos e cirúrgicos.** Se precisa alterar `src/`, altere o MÍNIMO necessário. Poucas linhas, bem localizadas. Nada de reescrever arquivos inteiros.

4. **PR upstream sempre.** Todo patch funcional deve virar PR pro upstream. Quando aceito, removemos nosso patch e o merge vem limpo.

5. **Branding separado de lógica.** Arquivos de branding (cores, logos, textos) são nossos pra sempre. Arquivos de lógica são temporários até o PR ser aceito.

6. **Nunca commitar em `origin/main`.** Sempre em `iris/production`.

### O que acontece se não seguir isso?

Exatamente o que aconteceu na v1: merge impossível, rewrite manual, dias de trabalho perdidos. A v2 existe pra não repetir esse erro.

---

## 📁 Estrutura de Customização

```
iris-2.0/
├── src/                    # Upstream + patches mínimos (12 arquivos)
│   ├── cli/banner.ts       # 🎨 Branding: "🌈 Iris" no CLI
│   ├── cli/tagline.ts      # 🎨 Branding: tagline customizada
│   └── ...                 # 🔧 Patches funcionais (ver MERGE-GUIDE.md)
├── ui/                     # Upstream + branding (5 arquivos)
│   ├── src/styles/base.css # 🎨 Cores roxo (#7C3AED)
│   ├── src/ui/app-render.ts# 🎨 Logo "IRIS by QualiApps"
│   └── public/             # 🎨 Favicons Iris
├── extensions/             # 🔌 Plugins próprios (ZERO conflito)
│   ├── handover/
│   ├── message-logger/
│   ├── pattern-detector/
│   └── smart-router-inbound/
├── MERGE-GUIDE.md          # 📖 Guia completo de merge upstream
└── README.md               # 📖 Este arquivo
```

### Legenda
- 🎨 **Branding** — customizações visuais permanentes (nunca viram PR)
- 🔧 **Patch** — funcionalidades temporárias (devem virar PR upstream)
- 🔌 **Plugin** — extensões isoladas (nunca conflitam)

---

## 🚀 Setup & Build

### Pré-requisitos
- Node.js 22+
- pnpm

### Build completo

```bash
pnpm install
pnpm build              # Compila o TypeScript (src/ → dist/)
node scripts/ui.js build # Compila a UI (ui/ → dist/control-ui/)
```

### Rodar o gateway

```bash
node dist/entry.js gateway start --port 18789
```

Ou via Task Scheduler ("OpenClaw Gateway") no Windows.

### Testes

```bash
pnpm test
```

---

## 🔄 Atualizando do Upstream

Resumo rápido (detalhes completos em [MERGE-GUIDE.md](./MERGE-GUIDE.md)):

```bash
git fetch origin main
git log iris/production..origin/main --oneline  # ver o que mudou
git merge origin/main                            # merge
# resolver conflitos (branding = nosso, patches = nosso até PR aceito, resto = deles)
pnpm build
node scripts/ui.js build
# testar tudo
```

---

## 📊 Status dos Patches

| Patch | Descrição | PR Upstream |
|-------|-----------|-------------|
| senderMetadata | Metadata do remetente nos plugins | ⏳ Pendente |
| replyMode tool-only | Default tool-only pra agentes | ⏳ Pendente |
| normalizeBrazilianMobile | Normaliza +55 DDD9 | ⏳ Pendente |
| message_transcribed | Hook pra transcrição de áudio | ⏳ Pendente |
| smart-router outbound | Roteamento de msgs saindo | ⏳ Pendente |

**Meta:** zero patches. Tudo aceito upstream. Só branding fica.

---

## 🔌 Plugins

| Plugin | Função |
|--------|--------|
| **handover** | Transferência de contexto entre sessões |
| **message-logger** | Log de todas as mensagens em `chat-history/` |
| **pattern-detector** | Detecta padrões (links, números, áudio) nas msgs |
| **smart-router-inbound** | Roteamento inteligente de msgs recebidas |

Plugins ficam em `extensions/` e são carregados automaticamente. Nunca conflitam com upstream.

---

## 📖 Documentação

- [MERGE-GUIDE.md](./MERGE-GUIDE.md) — Guia detalhado de merge upstream
- [OpenClaw Docs](https://docs.openclaw.ai) — Documentação do upstream
- [OpenClaw Source](https://github.com/openclaw/openclaw) — Repo original

---

*Mantido por Iris 🌈 — QualiApps*
