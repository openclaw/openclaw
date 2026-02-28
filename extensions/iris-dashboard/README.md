# Iris Dashboard

Dashboard interativo de tarefas para Iris/Lucas com CRUD completo, filtros, realtime via Supabase e heartbeat de boot.

## Configuração mínima em `openclaw.json`

```json
{
  "plugins": {
    "iris-dashboard": {
      "supabaseUrl": "https://xxx.supabase.co",
      "supabaseServiceKey": "service_role_key_aqui",
      "supabaseAnonKey": "anon_key_aqui",
      "dashboardApiKey": "chave_api_segura",
      "webhookSecret": "segredo_webhook",
      "heartbeatOutputFile": "memory/HEARTBEAT.md"
    }
  }
}
```

## Setup Supabase

1. Aplique `migration.sql` no SQL Editor do Supabase.
2. Confirme `public.tasks` em Database > Replication > Realtime.
3. Crie webhook de `UPDATE` em `public.tasks`:
   - URL: `https://<gateway-host>:18789/iris-dashboard/webhook/tasks`
   - Header: `X-Iris-Webhook-Secret: <webhookSecret>`

## Endpoints

| Método | Caminho                                 | Auth           | Descrição        |
| ------ | --------------------------------------- | -------------- | ---------------- |
| GET    | `/iris-dashboard`                       | —              | Dashboard UI     |
| GET    | `/iris-dashboard/health`                | —              | Healthcheck      |
| GET    | `/iris-dashboard/api/tasks`             | —              | Listar tarefas   |
| GET    | `/iris-dashboard/api/tasks/:id`         | —              | Buscar tarefa    |
| POST   | `/iris-dashboard/api/tasks`             | **Sim**        | Criar tarefa     |
| PATCH  | `/iris-dashboard/api/tasks/:id`         | **Sim**        | Atualizar tarefa |
| DELETE | `/iris-dashboard/api/tasks/:id`         | **Sim**        | Soft delete      |
| POST   | `/iris-dashboard/api/tasks/:id/restore` | **Sim**        | Restaurar        |
| POST   | `/iris-dashboard/webhook/tasks`         | Webhook Secret | Webhook Supabase |

## Autenticação

Para endpoints mutáveis, envie:

- `Authorization: Bearer <dashboardApiKey>`, ou
- `X-Iris-Dashboard-Key: <dashboardApiKey>`

## Filtros disponíveis em GET /api/tasks

- `status` — pendente | em_andamento | concluido | cancelado
- `categoria` — follow_up | backlog | urgente | proximo | outros
- `pessoa` — nome da pessoa
- `search` — busca em título e descrição
- `limit` — máx 200, padrão 50
- `offset` — paginação
- `include_deleted` — incluir itens deletados (soft delete)
- `sort_by` — criado_em | atualizado_em | vencimento_em | prioridade
- `sort_dir` — asc | desc

## HEARTBEAT.md

Gerado em `memory/HEARTBEAT.md` no evento `gateway_start`. Contém tarefas pendentes/em andamento para contexto de boot.

## Troubleshooting

- **Webhook 401**: verifique se `X-Iris-Webhook-Secret` no Supabase bate com `webhookSecret` na config.
- **Realtime não atualiza**: verifique se `public.tasks` está em Supabase Realtime e se `supabaseAnonKey` está configurado.
- **Health falha**: confira `supabaseUrl` e `supabaseServiceKey` na config.
