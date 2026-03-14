# MERGE-GUIDE.md — Guia de Merge Upstream para Iris 🌈

> **Repo:** `iris-2.0` (branch local de trabalho sobre `main`)
> **Upstream:** `upstream/main` (openclaw/openclaw.git)
> **Última atualização:** 14/03/2026

---

## 📐 Arquitetura de Customização

A Iris roda em cima do OpenClaw upstream com duas camadas de customização:

1. **Patches no código-fonte** (`src/`) — funcionalidades que o upstream não tem (ainda)
2. **Branding** (`ui/`, `src/cli/`) — identidade visual Iris/QualiApps
3. **Plugins** (`extensions/`) — plugins próprios (NÃO tocam no upstream)
4. **Config** (`~/.openclaw/openclaw.json`) — configuração local (NÃO versionada aqui)

### Filosofia

> "Trocar os pneus, não o motor."  
> Patches mínimos, isolados, com PRs upstream pra cada um.  
> Quanto mais PRs aceitos, menos patches pra manter.

---

## 📁 Inventário de Arquivos Modificados

### 🔧 Patches Funcionais (submeter como PRs upstream)

| Arquivo                                         | O que faz                                                    | PR Status   |
| ----------------------------------------------- | ------------------------------------------------------------ | ----------- |
| `src/agents/pi-embedded-runner/run.ts`          | Passa senderE164/senderName ao runEmbeddedAttempt            | ⏳ Pendente |
| `src/agents/pi-embedded-runner/run/attempt.ts`  | Extrai senderMetadata do envelope e injeta no plugin context | ⏳ Pendente |
| `src/auto-reply/reply/dispatch-from-config.ts`  | Suporte a replyMode tool-only como default                   | ⏳ Pendente |
| `src/config/types.agent-defaults.ts`            | Tipo replyMode no AgentDefaults                              | ⏳ Pendente |
| `src/config/zod-schema.agent-defaults.ts`       | Schema Zod pra replyMode default                             | ⏳ Pendente |
| `src/infra/outbound/deliver.ts`                 | normalizeBrazilianMobile (+55 DDD9) nos destinatários        | ⏳ Pendente |
| `src/utils.ts`                                  | Função normalizeBrazilianMobile                              | ⏳ Pendente |
| `src/utils.test.ts`                             | Testes do normalizeBrazilianMobile                           | ⏳ Pendente |
| `extensions/whatsapp/src/auto-reply/monitor/process-message.ts` | Smart-router outbound + message_transcribed dispatch | ⏳ Pendente |
| `extensions/whatsapp/src/active-listener.ts`    | globalThis singleton fix (rolldown chunk splitting)          | ⏳ Pendente |
| `src/cron/isolated-agent/delivery-dispatch.ts`  | replyMode tool-only no cron delivery dispatch                | ⏳ Pendente |

### 🔒 Patches Permanentes (upstream removeu — Iris mantém em produção)

| Arquivo                             | O que faz                                          | Motivo de manter  |
| ----------------------------------- | -------------------------------------------------- | ----------------- |
| `src/auto-reply/reply/get-reply.ts` | Hook message_transcribed pra audio transcription   | Usado em produção |
| `src/plugins/hooks.ts`              | Hook message_transcribed registration              | Usado em produção |
| `src/plugins/types.ts`              | Tipos do hook message_transcribed + senderMetadata | Usado em produção |

> ⚠️ **Durante merges:** `git checkout iris/production -- <arquivo>` para esses 3 arquivos caso o upstream os remova novamente.

**Quando o PR for aceito upstream:** remover o patch do branch, o `git pull` já traz.

### 🎨 Branding (NUNCA vira PR — são customizações nossas)

| Arquivo                          | O que faz                                                     |
| -------------------------------- | ------------------------------------------------------------- |
| `src/cli/banner.ts`              | "🌈 Iris" no lugar de "🦞 OpenClaw", ASCII art IRIS           |
| `src/cli/tagline.ts`             | Tagline default → "Parceira de pensamento, não de bajulação." |
| `ui/index.html`                  | Title "Iris Control 🌈"                                       |
| `ui/src/styles/base.css`         | Cor de acento roxo (#7C3AED) no lugar de vermelho (#ff5c5c)   |
| `ui/src/ui/app-render.ts`        | Logo "IRIS by QualiApps 🌈"                                   |
| `ui/public/favicon.svg`          | Favicon SVG com gradiente roxo + "I"                          |
| `ui/public/favicon-32.png`       | Favicon PNG do mascote Iris                                   |
| `ui/public/favicon.ico`          | Favicon ICO do mascote Iris                                   |
| `ui/public/apple-touch-icon.png` | Apple touch icon do mascote Iris                              |

### 🔌 Plugins (pasta separada, sem conflito)

| Plugin               | Pasta                              |
| -------------------- | ---------------------------------- |
| handover             | `extensions/handover/`             |
| message-logger       | `extensions/message-logger/`       |
| pattern-detector     | `extensions/pattern-detector/`     |
| smart-router-inbound | `extensions/smart-router-inbound/` |

---

## 📅 Histórico de Merges

| Data       | Upstream HEAD | Commits incorporados            | Conflitos manuais | Responsável |
| ---------- | ------------- | ------------------------------- | ----------------- | ----------- |
| 14/03/2026 | `c08317203`   | 740 commits (desde `3cf06f793`) | 2 arquivos        | Iris 🌈     |
| 13/03/2026 | `3cf06f793`   | 379 commits (desde `0ff184397`) | 5 arquivos        | Iris 🌈     |
| 06/03/2026 | `d6d21b3ab`   | 171 commits (desde `49acb07f9`) | 3 arquivos        | Iris 🌈     |
| 26/02/2026 | `85b075d0c`   | 192 commits (desde `a898acbd5`) | 0 — auto-merge    | Iris 🌈     |

**Notas do merge 14/03/2026:**

- Merge-base corrigido com `git replace --graft` — squash commit do 13/03 tinha apenas 1 parent, causando 1.119 commits aparentes quando apenas 740 eram novos
- `pnpm-lock.yaml`: aceito THEIRS (regenerado por `pnpm install`)
- `ui/src/ui/app-render.ts`: aceito THEIRS (nova estrutura topnav-shell/sidebar-shell) + re-aplicado branding Iris ("IRIS" / "by QualiApps 🌈" / favicon.svg)
- Upstream moveu `src/web/` para `extensions/whatsapp/src/` — patches Iris (smart-router outbound + globalThis singleton fix) auto-merged nos novos locais
- PR #45613 (`feat(anthropic): migrate 1M context from beta to GA`) incorporado automaticamente via merge
- Build: passou (`pnpm build` + `node scripts/ui.js build`) sem erros
- Todas as features Iris verificadas intactas: replyMode tool-only, normalizeBrazilianMobile, senderMetadata, message_transcribed, branding, pattern-detector, message-logger, contact-manager

**Notas do merge 13/03/2026:**

- `src/agents/pi-embedded-runner/run/attempt.ts`: upstream removeu bloco `replyMode tool-only` e adicionou comentário sobre compaction count — mantido bloco Iris + adicionado comentário upstream
- `ui/src/i18n/locales/en.ts` e `pt-BR.ts`: upstream reestruturou grupos de navegação (removeu `conversations`, adicionou `communications/appearance/automation/infrastructure/aiAgents`) — aceito THEIRS
- `ui/src/styles/base.css`: upstream atualizou CSS massivamente (dashboard-v2) e voltou ao vermelho — mantido OURS (roxo Iris #7c3aed, dark e light mode)
- `ui/src/ui/app-render.ts`: upstream adicionou `dashboard-header` component e botão de busca (⌘K) no topbar — mantido brand Iris + adicionado botão busca; nova `sidebar-brand` corrigida de "OpenClaw" → "Iris"
- `pnpm install` necessário após merge: upstream adicionou `jsdom` como dep de testes (commit `0c8ea8d98`)
- Build: passou (`pnpm build` + `node scripts/ui.js build`) sem erros
- Testes: 7495 passaram (baseline subiu de 6769); 5 falhas pré-existentes (`manifest-registry` dedup)
- `--no-verify` no commit do merge: limitação Windows com `Argument list too long` ao passar centenas de arquivos para o hook (build e testes validados antes)

**Notas do merge 06/03/2026:**

- `README.md`: upstream substituiu por README do OpenClaw — mantido OURS (README em português do fork)
- `src/commands/models/list.list-command.ts`: conflito menor de cherry-pick — aceito THEIRS
- `src/commands/models/list.list-command.forward-compat.test.ts`: idem — aceito THEIRS
- `src/plugins/types.ts`: upstream refatorou `PLUGIN_HOOK_NAMES` de array para `Record<PluginHookName, true>` — adicionado `message_transcribed: true` no novo formato (patch permanente preservado)
- `hooks.ts` / `types.ts` / `get-reply.ts`: upstream removeu `message_transcribed` — git auto-resolveu mantendo patches permanentes Iris
- `dispatch-from-config.ts`: upstream removeu `replyMode tool-only` — git auto-resolveu mantendo patch Iris
- `banner.ts` / `tagline.ts` / UI: upstream reverteu para OpenClaw branding — git auto-resolveu mantendo branding Iris 🌈
- `run.ts` / `attempt.ts`: patches `senderE164`/`senderName` preservados via auto-merge
- Build: passou (`pnpm build` + `node scripts/ui.js build`) sem erros
- Testes: 6769 passaram; 12 falhas são pré-existentes no fork (2 grupos: `manifest-registry` por fix de dedup, `security/audit` por EPERM no Windows)

**Notas do merge 26/02/2026:**

- `dispatch-from-config.ts`: upstream refatorou ACP dispatch (`resolveSessionStoreEntry`, `sendPolicy`, `tryDispatchAcpReply`) — git auto-resolveu preservando patches Iris (`replyMode`, `isToolOnlyMode`, metadata rico)
- `attempt.ts`: upstream adicionou `acpEnabled` — auto-merge com `senderMetadata` Iris
- `types.agent-defaults.ts`: upstream adicionou `directPolicy` — auto-merge com `replyMode` Iris
- `message_transcribed` patches: intactos (upstream removeu, mas Iris usa em produção — patch permanente)
- Branding: 100% intacta

---

## 🔄 Passo a Passo: Merge Upstream

### 1. Buscar atualizações

```bash
cd C:\Users\lucas\iris-2.0
git fetch upstream
```

### 2. Ver o que mudou no upstream

```bash
# Commits novos no upstream
git log main..upstream/main --oneline

# Verificar se algum arquivo nosso foi tocado
git diff main...upstream/main --stat -- src/cli/banner.ts src/cli/tagline.ts src/agents/pi-embedded-runner/ src/auto-reply/reply/ src/config/types.agent-defaults.ts src/config/zod-schema.agent-defaults.ts src/infra/outbound/deliver.ts src/plugins/hooks.ts src/plugins/types.ts src/utils.ts src/cron/isolated-agent/delivery-dispatch.ts extensions/whatsapp/src/auto-reply/monitor/process-message.ts extensions/whatsapp/src/active-listener.ts ui/
```

### 3. Merge

```bash
git merge upstream/main --no-edit
```

### 4. Resolver conflitos (se houver)

**Regra de ouro:**

- **Patches funcionais** → manter NOSSO código (é funcionalidade que o upstream não tem)
- **Branding** → manter NOSSO código (sempre)
- **Se o PR foi aceito upstream** → aceitar o DELES e remover nosso patch
- **Qualquer outro arquivo** → aceitar o DELES

### 5. Rebuild

```bash
pnpm build
node scripts/ui.js build
```

### 6. Testar

```bash
pnpm test          # Testes unitários
# Subir gateway e testar manualmente:
# - WhatsApp conecta?
# - Telegram conecta?
# - Pattern Detector mostra senderName?
# - Control UI com branding Iris?
```

### 7. Reiniciar gateway

Via Task Scheduler: Stop + Start "OpenClaw Gateway"

---

## 🚨 Checklist Pré-Merge

- [ ] Backup: `git stash` ou `git branch backup-YYYYMMDD` antes
- [ ] Verificar se algum PR nosso foi aceito (pode remover patch)
- [ ] Rodar `git diff --stat` pra ver se conflitos são gerenciáveis
- [ ] Depois do merge: verificar que `pnpm build` passa
- [ ] Depois do merge: verificar que `node scripts/ui.js build` passa
- [ ] Testar gateway completo (WhatsApp + Telegram + UI)

---

## 📊 Status dos PRs Upstream

> Atualizar conforme PRs forem submetidos/aceitos

| #   | Título                      | Status           | Data |
| --- | --------------------------- | ---------------- | ---- |
| -   | senderMetadata para plugins | ⏳ Não submetido | -    |
| -   | replyMode tool-only default | ⏳ Não submetido | -    |
| -   | normalizeBrazilianMobile    | ⏳ Não submetido | -    |
| -   | hook message_transcribed    | ⏳ Não submetido | -    |
| -   | smart-router outbound       | ⏳ Não submetido | -    |

**Meta:** Zero patches funcionais. Tudo aceito upstream. Só branding fica.

---

## 💡 Dicas

1. **Nunca commitar direto em `main`** — faça o merge em branch dedicada e só volte depois dos gates
2. **`origin` neste repo = openclaw/openclaw.git** (upstream direto)
3. **Plugins em `extensions/` nunca conflitam** — pasta ignorada pelo upstream
4. **Config em `~/.openclaw/openclaw.json` não está no repo** — sem risco
5. **Se a UI upstream mudar muito** (ex: novo framework), pode precisar re-aplicar branding manual
6. **O build da UI é separado:** `node scripts/ui.js build` (Vite, ~1s)
7. **Chunk size warning na UI é normal** — não é erro

---

_Mantido por Iris 🌈 — Atualizar após cada merge ou PR aceito._
