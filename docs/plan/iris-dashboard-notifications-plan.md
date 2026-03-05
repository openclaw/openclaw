# Plano: Notificacoes em Tempo Real do Iris Dashboard -> Iris AI

**Data:** 2026-02-28
**Status:** Proposta
**Autor:** Iris (subagente de pesquisa)

---

## 1. Contexto

O **Iris Dashboard** (`extensions/iris-dashboard/`) e um plugin OpenClaw que gerencia tarefas via Supabase (tabela `tasks`). Quando Lucas interage com o dashboard (cria, edita, conclui, exclui tarefa), a Iris precisa ser notificada automaticamente para:

1. **Atualizar memoria** (daily log, handover, HEARTBEAT.md)
2. **Remover crons/follow-ups** relacionados a tarefa
3. **Confirmar ao Lucas** que processou a mudanca

Atualmente, o plugin so reage a webhooks de conclusao (`routes-webhook.ts`) e gera HEARTBEAT.md no boot. Nao ha notificacao em tempo real.

---

## 2. Comparacao de Abordagens

### 2.1 Supabase Realtime (WebSocket / Postgres Changes)

**Como funciona:** O `@supabase/supabase-js` cria um WebSocket client que se conecta ao Realtime Server do Supabase. Usa `channel.on('postgres_changes', ...)` para receber INSERT/UPDATE/DELETE.

**Pros:**

- Biblioteca oficial, API limpa
- Recebe `record` e `old_record` (dados completos)
- Latencia baixa (~100-500ms)
- Nao precisa de URL publica (client -> server, outbound WebSocket)
- Zero custo adicional (incluido no plano Supabase)

**Contras:**

- INSTABILIDADE em long-running server-side: conexoes caem a cada ~30min sem tratamento
- Precisa de reconnect com exponential backoff (boilerplate consideravel)
- Usa `service_role_key` no server-side
- Adiciona dependencia: `@supabase/supabase-js` (~500KB)
- Supabase Realtime tem limitacoes de escala (max 100 conexoes simultaneas no free tier)

**Veredicto:** Viavel, mas requer tratamento robusto de reconexao.

---

### 2.2 Supabase Database Webhooks (pg_net)

**Como funciona:** Trigger no PostgreSQL que chama `supabase_functions.http_request()` (via extensao `pg_net`) para fazer POST HTTP para um endpoint quando a tabela muda.

**Pros:**

- Zero dependencias no Node.js (e o DB que faz o request)
- Ja existe infraestrutura parcial (`routes-webhook.ts` ja processa webhooks)
- Simples de configurar via SQL ou Dashboard Supabase
- Payload automatico com `type`, `record`, `old_record`

**Contras:**

- REQUER URL PUBLICA acessivel pelo Supabase: o gateway roda em `localhost:18789`, inacessivel externamente
- Solucoes de tunnel (ngrok, Cloudflare Tunnel) adicionam complexidade e ponto de falha
- `pg_net` e assincrono mas com timeout default de 1000ms
- Sem retry automatico embutido
- Debugging mais dificil (logs ficam em `net._http_response` no Supabase)

**Veredicto:** INVIAVEL sem tunnel/URL publica.

---

### 2.3 Supabase Edge Functions

**Como funciona:** Deploy de funcoes Deno no Supabase ativadas por Database Webhooks. A Edge Function receberia o evento e faria request para a Iris.

**Contras:**

- Mesmo problema de URL publica: a Edge Function precisaria chamar o gateway local
- Adiciona camada intermediaria sem valor
- Custo adicional e mais um runtime (Deno)

**Veredicto:** NAO FAZ SENTIDO. Complexidade sem resolver o problema core.

---

### 2.4 PostgreSQL NOTIFY/LISTEN

**Como funciona:** Mecanismo pub/sub nativo do PostgreSQL. Trigger dispara `pg_notify()` e client com `LISTEN` recebe.

**Contras:**

- Requer conexao direta ao PostgreSQL: Supabase hosted nao expoe raw TCP para LISTEN de forma confiavel
- Supabase connection pooler (pgbouncer) nao suporta LISTEN/NOTIFY
- Payload limitado a 8KB

**Veredicto:** Possivel tecnicamente, mas fragil com pooled connections do Supabase.

---

### 2.5 Abordagem Hibrida: Interceptacao na API + Supabase Realtime (fallback)

**Como funciona:** Interceptar as operacoes de CRUD diretamente no plugin (ja que toda interacao do dashboard passa pela API REST do plugin em `routes-api.ts`), e usar Supabase Realtime apenas como fallback para mudancas externas.

**Pros:**

- ZERO LATENCIA: a notificacao e sincrona com a operacao
- ZERO DEPENDENCIAS NOVAS para o caminho principal
- 100% CONFIAVEL: se a API respondeu 200, a notificacao foi enfileirada
- JA TEMOS OS DADOS: `routes-api.ts` ja tem o `record` completo apos cada operacao
- SIMPLES: e adicionar callbacks nos handlers existentes
- Supabase Realtime cobre mudancas feitas fora da API (ex: direto no Supabase Dashboard)

**Contras:**

- Nao captura mudancas feitas diretamente no banco (sem o fallback Realtime)

**Veredicto:** MELHOR ABORDAGEM. Simples, confiavel, sem dependencias.

---

## 3. Recomendacao

### Abordagem Escolhida: Interceptacao na API (Fase 1) + Supabase Realtime fallback (Fase 2)

**Justificativa:**

1. **Toda interacao do dashboard passa pela API REST** (`routes-api.ts` -> POST/PATCH/DELETE). Interceptar ali e o ponto natural.

2. **Ja temos o padrao:** o webhook handler (`routes-webhook.ts`) ja demonstra o pattern de `onTaskCompleted` callback. Expandimos para todos os eventos.

3. **O gateway ja tem `enqueueSystemEvent()`:** mecanismo perfeito para injetar contexto na proxima interacao da Iris. Eventos sao in-memory, session-scoped, e automaticamente drenados no proximo prompt.

4. **O gateway ja tem `send`:** para enviar mensagem ativa ao Lucas via WhatsApp, confirmando a mudanca.

5. **Supabase Realtime e Fase 2:** util como fallback para mudancas fora da API (edicao direta no Supabase Dashboard), mas nao e o caminho critico.

---

## 4. Implementacao Detalhada

### 4.1 Arquitetura

```
Dashboard UI ----> routes-api.ts ----> NotificationService
  (Browser)        (POST/PATCH/DEL)      |
                                         +-- 1. enqueueSystemEvent (sessao Iris)
                                         +-- 2. Regenerar HEARTBEAT.md
                                         +-- 3. WhatsApp msg (confirmacao)
```

### 4.2 Novo arquivo: `src/notification-service.ts`

Servico que centraliza todas as notificacoes de mudancas no dashboard.

```typescript
import type { Task } from "./types.js";
import type { DashboardConfig } from "./config.js";
import type { SupabaseClient } from "./supabase.js";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { generateHeartbeat } from "./heartbeat.js";

export type TaskChangeEvent = {
  type: "created" | "updated" | "completed" | "deleted" | "restored";
  task: Task;
  oldTask?: Task | null;
  changedFields?: string[];
  timestamp: number;
};

export type NotificationServiceDeps = {
  config: DashboardConfig;
  client: SupabaseClient;
  api: OpenClawPluginApi;
  workspaceDir: string;
};

function formatEventForSystemPrompt(event: TaskChangeEvent): string {
  const ts = new Date(event.timestamp).toLocaleString("pt-BR", {
    timeZone: "America/Manaus",
  });

  switch (event.type) {
    case "created":
      return (
        `[Dashboard] Lucas criou tarefa: "${event.task.titulo}" ` +
        `(${event.task.categoria}, P${event.task.prioridade})` +
        (event.task.pessoa ? ` | pessoa: ${event.task.pessoa}` : "") +
        (event.task.vencimento_em
          ? ` | vence: ${new Date(event.task.vencimento_em).toLocaleDateString("pt-BR")}`
          : "") +
        ` | ${ts}`
      );

    case "completed": {
      const who = event.task.concluido_por ?? "Lucas (dashboard)";
      return (
        `[Dashboard] Tarefa concluida por ${who}: "${event.task.titulo}" ` +
        `(${event.task.id}) | ${ts}` +
        `\n-> ACAO: Remover crons/follow-ups relacionados. Atualizar daily log.`
      );
    }

    case "deleted":
      return (
        `[Dashboard] Lucas excluiu tarefa: "${event.task.titulo}" ` +
        `(${event.task.id}) | ${ts}` +
        `\n-> ACAO: Remover crons/follow-ups relacionados.`
      );

    case "updated": {
      const fields = event.changedFields?.join(", ") ?? "campos desconhecidos";
      const statusChange =
        event.oldTask && event.task.status !== event.oldTask.status
          ? ` | status: ${event.oldTask.status} -> ${event.task.status}`
          : "";
      return (
        `[Dashboard] Lucas editou tarefa: "${event.task.titulo}" ` +
        `(alterou: ${fields}${statusChange}) | ${ts}`
      );
    }

    case "restored":
      return `[Dashboard] Lucas restaurou tarefa: "${event.task.titulo}" (${event.task.id}) | ${ts}`;

    default:
      return `[Dashboard] Evento na tarefa "${event.task.titulo}" | ${ts}`;
  }
}

function formatWhatsAppConfirmation(event: TaskChangeEvent): string | null {
  switch (event.type) {
    case "completed":
      return `Registrei: "${event.task.titulo}" concluida. Vou limpar crons e follow-ups relacionados.`;
    case "deleted":
      return `Registrei: "${event.task.titulo}" removida. Crons e follow-ups limpos.`;
    case "created":
      if (event.task.categoria === "urgente" || event.task.prioridade <= 1) {
        return `Nova tarefa urgente no dashboard: "${event.task.titulo}" (P${event.task.prioridade})`;
      }
      return null;
    default:
      return null;
  }
}

export function createNotificationService(deps: NotificationServiceDeps) {
  const { config, client, api, workspaceDir } = deps;
  const sessionKey = config.heartbeatSessionKey ?? "main";

  async function notify(event: TaskChangeEvent): Promise<void> {
    const log = (msg: string) => console.log(`[iris-dashboard:notify] ${msg}`);

    try {
      // 1. Injetar System Event na sessao da Iris
      const systemText = formatEventForSystemPrompt(event);
      api.runtime.system.enqueueSystemEvent(systemText, {
        sessionKey,
        contextKey: `dashboard-task-${event.task.id}`,
      });
      log(`System event enqueued: ${event.type} "${event.task.titulo}"`);

      // 2. Regenerar HEARTBEAT.md
      await generateHeartbeat(client, config, workspaceDir);
      log("HEARTBEAT.md regenerated");

      // 3. Enviar confirmacao via WhatsApp (se aplicavel)
      const whatsappMsg = formatWhatsAppConfirmation(event);
      if (whatsappMsg) {
        try {
          const cfg = api.runtime.config.loadConfig();
          await api.runtime.channel.whatsapp.sendMessageWhatsApp({
            cfg,
            to: "556996021005@s.whatsapp.net", // Lucas - TODO: configuravel
            text: whatsappMsg,
          });
          log(`WhatsApp confirmation sent: ${event.type}`);
        } catch (err) {
          log(`WhatsApp send failed (non-critical): ${err}`);
        }
      }
    } catch (err) {
      console.error("[iris-dashboard:notify] Error:", err);
    }
  }

  return {
    notify,
    onTaskCreated(task: Task) {
      return notify({ type: "created", task, timestamp: Date.now() });
    },
    onTaskUpdated(task: Task, oldTask: Task | null, changedFields: string[]) {
      const isCompletion = task.status === "concluido" && oldTask?.status !== "concluido";
      return notify({
        type: isCompletion ? "completed" : "updated",
        task,
        oldTask,
        changedFields,
        timestamp: Date.now(),
      });
    },
    onTaskDeleted(task: Task) {
      return notify({ type: "deleted", task, timestamp: Date.now() });
    },
    onTaskRestored(task: Task) {
      return notify({ type: "restored", task, timestamp: Date.now() });
    },
  };
}
```

### 4.3 Modificacoes em `routes-api.ts`

Adicionar callbacks de notificacao nos handlers existentes. Todas as notificacoes sao fire-and-forget (`.catch()`) para nunca bloquear a resposta HTTP.

**Mudanca 1:** Adicionar parametro `notifications` na assinatura de `handleApiRoutes`:

```typescript
import type { createNotificationService } from "./notification-service.js";
type NotificationService = ReturnType<typeof createNotificationService>;

export async function handleApiRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  config: DashboardConfig,
  client: SupabaseClient,
  notifications?: NotificationService, // NOVO
): Promise<boolean> {
```

**Mudanca 2:** No handler POST (criar tarefa), apos `jsonResponse`:

```typescript
const task = await serviceCreateTask(client, vr.data);
jsonResponse(res, 201, { ok: true, data: { task } });

// NOVO: Notificar Iris
notifications?.onTaskCreated(task).catch((err) => {
  console.error("[iris-dashboard] Notification error (create):", err);
});
```

**Mudanca 3:** No handler PATCH (editar), buscar estado anterior e notificar:

```typescript
// NOVO: Buscar estado antes da edicao
const oldTask = await serviceFetchTask(client, id);

const task = await serviceUpdateTask(client, id, vr.data);
if (!task) {
  /* 404 existente */
}
jsonResponse(res, 200, { ok: true, data: { task } });

// NOVO: Notificar com campos alterados
const changedFields = Object.keys(vr.data);
notifications?.onTaskUpdated(task, oldTask, changedFields).catch((err) => {
  console.error("[iris-dashboard] Notification error (update):", err);
});
```

**Mudanca 4:** No handler DELETE, buscar task antes e notificar:

```typescript
// NOVO: Buscar antes de deletar
const taskBeforeDelete = await serviceFetchTask(client, id);
const result = await serviceSoftDeleteTask(client, id);
if (!result) {
  /* 404 existente */
}
jsonResponse(res, 200, { ok: true, data: result });

// NOVO: Notificar exclusao
if (taskBeforeDelete) {
  notifications?.onTaskDeleted(taskBeforeDelete).catch((err) => {
    console.error("[iris-dashboard] Notification error (delete):", err);
  });
}
```

**Mudanca 5:** No handler POST restore, notificar:

```typescript
const task = await serviceRestoreTask(client, id);
jsonResponse(res, 200, { ok: true, data: { task } });

// NOVO: Notificar restauracao
if (task) {
  notifications?.onTaskRestored(task).catch((err) => {
    console.error("[iris-dashboard] Notification error (restore):", err);
  });
}
```

### 4.4 Modificacoes em `index.ts`

```typescript
import { createNotificationService } from "./src/notification-service.js";
import { supabaseFetchTask } from "./src/supabase.js";

export default function register(api: OpenClawPluginApi) {
  // ... config validation existente ...
  const client = createSupabaseClient(config);
  const handleUi = createUiHandler(config);
  const workspaceDir = (api.config.workspaceDir as string) ?? process.cwd();

  // NOVO: Criar servico de notificacoes
  const notifications = createNotificationService({ config, client, api, workspaceDir });

  api.registerHttpHandler(async (req, res) => {
    const url = req.url ?? "/";
    if (!url.startsWith("/iris-dashboard")) return false;

    if (handleUi(req, res)) return true;

    // MODIFICADO: Passar notifications para handleApiRoutes
    if (await handleApiRoutes(req, res, config, client, notifications)) return true;

    if (
      await handleWebhookRoute(req, res, config, async (taskId) => {
        log(`Webhook: task ${taskId} completed`);
        const task = await supabaseFetchTask(client, taskId);
        if (task) {
          await notifications.onTaskUpdated(task, null, ["status"]);
        }
      })
    )
      return true;

    return false;
  });

  // ... hooks existentes permanecem inalterados ...
}
```

### 4.5 Como a Iris Recebe (3 Mecanismos em Cascata)

**Mecanismo 1: `enqueueSystemEvent()` (Primario)**

- Queue in-memory por session (`src/infra/system-events.ts`)
- Eventos sao automaticamente drenados e incluidos no proximo prompt
- A Iris ve: `[Dashboard] Tarefa concluida... -> ACAO: Remover crons...`
- Limitacao: se Iris nao processar nenhuma mensagem, evento fica pendente

**Mecanismo 2: HEARTBEAT.md (Persistente)**

- Regenerado a cada mudanca no dashboard
- Injetado no contexto via hook `before_agent_start` no boot
- Sobrevive restarts do gateway

**Mecanismo 3: WhatsApp (Ativo, para eventos criticos)**

- Conclusao e exclusao enviam msg direta ao Lucas
- Iris processa normalmente na sessao WhatsApp
- Mensagem funciona como "trigger" para a sessao

### 4.6 Configuracao

Adicionar ao `openclaw.plugin.json` (configSchema.properties):

```json
"notifySessionKey": {
  "type": "string",
  "description": "Session key da Iris para notificacoes (default: main)"
},
"notifyWhatsAppTarget": {
  "type": "string",
  "description": "Numero WhatsApp para confirmacoes (formato: 55XXXXXXXXXXX@s.whatsapp.net)"
},
"notifyOnComplete": {
  "type": "boolean",
  "description": "Notificar conclusao de tarefas (default: true)"
},
"notifyOnDelete": {
  "type": "boolean",
  "description": "Notificar exclusao de tarefas (default: true)"
}
```

Adicionar ao `config.ts` (tipo `DashboardConfig`):

```typescript
notifySessionKey?: string;
notifyWhatsAppTarget?: string;
notifyOnComplete?: boolean;
notifyOnDelete?: boolean;
```

---

## 5. Fase 2 (Futuro): Supabase Realtime como Fallback

Para capturar mudancas feitas diretamente no Supabase Dashboard (fora da API).

### 5.1 Pre-requisitos

```sql
-- No Supabase SQL Editor:
ALTER PUBLICATION supabase_realtime ADD TABLE tasks;
```

### 5.2 Implementacao do Listener

```typescript
// src/realtime-listener.ts
import { createClient } from "@supabase/supabase-js";
import type { DashboardConfig } from "./config.js";
import type { Task } from "./types.js";

export function createRealtimeListener(
  config: DashboardConfig,
  onEvent: (event: {
    type: "INSERT" | "UPDATE" | "DELETE";
    new: Task | null;
    old: Task | null;
  }) => void,
) {
  const supabase = createClient(config.supabaseUrl, config.supabaseServiceKey);
  let channel: ReturnType<typeof supabase.channel> | null = null;
  let retryCount = 0;
  let retryTimeout: ReturnType<typeof setTimeout> | undefined;

  function subscribe() {
    if (channel) {
      supabase.removeChannel(channel).catch(() => {});
      channel = null;
    }
    channel = supabase
      .channel(`tasks-changes-${Date.now()}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "tasks" }, (payload) => {
        onEvent({
          type: payload.eventType as "INSERT" | "UPDATE" | "DELETE",
          new: (payload.new as Task) ?? null,
          old: (payload.old as Task) ?? null,
        });
      })
      .subscribe((status) => {
        if (status === "SUBSCRIBED") {
          console.log("[iris-dashboard:realtime] Subscribed");
          retryCount = 0;
        } else if (["CHANNEL_ERROR", "TIMED_OUT", "CLOSED"].includes(status)) {
          scheduleRetry();
        }
      });
  }

  function scheduleRetry() {
    if (retryCount >= 10) return;
    retryCount++;
    const delay = Math.min(30_000 * Math.pow(1.5, retryCount - 1), 300_000);
    clearTimeout(retryTimeout);
    retryTimeout = setTimeout(subscribe, delay);
  }

  return {
    start: subscribe,
    stop: () => {
      clearTimeout(retryTimeout);
      if (channel) supabase.removeChannel(channel);
    },
  };
}
```

### 5.3 Deduplicacao

Manter um Set com os ultimos N task IDs processados via API (com TTL de 5s). Se Realtime enviar um evento para um ID ja processado, ignorar.

---

## 6. Fases e Estimativa de Esforco

### Fase 1: Interceptacao na API (MVP) -- ~4-6h

| Tarefa                                         | Estimativa | Prioridade |
| ---------------------------------------------- | ---------- | ---------- |
| Criar `notification-service.ts`                | 1.5h       | P0         |
| Modificar `routes-api.ts` (callbacks)          | 1h         | P0         |
| Modificar `index.ts` (integracao)              | 0.5h       | P0         |
| Atualizar `config.ts` e `openclaw.plugin.json` | 0.5h       | P0         |
| Testes unitarios                               | 1h         | P1         |
| Testar E2E (criar/editar/excluir no dashboard) | 0.5h       | P0         |

### Fase 2: Supabase Realtime Fallback -- ~3-4h

| Tarefa                                     | Estimativa | Prioridade |
| ------------------------------------------ | ---------- | ---------- |
| Criar `realtime-listener.ts`               | 1.5h       | P2         |
| Adicionar `@supabase/supabase-js` como dep | 0.5h       | P2         |
| Registrar como service no plugin           | 0.5h       | P2         |
| Deduplicacao de eventos (API vs Realtime)  | 1h         | P2         |

### Fase 3: Refinamento -- ~2-3h (continuo)

| Tarefa                                     | Estimativa | Prioridade |
| ------------------------------------------ | ---------- | ---------- |
| Debounce de multiplas mudancas rapidas     | 1h         | P3         |
| Logs estruturados e metricas               | 0.5h       | P3         |
| Config granular de quais eventos notificar | 0.5h       | P3         |

---

## 7. Riscos e Mitigacoes

| Risco                             | Impacto | Mitigacao                                         |
| --------------------------------- | ------- | ------------------------------------------------- |
| System events perdidos em restart | Medio   | HEARTBEAT.md persiste. WhatsApp garante delivery. |
| Spam de notificacoes              | Baixo   | Debounce 5s por task. `contextKey` dedup.         |
| Erro no notify bloqueia API       | Alto    | Fire-and-forget com `.catch()`.                   |
| WhatsApp desconectado             | Baixo   | Fallback silencioso. System event continua.       |

---

## 8. Decisoes de Design

1. **Fire-and-forget:** Notificacoes NUNCA bloqueiam response HTTP.
2. **Cascata de entrega:** System Event (rapido, in-memory) -> HEARTBEAT.md (persistente) -> WhatsApp (ativo).
3. **Session key configuravel:** Permite apontar para sessao de teste.
4. **Zero dependencias novas na Fase 1:** Usa apenas APIs ja disponiveis no `OpenClawPluginApi`.
5. **Deduplicacao via contextKey** no `enqueueSystemEvent`.
6. **Parametro opcional:** `notifications?` em `handleApiRoutes` mantem backward compatibility.

---

## 9. Arquivos Tocados (Resumo)

| Arquivo                       | Acao                                          | Fase |
| ----------------------------- | --------------------------------------------- | ---- |
| `src/notification-service.ts` | CRIAR                                         | 1    |
| `src/routes-api.ts`           | MODIFICAR (add param + callbacks)             | 1    |
| `index.ts`                    | MODIFICAR (criar service, passar para routes) | 1    |
| `src/config.ts`               | MODIFICAR (add notify\* fields)               | 1    |
| `openclaw.plugin.json`        | MODIFICAR (add configSchema props)            | 1    |
| `src/realtime-listener.ts`    | CRIAR                                         | 2    |
| `package.json`                | MODIFICAR (add @supabase/supabase-js dep)     | 2    |
