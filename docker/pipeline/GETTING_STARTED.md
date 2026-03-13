# Getting Started: OpenClaw Multi-Agent Pipeline

This guide walks you through deploying the multi-agent pipeline system on a VPS with Docker.

## Architecture

Five specialized agents run in sequence, passing work through a shared PostgreSQL database:

```
Market Analyzer -> Trend Finder -> Brainstormer -> Product Architect -> Software Engineer
```

Services:

- **OpenClaw gateway** -- runs the agents and exposes the API
- **PostgreSQL 16** -- persists trends, ideas, product specs, and engineering tasks
- **Backup sidecar** -- daily pg_dump compressed and uploaded to S3

## Prerequisites

- Docker and Docker Compose v2
- Git
- An LLM provider API key (OpenAI, Anthropic, etc.)
- An AWS account with an S3 bucket for backups
- IAM credentials with `s3:PutObject`, `s3:GetObject`, and `s3:DeleteObject` on the bucket

## 1. Clone the repo

```bash
git clone <your-fork-url> ~/openclaw
cd ~/openclaw
```

## 2. Create your environment file

```bash
cp docker/pipeline/.env.example docker/pipeline/.env
```

Edit `docker/pipeline/.env` and fill in every value:

| Variable | Required | Description |
|---|---|---|
| `POSTGRES_PASSWORD` | Yes | Database password. Pick something strong. |
| `POSTGRES_DB` | No | Defaults to `openclaw_pipeline`. |
| `POSTGRES_USER` | No | Defaults to `openclaw`. |
| `AWS_ACCESS_KEY_ID` | Yes | IAM access key for S3 backups. |
| `AWS_SECRET_ACCESS_KEY` | Yes | IAM secret key for S3 backups. |
| `AWS_REGION` | No | Defaults to `us-east-1`. |
| `S3_BACKUP_BUCKET` | Yes | S3 bucket name (must already exist). |
| `BACKUP_CRON` | No | Cron expression for backup schedule. Defaults to `0 3 * * *` (daily 03:00 UTC). |
| `BACKUP_RETAIN_DAYS` | No | Days to keep old backups in S3. Defaults to `30`. |
| `OPENCLAW_GATEWAY_TOKEN` | No | Set to require auth on the gateway API. |
| `OPENCLAW_GATEWAY_PORT` | No | Defaults to `18789`. |
| `OPENCLAW_GATEWAY_BIND` | No | Defaults to `lan`. |

## 3. Create the S3 bucket

If you have not already created your backup bucket:

```bash
aws s3 mb s3://my-openclaw-backups --region us-east-1
```

## 4. Build and start

```bash
cd docker/pipeline
docker compose -f docker-compose.pipeline.yml build
docker compose -f docker-compose.pipeline.yml up -d
```

Verify all services are healthy:

```bash
docker compose -f docker-compose.pipeline.yml ps
docker compose -f docker-compose.pipeline.yml logs openclaw-gateway --tail 50
docker compose -f docker-compose.pipeline.yml logs postgres --tail 20
docker compose -f docker-compose.pipeline.yml logs backup --tail 20
```

Confirm the database schema was created:

```bash
docker compose -f docker-compose.pipeline.yml exec postgres \
  psql -U openclaw -d openclaw_pipeline -c '\dt'
```

You should see: `trends`, `ideas`, `product_specs`, `engineering_tasks`, `agent_runs`.

## 5. Configure your LLM provider

Exec into the gateway container:

```bash
docker compose -f docker-compose.pipeline.yml exec openclaw-gateway bash
```

Run onboarding to set up your model provider:

```bash
openclaw onboard
```

Or if you already have API keys, set them directly:

```bash
openclaw config set models.providers.openai.apiKey "sk-..."
```

## 6. Copy workspace templates

From the host, copy the workspace files into the container volume:

```bash
docker compose -f docker-compose.pipeline.yml cp \
  ../../workspaces/. openclaw-gateway:/home/node/.openclaw/workspaces/
```

Alternatively, switch the compose volume to a bind mount so the files are always in sync:

```yaml
# In docker-compose.pipeline.yml, replace the openclaw-workspaces volume with:
- ./../../workspaces:/home/node/.openclaw/workspaces:ro
```

## 7. Register the agents

Inside the gateway container:

```bash
docker compose -f docker-compose.pipeline.yml exec openclaw-gateway bash
```

Create all five agents:

```bash
openclaw agents add market_analyzer --workspace /home/node/.openclaw/workspaces/market-analyzer
openclaw agents add trend_finder --workspace /home/node/.openclaw/workspaces/trend-finder
openclaw agents add brainstormer --workspace /home/node/.openclaw/workspaces/brainstormer
openclaw agents add product_architect --workspace /home/node/.openclaw/workspaces/product-architect
openclaw agents add software_engineer --workspace /home/node/.openclaw/workspaces/software-engineer
```

Set identities:

```bash
openclaw agents set-identity --agent market_analyzer --name "Market Analyzer"
openclaw agents set-identity --agent trend_finder --name "Trend Finder"
openclaw agents set-identity --agent brainstormer --name "Brainstormer"
openclaw agents set-identity --agent product_architect --name "Product Architect"
openclaw agents set-identity --agent software_engineer --name "Software Engineer"
```

Verify:

```bash
openclaw agents list
```

## 8. Test an agent manually

Before setting up scheduled workflows, confirm agents can run:

```bash
openclaw agent --agent market_analyzer --message "Test run: summarize current market conditions"
```

## 9. Set up scheduled workflows

Add cron jobs for the pipeline. Each runs as an isolated session targeting a specific agent:

```bash
openclaw cron add \
  --name "Market daily summary" \
  --cron "0 8 * * *" \
  --session isolated \
  --agent market_analyzer \
  --message "Produce daily market summary and watchlist changes"

openclaw cron add \
  --name "Trend finder daily report" \
  --cron "0 9 * * *" \
  --session isolated \
  --agent trend_finder \
  --message "Report potential under-the-radar trends with confidence and evidence"

openclaw cron add \
  --name "Brainstormer ideation pass" \
  --cron "0 10 * * 1-5" \
  --session isolated \
  --agent brainstormer \
  --message "Generate candidate app ideas from recent reviewed trends"

openclaw cron add \
  --name "Product idea review" \
  --cron "0 14 * * 1-5" \
  --session isolated \
  --agent product_architect \
  --message "Evaluate brainstormed ideas and produce structured product specs"

openclaw cron add \
  --name "Engineering planning pass" \
  --cron "0 10 * * 1" \
  --session isolated \
  --agent software_engineer \
  --message "Generate implementation plan and risk review for approved product specs"
```

Verify:

```bash
openclaw cron list
```

## 10. Validate backups

The backup sidecar runs an initial backup on startup. Check it worked:

```bash
docker compose -f docker-compose.pipeline.yml logs backup --tail 30
```

Confirm the file landed in S3:

```bash
aws s3 ls s3://my-openclaw-backups/openclaw-pipeline/
```

## Applying tool allowlists (optional but recommended)

To restrict each agent to only its relevant tools, apply the config from the example file.

See `docker/pipeline/openclaw-pipeline.config.example.json5` for the full per-agent tool allowlist configuration. Apply individual settings with:

```bash
openclaw config set agents.list[0].tools.alsoAllow '["save_trend","get_trends","update_trend_status","log_agent_run"]' --json
```

## Pipeline data flow

```
Market Analyzer
  saves trend signals (status: new)
       |
Trend Finder
  reads new trends, scores them, promotes to reviewed or archives
       |
Brainstormer
  reads reviewed trends, generates candidate ideas, marks trends as used
       |
Product Architect
  reads generated ideas, shortlists/rejects, writes product specs
       |
Software Engineer
  reads approved specs, creates engineering task breakdowns
```

All records are linked: `trend -> idea -> product_spec -> engineering_task`.

## Querying the pipeline database

Connect to Postgres directly to inspect pipeline state:

```bash
docker compose -f docker-compose.pipeline.yml exec postgres \
  psql -U openclaw -d openclaw_pipeline
```

Useful queries:

```sql
-- Recent trends
SELECT id, title, status, confidence_score, detected_at FROM trends ORDER BY detected_at DESC LIMIT 10;

-- Ideas linked to their source trends
SELECT i.id, i.title, i.status, t.title AS trend_title
FROM ideas i LEFT JOIN trends t ON i.trend_id = t.id
ORDER BY i.created_at DESC LIMIT 10;

-- Full lineage: trend -> idea -> spec -> tasks
SELECT t.title AS trend, i.title AS idea, ps.title AS spec, et.title AS task, et.status AS task_status
FROM engineering_tasks et
JOIN product_specs ps ON et.product_spec_id = ps.id
JOIN ideas i ON ps.idea_id = i.id
LEFT JOIN trends t ON i.trend_id = t.id
ORDER BY et.sequence_order;
```

## Stopping and restarting

```bash
# Stop everything (data persists in named volumes)
docker compose -f docker-compose.pipeline.yml down

# Start again (Postgres data and agent config survive restarts)
docker compose -f docker-compose.pipeline.yml up -d
```

To destroy everything including data:

```bash
docker compose -f docker-compose.pipeline.yml down -v
```

## Troubleshooting

| Issue | Fix |
|---|---|
| Gateway unhealthy | Check logs: `docker compose logs openclaw-gateway --tail 100` |
| Postgres connection refused | Confirm `DATABASE_URL` matches your `.env` settings |
| Backup fails to upload | Verify AWS credentials and bucket permissions |
| Agent returns empty output | Confirm LLM provider is configured: `openclaw models list` |
| Tools not available to agent | Apply tool allowlists from the config example |
| Schema missing | Check init.sql was mounted: `docker compose logs postgres` |

## Next steps

- Connect messaging channels (Telegram, Discord, etc.) for receiving agent reports
- Replace stub tools with real market data and news API integrations
- Add tool allowlists per agent for strict role separation
- Consider migrating from Docker Postgres to RDS/Aurora for production durability
