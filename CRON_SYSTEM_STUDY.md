# Estudo Completo: Sistema de Cron do OpenClaw

> **Objetivo**: Documentação de referência para transportar e adaptar este sistema de
> agendamento em outro projeto (assistente pessoal / produto).
>
> **Data do estudo**: 2026-02-21
> **Fonte**: repositório OpenClaw (`/home/user/openclaw`)

---

## Sumário

1. [Visão Geral da Arquitetura](#1-visão-geral-da-arquitetura)
2. [Dependências Externas (npm)](#2-dependências-externas-npm)
3. [Dependências Internas do OpenClaw (acoplamento)](#3-dependências-internas-do-openclaw-acoplamento)
4. [Mapa de Arquivos — O que levar e o que descartar](#4-mapa-de-arquivos)
5. [Tipos Completos (types.ts)](#5-tipos-completos)
6. [Persistência — Store em JSON](#6-persistência--store-em-json)
7. [Cálculo de Schedule (schedule.ts)](#7-cálculo-de-schedule)
8. [Stagger — Distribuição de carga](#8-stagger--distribuição-de-carga)
9. [Controle de Concorrência (locked.ts)](#9-controle-de-concorrência)
10. [Service State — Máquina de Estado](#10-service-state--máquina-de-estado)
11. [Operações do Serviço (ops.ts)](#11-operações-do-serviço)
12. [Timer Loop — O coração do agendamento](#12-timer-loop--o-coração-do-agendamento)
13. [Job Lifecycle (jobs.ts)](#13-job-lifecycle)
14. [Run Log — Histórico de execuções](#14-run-log--histórico-de-execuções)
15. [Delivery — Entrega de resultados](#15-delivery--entrega-de-resultados)
16. [Dependency Injection — O padrão-chave](#16-dependency-injection--o-padrão-chave)
17. [Configuração (CronConfig)](#17-configuração)
18. [Backoff & Error Handling](#18-backoff--error-handling)
19. [Guia de Portabilidade — Como adaptar](#19-guia-de-portabilidade)
20. [Código-fonte de referência de cada módulo](#20-código-fonte-de-referência)

---

## 1. Visão Geral da Arquitetura

```
┌──────────────────────────────────────────────────────────────────┐
│                        CronService (API)                         │
│  start() | stop() | list() | add() | update() | remove() | run()│
└───────────────────────────┬──────────────────────────────────────┘
                            │
                ┌───────────▼───────────┐
                │      ops.ts           │  ← Operações com locking
                │  (add, update, run...)│
                └───────────┬───────────┘
                            │
          ┌─────────────────┼──────────────────┐
          │                 │                  │
  ┌───────▼──────┐  ┌──────▼───────┐  ┌──────▼───────┐
  │   timer.ts   │  │   jobs.ts    │  │   store.ts   │
  │  armTimer()  │  │  createJob() │  │ ensureLoaded()│
  │  onTimer()   │  │ applyPatch() │  │  persist()   │
  │ executeJob() │  │ recompute()  │  │  migration   │
  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘
         │                 │                  │
         │          ┌──────▼───────┐   ┌──────▼───────┐
         │          │ schedule.ts  │   │  store.ts    │
         │          │ computeNext  │   │  (raiz)      │
         │          │ RunAtMs()    │   │ loadCronStore│
         │          └──────┬───────┘   │ saveCronStore│
         │                 │           └──────────────┘
         │          ┌──────▼───────┐
         │          │   croner     │  ← única dep npm relevante
         │          │  (npm pkg)   │
         │          └──────────────┘
         │
  ┌──────▼─────────────────────────────────┐
  │          CronServiceDeps (DI)          │
  │                                        │
  │  enqueueSystemEvent()  ← VOCÊ PROVÊ   │
  │  requestHeartbeatNow() ← VOCÊ PROVÊ   │
  │  runIsolatedAgentJob() ← VOCÊ PROVÊ   │
  │  onEvent()             ← VOCÊ PROVÊ   │
  │  log                   ← VOCÊ PROVÊ   │
  └────────────────────────────────────────┘
```

**Princípio central**: O scheduler não sabe nada sobre IA, LLM ou agentes.
Ele só dispara callbacks que você injetou via `CronServiceDeps`.

---

## 2. Dependências Externas (npm)

| Pacote | Versão | Uso | Obrigatório? |
|--------|--------|-----|--------------|
| `croner` | `^10.0.1` | Parser de expressões cron + cálculo de próximo disparo com timezone | **Sim** |
| `json5` | qualquer | Parse tolerante do jobs.json (permite comentários) | Opcional — pode trocar por `JSON.parse` |

**Só isso.** O resto é Node.js nativo (`fs`, `path`, `crypto`, `Intl`).

---

## 3. Dependências Internas do OpenClaw (acoplamento)

Estas são as importações que saem da pasta `src/cron/` e vão para o resto do OpenClaw.
**Você NÃO precisa delas** — são substituíveis:

| Import | Arquivo que usa | O que faz | Como substituir |
|--------|----------------|-----------|-----------------|
| `../../config/types.cron.js` | `state.ts` | Tipo `CronConfig` (19 linhas) | Copiar inline — são apenas campos de config |
| `../../infra/heartbeat-wake.js` | `state.ts`, `timer.ts` | Tipo `HeartbeatRunResult` | Definir seu próprio tipo ou usar `any` |
| `../../routing/session-key.js` | `timer.ts`, `normalize.ts` | Constante `DEFAULT_AGENT_ID`, func `normalizeAgentId` | Substituir por string fixa e trim() |
| `../../utils.js` | `normalize.ts` | `truncateUtf16Safe` | Implementar: `str.slice(0, max)` |
| `../../config/sessions.js` | `session-reaper.ts` | `updateSessionStore` | **Não precisa** — reaper é específico do OpenClaw |
| `../../sessions/session-key-utils.js` | `session-reaper.ts` | `isCronRunSessionKey` | **Não precisa** — reaper é específico do OpenClaw |
| `../../cli/parse-duration.js` | `session-reaper.ts` | `parseDurationMs` | **Não precisa** — reaper é específico do OpenClaw |
| `../../channels/plugins/types.js` | `types.ts` | Tipo `ChannelId` | Substituir por `string` |

**Conclusão**: Todas as dependências externas são triviais de substituir (tipos, constantes, funções de 1-3 linhas).

---

## 4. Mapa de Arquivos

### LEVAR (núcleo portável)

```
src/cron/
├── types.ts                    # Tipos completos — CronJob, CronSchedule, etc.
├── parse.ts                    # parseAbsoluteTimeMs() — parse de datas
├── schedule.ts                 # computeNextRunAtMs() — cálculo de próximo run
├── stagger.ts                  # Distribuição de carga em top-of-hour
├── store.ts                    # loadCronStore / saveCronStore — persistência JSON
├── run-log.ts                  # Histórico de execuções em JSONL
├── delivery.ts                 # resolveCronDeliveryPlan()
├── webhook-url.ts              # normalizeHttpWebhookUrl()
├── legacy-delivery.ts          # Migração de formato antigo (pode omitir)
├── payload-migration.ts        # Migração de payload legado (pode omitir)
└── service/
    ├── state.ts                # CronServiceDeps, CronServiceState, factory
    ├── ops.ts                  # Operações: start, stop, list, add, update, remove, run
    ├── timer.ts                # Timer loop, executeJob, backoff, concorrência
    ├── jobs.ts                 # Criação, patch, recompute de jobs
    ├── store.ts                # ensureLoaded, persist, migração de store
    ├── locked.ts               # Concurrency lock (27 linhas)
    └── normalize.ts            # Normalização de nomes, textos, agentIds
```

### DESCARTAR (específico do OpenClaw)

```
src/cron/
├── session-reaper.ts           # Limpeza de sessões do OpenClaw
├── isolated-agent/             # Execução de agente isolado do OpenClaw
│   ├── run.ts
│   ├── helpers.ts
│   ├── session.ts
│   ├── skills-snapshot.ts
│   ├── delivery-target.ts
│   └── subagent-followup.ts

src/gateway/server-cron.ts      # Integração com gateway HTTP/WS do OpenClaw
src/gateway/server-methods/cron.ts  # Handlers de request do OpenClaw
src/agents/tools/cron-tool.ts   # Tool do agente OpenClaw
src/cli/cron-cli/               # CLI do OpenClaw
```

---

## 5. Tipos Completos

Este é o modelo de dados. **Copie inteiro** para seu projeto:

```typescript
// ============================================================
// CronSchedule — 3 formas de agendar
// ============================================================

type CronSchedule =
  // Disparo único em data/hora absoluta
  | { kind: "at"; at: string }  // ISO 8601: "2026-03-01T10:00:00Z"

  // Intervalo fixo em milissegundos
  | { kind: "every"; everyMs: number; anchorMs?: number }

  // Expressão cron clássica com timezone
  | {
      kind: "cron";
      expr: string;        // "0 7 * * *" = todo dia às 7h
      tz?: string;         // "America/Sao_Paulo"
      staggerMs?: number;  // janela de stagger (0 = exato)
    };

// ============================================================
// CronJob — Estrutura completa de um job
// ============================================================

type CronJob = {
  id: string;                           // UUID gerado automaticamente
  name: string;                         // Nome legível
  description?: string;                 // Descrição opcional
  enabled: boolean;                     // Ativo ou pausado
  deleteAfterRun?: boolean;             // Auto-deletar após execução (one-shot)
  createdAtMs: number;                  // Timestamp de criação
  updatedAtMs: number;                  // Timestamp de última atualização
  schedule: CronSchedule;               // Quando disparar
  sessionTarget: "main" | "isolated";   // Tipo de sessão
  wakeMode: "next-heartbeat" | "now";   // Como acordar o agente
  payload: CronPayload;                 // O que enviar ao agente
  delivery?: CronDelivery;              // Como entregar resultado
  state: CronJobState;                  // Estado de execução (mutável)
  agentId?: string;                     // ID do agente (multi-agente)
  sessionKey?: string;                  // Chave de sessão
};

// ============================================================
// CronPayload — O que o job carrega
// ============================================================

type CronPayload =
  // Injeta evento na sessão principal do agente
  | { kind: "systemEvent"; text: string }

  // Executa turno isolado do agente com uma mensagem
  | {
      kind: "agentTurn";
      message: string;
      model?: string;              // Override de modelo
      thinking?: string;           // Override de thinking
      timeoutSeconds?: number;     // Timeout customizado
    };

// ============================================================
// CronDelivery — Como entregar o resultado
// ============================================================

type CronDeliveryMode = "none" | "announce" | "webhook";

type CronDelivery = {
  mode: CronDeliveryMode;
  channel?: string;        // Canal de entrega
  to?: string;             // URL do webhook ou destinatário
  bestEffort?: boolean;    // Não falhar se entrega falhar
};

// ============================================================
// CronJobState — Estado de runtime (mutável pelo scheduler)
// ============================================================

type CronJobState = {
  nextRunAtMs?: number;           // Próximo disparo calculado
  runningAtMs?: number;           // Marcado quando em execução
  lastRunAtMs?: number;           // Último disparo
  lastStatus?: "ok" | "error" | "skipped";
  lastError?: string;
  lastDurationMs?: number;
  consecutiveErrors?: number;     // Contagem para backoff
  scheduleErrorCount?: number;    // Erros de cálculo de schedule
};

// ============================================================
// CronRunStatus & Telemetria
// ============================================================

type CronRunStatus = "ok" | "error" | "skipped";

type CronUsageSummary = {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
};

type CronRunTelemetry = {
  model?: string;
  provider?: string;
  usage?: CronUsageSummary;
};

type CronRunOutcome = {
  status: CronRunStatus;
  error?: string;
  summary?: string;
  sessionId?: string;
  sessionKey?: string;
};

// ============================================================
// Store File — Formato do jobs.json
// ============================================================

type CronStoreFile = {
  version: 1;
  jobs: CronJob[];
};

// ============================================================
// CronJobCreate / CronJobPatch — Input types
// ============================================================

type CronJobCreate = Omit<CronJob, "id" | "createdAtMs" | "updatedAtMs" | "state"> & {
  state?: Partial<CronJobState>;
};

type CronJobPatch = Partial<Omit<CronJob, "id" | "createdAtMs" | "state" | "payload">> & {
  payload?: Partial<CronPayload>;
  delivery?: Partial<CronDelivery>;
  state?: Partial<CronJobState>;
};
```

---

## 6. Persistência — Store em JSON

O sistema persiste tudo em um único arquivo JSON. **Sem banco de dados.**

### Formato do `jobs.json`

```json
{
  "version": 1,
  "jobs": [
    {
      "id": "a1b2c3d4-...",
      "name": "Briefing diário",
      "enabled": true,
      "schedule": { "kind": "cron", "expr": "0 7 * * *", "tz": "America/Sao_Paulo" },
      "sessionTarget": "isolated",
      "wakeMode": "now",
      "payload": { "kind": "agentTurn", "message": "Faça meu briefing do dia" },
      "delivery": { "mode": "announce", "channel": "last" },
      "state": { "nextRunAtMs": 1740124800000 },
      "createdAtMs": 1740000000000,
      "updatedAtMs": 1740000000000
    }
  ]
}
```

### Lógica de save atômico (proteção contra corrupção)

```typescript
// Escreve em arquivo temporário, depois faz rename atômico
async function saveCronStore(storePath: string, store: CronStoreFile) {
  await fs.promises.mkdir(path.dirname(storePath), { recursive: true });
  const tmp = `${storePath}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  const json = JSON.stringify(store, null, 2);
  await fs.promises.writeFile(tmp, json, "utf-8");
  await fs.promises.rename(tmp, storePath);  // <- atômico no mesmo filesystem
  // Backup best-effort
  try {
    await fs.promises.copyFile(storePath, `${storePath}.bak`);
  } catch {}
}
```

### Lógica de load com fallback

```typescript
async function loadCronStore(storePath: string): Promise<CronStoreFile> {
  try {
    const raw = await fs.promises.readFile(storePath, "utf-8");
    const parsed = JSON5.parse(raw);  // tolerante a comentários
    const jobs = Array.isArray(parsed.jobs) ? parsed.jobs.filter(Boolean) : [];
    return { version: 1, jobs };
  } catch (err) {
    if (err.code === "ENOENT") {
      return { version: 1, jobs: [] };  // arquivo não existe = store vazio
    }
    throw err;
  }
}
```

**Caminho padrão**: `~/.openclaw/cron/jobs.json` (configurável).

---

## 7. Cálculo de Schedule

Três tipos de schedule, cada um com sua lógica:

### 7.1 One-shot (`kind: "at"`)

```typescript
// Dispara uma vez no horário absoluto. Retorna undefined se já passou.
if (schedule.kind === "at") {
  const atMs = parseAbsoluteTimeMs(schedule.at);
  return atMs > nowMs ? atMs : undefined;
}
```

### 7.2 Intervalo (`kind: "every"`)

```typescript
// Dispara a cada N milissegundos desde um ponto de ancoragem.
if (schedule.kind === "every") {
  const everyMs = Math.max(1, Math.floor(schedule.everyMs));
  const anchor = Math.max(0, Math.floor(schedule.anchorMs ?? nowMs));
  if (nowMs < anchor) return anchor;
  const elapsed = nowMs - anchor;
  const steps = Math.max(1, Math.floor((elapsed + everyMs - 1) / everyMs));
  return anchor + steps * everyMs;
}
```

### 7.3 Expressão cron (`kind: "cron"`)

```typescript
// Usa a lib croner para calcular o próximo disparo.
import { Cron } from "croner";

const cron = new Cron(schedule.expr, {
  timezone: schedule.tz || Intl.DateTimeFormat().resolvedOptions().timeZone,
});
const next = cron.nextRun(new Date(nowMs));
return next ? next.getTime() : undefined;
```

### Parse de datas absolutas (`parse.ts`)

```typescript
// Aceita: ISO 8601, timestamp numérico, data sem hora
function parseAbsoluteTimeMs(input: string): number | null {
  const raw = input.trim();
  if (/^\d+$/.test(raw)) {                    // "1740124800000"
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
  }
  // Normaliza: "2026-03-01" → "2026-03-01T00:00:00Z"
  // Normaliza: "2026-03-01T10:00:00" → "2026-03-01T10:00:00Z"
  const parsed = Date.parse(normalizeUtcIso(raw));
  return Number.isFinite(parsed) ? parsed : null;
}
```

---

## 8. Stagger — Distribuição de carga

Evita que todos os jobs com `0 * * * *` (top-of-hour) disparem no exato mesmo segundo.

```typescript
const DEFAULT_TOP_OF_HOUR_STAGGER_MS = 5 * 60 * 1000; // 5 minutos

// Detecta se é expressão de "topo da hora"
function isRecurringTopOfHourCronExpr(expr: string) {
  const fields = expr.trim().split(/\s+/);
  // "0 * * * *" → minute=0, hour=*
  return fields[0] === "0" && fields[1].includes("*");
}

// Calcula offset determinístico por job (baseado no hash do ID)
function resolveStableCronOffsetMs(jobId: string, staggerMs: number) {
  const digest = crypto.createHash("sha256").update(jobId).digest();
  return digest.readUInt32BE(0) % staggerMs;
}
```

**Resultado**: Cada job com `0 * * * *` ganha um offset de 0–5 min baseado no seu UUID. Determinístico e estável entre restarts.

---

## 9. Controle de Concorrência

Lock baseado em Promise chain — **zero dependências externas**, 23 linhas:

```typescript
const storeLocks = new Map<string, Promise<void>>();

async function locked<T>(state: CronServiceState, fn: () => Promise<T>): Promise<T> {
  const storePath = state.deps.storePath;
  const storeOp = storeLocks.get(storePath) ?? Promise.resolve();

  // Espera a operação anterior terminar, depois executa a nova
  const next = Promise.all([
    resolveChain(state.op),
    resolveChain(storeOp)
  ]).then(fn);

  const keepAlive = resolveChain(next);
  state.op = keepAlive;
  storeLocks.set(storePath, keepAlive);

  return await next;
}
```

**Como funciona**: Todas as operações que modificam estado passam por `locked()`. Garante serialização sem mutex/semaphore — usa apenas encadeamento de Promises.

---

## 10. Service State — Máquina de Estado

```typescript
type CronServiceState = {
  deps: CronServiceDepsInternal;  // Dependências injetadas
  store: CronStoreFile | null;    // Jobs carregados em memória
  timer: NodeJS.Timeout | null;   // setTimeout ativo
  running: boolean;               // true quando executando job
  op: Promise<unknown>;           // Chain de operações para locking
  warnedDisabled: boolean;        // Já avisou que está desabilitado?
  storeLoadedAtMs: number | null; // Quando carregou do disco
  storeFileMtimeMs: number | null; // mtime do arquivo na última leitura
};

function createCronServiceState(deps: CronServiceDeps): CronServiceState {
  return {
    deps: { ...deps, nowMs: deps.nowMs ?? (() => Date.now()) },
    store: null,
    timer: null,
    running: false,
    op: Promise.resolve(),
    warnedDisabled: false,
    storeLoadedAtMs: null,
    storeFileMtimeMs: null,
  };
}
```

---

## 11. Operações do Serviço

A API pública do `CronService`:

```typescript
class CronService {
  constructor(deps: CronServiceDeps) { ... }

  async start()                                    // Inicia o scheduler
  stop()                                           // Para o timer
  async status()                                   // { enabled, jobs, nextWakeAtMs }
  async list(opts?: { includeDisabled?: boolean })  // Lista jobs
  async add(input: CronJobCreate)                  // Cria job → retorna CronJob
  async update(id: string, patch: CronJobPatch)    // Atualiza job
  async remove(id: string)                         // Remove job
  async run(id: string, mode?: "due" | "force")    // Executa manualmente
  getJob(id: string): CronJob | undefined          // Busca por ID (síncrono)
  wake(opts: { mode, text })                       // Dispara wake event
}
```

### Fluxo de `start()`

```
start()
  └→ locked()
      ├→ ensureLoaded()           — carrega jobs.json do disco
      ├→ limpa runningAtMs stale  — jobs que estavam "running" quando o processo morreu
      ├→ runMissedJobs()          — executa jobs que perderam o horário
      ├→ recomputeNextRuns()      — recalcula todos os nextRunAtMs
      ├→ persist()                — salva no disco
      └→ armTimer()               — agenda o próximo setTimeout
```

### Fluxo de `add()`

```
add(input)
  └→ locked()
      ├→ ensureLoaded()
      ├→ createJob()              — gera UUID, calcula nextRunAtMs
      ├→ store.jobs.push(job)
      ├→ recomputeNextRuns()
      ├→ persist()
      ├→ armTimer()
      └→ emit("added")
```

---

## 12. Timer Loop — O coração do agendamento

### Constantes

```typescript
const MAX_TIMER_DELAY_MS = 60_000;      // Acorda no máximo a cada 60s
const MIN_REFIRE_GAP_MS = 2_000;        // Gap mínimo entre disparos do mesmo job
const DEFAULT_JOB_TIMEOUT_MS = 600_000; // 10 min timeout por job
```

### Ciclo do Timer

```
armTimer()
  ├→ Calcula nextWakeAtMs (menor nextRunAtMs de todos os jobs)
  ├→ delay = min(nextWakeAtMs - now, 60s)   ← nunca dorme mais que 60s
  └→ setTimeout(onTimer, delay)

onTimer()
  ├→ Se running: re-arma timer com 60s e retorna (não bloqueia)
  ├→ running = true
  ├→ locked():
  │   ├→ ensureLoaded(forceReload: true)  ← relê o arquivo do disco
  │   ├→ findDueJobs()                    ← jobs com nextRunAtMs <= now
  │   ├→ marca runningAtMs em cada job
  │   └→ persist()
  ├→ Para cada job due (com concorrência configurável):
  │   ├→ emit("started")
  │   ├→ executeJobCore()   ← chama as deps injetadas
  │   └→ Promise.race com timeout
  ├→ locked():
  │   ├→ applyJobResult()   ← atualiza estado, backoff, etc.
  │   ├→ emitJobFinished()
  │   ├→ Se one-shot OK + deleteAfterRun: remove job
  │   └→ persist()
  └→ finally:
      ├→ running = false
      └→ armTimer()         ← re-agenda para o próximo
```

### Execute Job Core — A decisão de despacho

```typescript
async function executeJobCore(state, job) {
  // JOB NA SESSÃO PRINCIPAL
  if (job.sessionTarget === "main") {
    const text = job.payload.text;
    state.deps.enqueueSystemEvent(text);     // ← injeta evento na sessão
    state.deps.requestHeartbeatNow();        // ← acorda o agente
    return { status: "ok", summary: text };
  }

  // JOB ISOLADO
  if (job.payload.kind === "agentTurn") {
    const result = await state.deps.runIsolatedAgentJob({  // ← sua implementação
      job,
      message: job.payload.message,
    });
    return result;
  }
}
```

### Concorrência de execução

```typescript
// Configurável via cronConfig.maxConcurrentRuns (default: 1)
const concurrency = Math.min(resolveRunConcurrency(state), dueJobs.length);

// Worker pool simples com cursor compartilhado
const workers = Array.from({ length: concurrency }, async () => {
  for (;;) {
    const index = cursor++;
    if (index >= dueJobs.length) return;
    results[index] = await runDueJob(dueJobs[index]);
  }
});
await Promise.all(workers);
```

---

## 13. Job Lifecycle

### Criação de Job

```typescript
function createJob(state, input: CronJobCreate): CronJob {
  const now = state.deps.nowMs();
  const id = crypto.randomUUID();

  // Para "every": garante anchorMs
  // Para "cron": aplica stagger automático se top-of-hour

  const job: CronJob = {
    id,
    name: input.name,
    enabled: true,
    deleteAfterRun: schedule.kind === "at" ? true : undefined,  // one-shot auto-deleta
    createdAtMs: now,
    updatedAtMs: now,
    schedule,
    sessionTarget: input.sessionTarget,
    wakeMode: input.wakeMode,
    payload: input.payload,
    delivery: input.delivery,
    state: {},
  };

  job.state.nextRunAtMs = computeJobNextRunAtMs(job, now);
  return job;
}
```

### Aplicação de resultado (pós-execução)

```typescript
function applyJobResult(state, job, result) {
  job.state.runningAtMs = undefined;
  job.state.lastRunAtMs = result.startedAt;
  job.state.lastStatus = result.status;
  job.state.lastDurationMs = result.endedAt - result.startedAt;

  if (result.status === "error") {
    job.state.consecutiveErrors = (job.state.consecutiveErrors ?? 0) + 1;
  } else {
    job.state.consecutiveErrors = 0;
  }

  // One-shot com sucesso + deleteAfterRun: sinaliza remoção
  if (job.schedule.kind === "at" && job.deleteAfterRun && result.status === "ok") {
    return true; // shouldDelete
  }

  // One-shot: sempre desabilita após qualquer resultado terminal
  if (job.schedule.kind === "at") {
    job.enabled = false;
    job.state.nextRunAtMs = undefined;
    return false;
  }

  // Recorrente com erro: aplica backoff exponencial
  if (result.status === "error" && job.enabled) {
    const backoff = errorBackoffMs(job.state.consecutiveErrors);
    const normalNext = computeJobNextRunAtMs(job, result.endedAt);
    const backoffNext = result.endedAt + backoff;
    job.state.nextRunAtMs = Math.max(normalNext, backoffNext);
    return false;
  }

  // Recorrente com sucesso: próximo disparo normal
  if (job.enabled) {
    job.state.nextRunAtMs = computeJobNextRunAtMs(job, result.endedAt);
  }
  return false;
}
```

### Job stuck detection

```typescript
const STUCK_RUN_MS = 2 * 60 * 60 * 1000; // 2 horas

// Se runningAtMs > 2 horas, limpa o marcador (job travou/processo morreu)
if (typeof runningAt === "number" && nowMs - runningAt > STUCK_RUN_MS) {
  job.state.runningAtMs = undefined;
}
```

### Auto-disable por erros de schedule

```typescript
const MAX_SCHEDULE_ERRORS = 3;

// Se computeNextRunAtMs() falha 3 vezes seguidas:
// job é desabilitado automaticamente para evitar spam de erros
if (errorCount >= MAX_SCHEDULE_ERRORS) {
  job.enabled = false;
}
```

---

## 14. Run Log — Histórico de execuções

Cada job tem um arquivo JSONL separado com o histórico.

**Caminho**: `~/.openclaw/cron/runs/<jobId>.jsonl`

```typescript
type CronRunLogEntry = {
  ts: number;               // Timestamp do registro
  jobId: string;
  action: "finished";
  status?: "ok" | "error" | "skipped";
  error?: string;
  summary?: string;
  runAtMs?: number;
  durationMs?: number;
  nextRunAtMs?: number;
  model?: string;
  provider?: string;
  usage?: CronUsageSummary;
};
```

### Append com auto-prune

```typescript
async function appendCronRunLog(filePath, entry, opts?) {
  // Append atômico
  await fs.appendFile(filePath, JSON.stringify(entry) + "\n");

  // Auto-prune se arquivo > 2MB (mantém últimas 2000 linhas)
  await pruneIfNeeded(filePath, {
    maxBytes: opts?.maxBytes ?? 2_000_000,
    keepLines: opts?.keepLines ?? 2_000,
  });
}
```

### Leitura com limite

```typescript
async function readCronRunLogEntries(filePath, opts?) {
  const limit = Math.min(5000, opts?.limit ?? 200);
  // Lê de trás para frente (mais recentes primeiro)
  // Depois inverte para ordem cronológica
  return parsed.toReversed();
}
```

---

## 15. Delivery — Entrega de resultados

```typescript
type CronDeliveryPlan = {
  mode: "none" | "announce" | "webhook";
  channel?: string;       // canal de destino
  to?: string;            // URL ou destinatário
  source: "delivery" | "payload";
  requested: boolean;     // true se entrega foi solicitada
};
```

### Webhook URL validation

```typescript
function normalizeHttpWebhookUrl(value: unknown): string | null {
  const parsed = new URL(value);
  // Só aceita http: ou https:
  return ["http:", "https:"].includes(parsed.protocol) ? value : null;
}
```

---

## 16. Dependency Injection — O padrão-chave

**Esta é a interface que você precisa implementar para usar o cron no seu projeto:**

```typescript
type CronServiceDeps = {
  // ====== OBRIGATÓRIOS ======

  log: Logger;              // { debug, info, warn, error }
  storePath: string;        // Caminho do jobs.json
  cronEnabled: boolean;     // true para ativar

  // Injeta um evento de texto na sessão principal do agente.
  // É chamado quando um job "main" dispara.
  enqueueSystemEvent: (
    text: string,
    opts?: { agentId?: string; sessionKey?: string; contextKey?: string },
  ) => void;

  // Pede para o agente "acordar" e processar eventos pendentes.
  requestHeartbeatNow: (
    opts?: { reason?: string; agentId?: string; sessionKey?: string },
  ) => void;

  // Executa um turno de agente isolado (jobs "isolated").
  // Recebe o job e a mensagem, retorna o resultado da execução.
  runIsolatedAgentJob: (params: {
    job: CronJob;
    message: string;
  }) => Promise<{
    status: "ok" | "error" | "skipped";
    error?: string;
    summary?: string;
    model?: string;
    usage?: CronUsageSummary;
  }>;

  // ====== OPCIONAIS ======

  nowMs?: () => number;              // Override de Date.now() (para testes)
  cronConfig?: CronConfig;           // Configurações extras
  defaultAgentId?: string;           // ID padrão do agente
  sessionStorePath?: string;         // Para session reaper (pode omitir)

  // Executa heartbeat síncrono e retorna resultado
  runHeartbeatOnce?: (opts?) => Promise<HeartbeatRunResult>;

  // Callback quando algo acontece (para broadcasting via WS/SSE)
  onEvent?: (evt: CronEvent) => void;
};
```

### Exemplo mínimo de implementação

```typescript
import { CronService } from "./cron/service.js";

const cron = new CronService({
  log: console,  // ou pino, winston, etc.
  storePath: "./data/cron/jobs.json",
  cronEnabled: true,

  enqueueSystemEvent: (text, opts) => {
    // Adiciona o texto na fila de mensagens do seu agente
    myAgent.addSystemMessage(text);
  },

  requestHeartbeatNow: (opts) => {
    // Faz seu agente processar as mensagens pendentes
    myAgent.processNow();
  },

  runIsolatedAgentJob: async ({ job, message }) => {
    // Cria uma sessão nova, envia a mensagem, retorna resultado
    const result = await myAgent.runOneShot(message, {
      model: job.payload.kind === "agentTurn" ? job.payload.model : undefined,
    });
    return {
      status: result.success ? "ok" : "error",
      error: result.error,
      summary: result.output?.slice(0, 200),
      model: result.modelUsed,
      usage: result.tokenUsage,
    };
  },

  onEvent: (evt) => {
    // Opcional: broadcast para UI via WebSocket
    ws.broadcast({ type: "cron", ...evt });
  },
});

// Inicia o scheduler
await cron.start();

// Adiciona um job
await cron.add({
  name: "Briefing diário",
  schedule: { kind: "cron", expr: "0 7 * * *", tz: "America/Sao_Paulo" },
  sessionTarget: "isolated",
  wakeMode: "now",
  payload: { kind: "agentTurn", message: "Faça meu briefing do dia" },
});
```

---

## 17. Configuração

```typescript
type CronConfig = {
  enabled?: boolean;                    // Default: true
  store?: string;                       // Default: ~/.openclaw/cron/jobs.json
  maxConcurrentRuns?: number;           // Default: 1
  webhook?: string;                     // Deprecated — use per-job delivery
  webhookToken?: string;                // Bearer token para webhooks
  sessionRetention?: string | false;    // "24h", "7d", false = sem pruning
};
```

### Variáveis de ambiente

| Variável | Efeito |
|----------|--------|
| `OPENCLAW_SKIP_CRON=1` | Desabilita cron completamente |

---

## 18. Backoff & Error Handling

### Tabela de backoff exponencial

```typescript
const ERROR_BACKOFF_SCHEDULE_MS = [
  30_000,        // 1o erro  →  30 segundos
  60_000,        // 2o erro  →   1 minuto
  5 * 60_000,    // 3o erro  →   5 minutos
  15 * 60_000,   // 4o erro  →  15 minutos
  60 * 60_000,   // 5o+ erro →  60 minutos (constante)
];

function errorBackoffMs(consecutiveErrors: number): number {
  const idx = Math.min(consecutiveErrors - 1, ERROR_BACKOFF_SCHEDULE_MS.length - 1);
  return ERROR_BACKOFF_SCHEDULE_MS[Math.max(0, idx)];
}
```

### Como funciona na prática

```
Job falha 1a vez → próximo retry em 30s (ou normal schedule, o que for MAIOR)
Job falha 2a vez → próximo retry em 1min
Job falha 3a vez → próximo retry em 5min
Job falha 4a vez → próximo retry em 15min
Job falha 5a+ vez → próximo retry em 60min (fica nesse patamar)
Job tem sucesso → consecutiveErrors = 0 (reset total)
```

### Proteções adicionais

- **MIN_REFIRE_GAP_MS (2s)**: Previne spin-loop quando croner retorna "agora"
- **STUCK_RUN_MS (2h)**: Limpa marcador de running se job travou
- **MAX_SCHEDULE_ERRORS (3)**: Auto-desabilita job com expressão cron inválida
- **DEFAULT_JOB_TIMEOUT_MS (10min)**: Timeout por execução de job

---

## 19. Guia de Portabilidade

### Passo 1: Copiar o núcleo

```bash
# Crie a estrutura no seu projeto
mkdir -p src/cron/service

# Copie estes arquivos:
# src/cron/types.ts
# src/cron/parse.ts
# src/cron/schedule.ts
# src/cron/stagger.ts
# src/cron/store.ts           (raiz — loadCronStore/saveCronStore)
# src/cron/run-log.ts
# src/cron/delivery.ts
# src/cron/webhook-url.ts
# src/cron/service/state.ts
# src/cron/service/ops.ts
# src/cron/service/timer.ts
# src/cron/service/jobs.ts
# src/cron/service/store.ts   (service — ensureLoaded/persist/migration)
# src/cron/service/locked.ts
# src/cron/service/normalize.ts
# src/cron/service.ts         (a classe principal)
```

### Passo 2: Remover imports do OpenClaw

Substituições necessárias:

```typescript
// ANTES (OpenClaw):
import type { ChannelId } from "../channels/plugins/types.js";
// DEPOIS (seu projeto):
type ChannelId = string;

// ANTES:
import { CONFIG_DIR } from "../utils.js";
// DEPOIS:
const CONFIG_DIR = path.join(os.homedir(), ".meu-app");

// ANTES:
import { expandHomePrefix } from "../infra/home-dir.js";
// DEPOIS:
function expandHomePrefix(p: string) { return p.replace(/^~/, os.homedir()); }

// ANTES:
import { normalizeAgentId, DEFAULT_AGENT_ID } from "../routing/session-key.js";
// DEPOIS:
const DEFAULT_AGENT_ID = "default";
function normalizeAgentId(id: string) { return id.trim().toLowerCase(); }

// ANTES:
import { truncateUtf16Safe } from "../utils.js";
// DEPOIS:
function truncateUtf16Safe(str: string, max: number) { return str.slice(0, max); }

// ANTES:
import type { HeartbeatRunResult } from "../infra/heartbeat-wake.js";
// DEPOIS:
type HeartbeatRunResult =
  | { status: "ran" }
  | { status: "skipped"; reason: string }
  | { status: "error"; reason: string };

// ANTES:
import JSON5 from "json5";
// DEPOIS (se não quiser instalar json5):
const JSON5 = JSON; // perde suporte a comentários no jobs.json
```

### Passo 3: Remover session-reaper

No `timer.ts`, remova ou comente o bloco que chama `sweepCronRunSessions()` (próximo ao final da função `onTimer()`).

### Passo 4: Remover legacy-delivery e payload-migration

No `service/store.ts` (o `ensureLoaded()`), remova os blocos de migração de formato legado que importam de:
- `../legacy-delivery.js`
- `../payload-migration.js`

Estes só existem para manter compatibilidade com versões antigas do OpenClaw.

### Passo 5: Instalar croner

```bash
npm install croner
```

### Passo 6: Implementar as 3 funções de integração

Ver [seção 16](#16-dependency-injection--o-padrão-chave) para o exemplo completo.

### O que você NÃO precisa

- `session-reaper.ts` — limpeza de sessões OpenClaw
- `isolated-agent/` — toda a pasta (execução de agente OpenClaw)
- `legacy-delivery.ts` — migração de formato antigo
- `payload-migration.ts` — migração de payload antigo
- `cli/cron-cli/` — CLI do OpenClaw
- `agents/tools/cron-tool.ts` — tool do agente
- `gateway/server-cron.ts` — integração gateway

---

## 20. Código-fonte de referência

### 20.1 `service.ts` (API principal — 52 linhas)

```typescript
import * as ops from "./service/ops.js";
import { type CronServiceDeps, createCronServiceState } from "./service/state.js";
import type { CronJob, CronJobCreate, CronJobPatch } from "./types.js";

export class CronService {
  private readonly state;
  constructor(deps: CronServiceDeps) {
    this.state = createCronServiceState(deps);
  }

  async start() { await ops.start(this.state); }
  stop() { ops.stop(this.state); }
  async status() { return await ops.status(this.state); }
  async list(opts?: { includeDisabled?: boolean }) { return await ops.list(this.state, opts); }
  async add(input: CronJobCreate) { return await ops.add(this.state, input); }
  async update(id: string, patch: CronJobPatch) { return await ops.update(this.state, id, patch); }
  async remove(id: string) { return await ops.remove(this.state, id); }
  async run(id: string, mode?: "due" | "force") { return await ops.run(this.state, id, mode); }
  getJob(id: string): CronJob | undefined {
    return this.state.store?.jobs.find((job) => job.id === id);
  }
  wake(opts: { mode: "now" | "next-heartbeat"; text: string }) {
    return ops.wakeNow(this.state, opts);
  }
}
```

### 20.2 `locked.ts` (Concorrência — 23 linhas)

```typescript
import type { CronServiceState } from "./state.js";

const storeLocks = new Map<string, Promise<void>>();
const resolveChain = (promise: Promise<unknown>) =>
  promise.then(() => undefined, () => undefined);

export async function locked<T>(state: CronServiceState, fn: () => Promise<T>): Promise<T> {
  const storePath = state.deps.storePath;
  const storeOp = storeLocks.get(storePath) ?? Promise.resolve();
  const next = Promise.all([resolveChain(state.op), resolveChain(storeOp)]).then(fn);
  const keepAlive = resolveChain(next);
  state.op = keepAlive;
  storeLocks.set(storePath, keepAlive);
  return (await next) as T;
}
```

### 20.3 `schedule.ts` (Cálculo de schedule — 73 linhas)

```typescript
import { Cron } from "croner";

function resolveCronTimezone(tz?: string) {
  const trimmed = typeof tz === "string" ? tz.trim() : "";
  return trimmed || Intl.DateTimeFormat().resolvedOptions().timeZone;
}

export function computeNextRunAtMs(schedule, nowMs: number): number | undefined {
  // kind: "at" → disparo único
  if (schedule.kind === "at") {
    const atMs = parseAbsoluteTimeMs(schedule.at);
    return atMs > nowMs ? atMs : undefined;
  }

  // kind: "every" → intervalo fixo
  if (schedule.kind === "every") {
    const everyMs = Math.max(1, Math.floor(schedule.everyMs));
    const anchor = Math.max(0, Math.floor(schedule.anchorMs ?? nowMs));
    if (nowMs < anchor) return anchor;
    const elapsed = nowMs - anchor;
    const steps = Math.max(1, Math.floor((elapsed + everyMs - 1) / everyMs));
    return anchor + steps * everyMs;
  }

  // kind: "cron" → expressão cron
  const cron = new Cron(schedule.expr, {
    timezone: resolveCronTimezone(schedule.tz),
  });
  const next = cron.nextRun(new Date(nowMs));
  if (!next) return undefined;
  const nextMs = next.getTime();
  if (nextMs > nowMs) return nextMs;

  // Guard contra rescheduling no mesmo segundo
  const nextSecondMs = Math.floor(nowMs / 1000) * 1000 + 1000;
  const retry = cron.nextRun(new Date(nextSecondMs));
  return retry ? retry.getTime() : undefined;
}
```

---

## Resumo Final

| Aspecto | Detalhe |
|---------|---------|
| **Portabilidade** | Alta — núcleo usa DI, sem acoplamento a LLM/agente |
| **Dependência npm** | Apenas `croner` (e opcionalmente `json5`) |
| **Storage** | JSON em disco, save atômico, sem banco de dados |
| **Scheduler** | In-process, single-node, setTimeout-based |
| **Concorrência** | Promise-chain locking (sem mutex externo) |
| **Error handling** | Backoff exponencial 30s → 60min, auto-disable |
| **Schedule types** | One-shot (`at`), intervalo (`every`), cron expression |
| **Timezone** | Via `croner` + `Intl.DateTimeFormat` |
| **Limitação** | Single-process — não distribui entre múltiplas instâncias |
| **Ponto de extensão** | `CronServiceDeps` — você implementa 3 funções |

**Para adaptar ao seu projeto, você só precisa:**
1. Copiar ~15 arquivos do núcleo
2. Substituir ~6 imports triviais
3. Implementar 3 funções de integração com seu agente
4. `npm install croner`
