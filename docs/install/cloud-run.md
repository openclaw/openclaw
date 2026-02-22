---
summary: "Deploy OpenClaw Gateway on Google Cloud Run with managed scaling, Secret Manager, and GCS persistence"
read_when:
  - You want OpenClaw on GCP without managing a VM
  - You want a serverless, container-based deployment on Google Cloud
  - You want managed HTTPS, Secret Manager, and Cloud Logging integration
title: "Cloud Run"
---

# OpenClaw on Google Cloud Run

## Goal

Deploy the OpenClaw Gateway on Cloud Run with:

- Managed HTTPS termination (no certificate management)
- Secret Manager for API keys and tokens
- GCS FUSE for persistent SQLite state
- Cloud Logging with structured JSON output
- Cloud Build for CI/CD

For VM-based deployment with full control, see [GCP Compute Engine](/install/gcp).

**Estimated cost**: ~$50–70/mo for an always-on instance (2 vCPU, 2 GB RAM, min-instances=1).

---

## What you need

- GCP account with billing enabled
- `gcloud` CLI installed ([install guide](https://cloud.google.com/sdk/docs/install))
- At least one model provider API key (OpenAI, Anthropic, Gemini, etc.)
- Optional channel tokens (Telegram, Discord, Slack)

---

## 1) Set up the GCP project

```bash
# Create project (or use an existing one)
gcloud projects create my-openclaw --name="OpenClaw"
gcloud config set project my-openclaw

# Enable required APIs
gcloud services enable \
  run.googleapis.com \
  cloudbuild.googleapis.com \
  artifactregistry.googleapis.com \
  secretmanager.googleapis.com \
  storage.googleapis.com
```

---

## 2) Create Artifact Registry repository

```bash
gcloud artifacts repositories create openclaw \
  --repository-format=docker \
  --location=us-central1 \
  --description="OpenClaw container images"
```

---

## 3) Create a GCS bucket for persistent state

OpenClaw uses SQLite for state, sessions, and vector embeddings. Cloud Run containers are ephemeral, so the database must live on persistent storage. GCS FUSE mounts a Cloud Storage bucket as a local filesystem.

```bash
gcloud storage buckets create gs://my-openclaw-openclaw-data \
  --location=us-central1 \
  --uniform-bucket-level-access
```

> **Note**: SQLite over GCS FUSE uses `journal_mode=DELETE` (not WAL) because FUSE does not support the memory-mapped I/O that WAL requires. This works well for single-instance deployments with moderate write loads. For write-heavy workloads, consider [Compute Engine](/install/gcp) instead.

---

## 4) Store secrets in Secret Manager

Use the provided helper script:

```bash
git clone https://github.com/openclaw/openclaw.git
cd openclaw
./scripts/gcp/setup-secrets.sh my-openclaw
```

Then set the secret values:

```bash
# Gateway token (required)
openssl rand -hex 32 | gcloud secrets versions add openclaw-gateway-token \
  --data-file=- --project=my-openclaw
```

For additional secrets (API keys, channel tokens), uncomment the entries in `scripts/gcp/setup-secrets.sh` and re-run, or create them manually:

```bash
# Example: Anthropic API key
gcloud secrets create anthropic-api-key \
  --project=my-openclaw \
  --replication-policy=automatic

echo -n 'sk-ant-...' | gcloud secrets versions add anthropic-api-key \
  --data-file=- --project=my-openclaw
```

---

## 5) Build and deploy

### Option A: Cloud Build (recommended)

Submit the build using the provided `cloudbuild.yaml`:

```bash
gcloud builds submit --config cloudbuild.yaml \
  --substitutions=_BUCKET_NAME=my-openclaw-openclaw-data
```

This builds the image, pushes it to Artifact Registry, and deploys to Cloud Run in a single pipeline.

To customize the region or service name:

```bash
gcloud builds submit --config cloudbuild.yaml \
  --substitutions=_REGION=europe-west1,_BUCKET_NAME=my-openclaw-openclaw-data,_SERVICE_NAME=my-gateway
```

### Option B: Manual build and deploy

```bash
# Build
docker build -f Dockerfile.cloudrun \
  -t us-central1-docker.pkg.dev/my-openclaw/openclaw/openclaw-gateway:latest .

# Push
docker push us-central1-docker.pkg.dev/my-openclaw/openclaw/openclaw-gateway:latest

# Deploy
gcloud run deploy openclaw-gateway \
  --image=us-central1-docker.pkg.dev/my-openclaw/openclaw/openclaw-gateway:latest \
  --region=us-central1 \
  --platform=managed \
  --port=8080 \
  --cpu=2 \
  --memory=2Gi \
  --min-instances=1 \
  --max-instances=1 \
  --timeout=3600 \
  --execution-environment=gen2 \
  --no-cpu-throttling \
  --session-affinity \
  --add-volume=name=openclaw-data,type=cloud-storage,bucket=my-openclaw-openclaw-data \
  --add-volume-mount=volume=openclaw-data,mount-path=/data \
  --set-env-vars=NODE_ENV=production,OPENCLAW_STATE_DIR=/data,NODE_OPTIONS=--max-old-space-size=1536 \
  --set-secrets=OPENCLAW_GATEWAY_TOKEN=openclaw-gateway-token:latest \
  --startup-probe="httpGet.path=/health,httpGet.port=8080,initialDelaySeconds=10,periodSeconds=10,failureThreshold=18,timeoutSeconds=5" \
  --liveness-probe="httpGet.path=/health,httpGet.port=8080,periodSeconds=30,failureThreshold=3,timeoutSeconds=10"
```

### Adding more secrets

Map additional Secret Manager entries to env vars:

```bash
gcloud run services update openclaw-gateway \
  --region=us-central1 \
  --set-secrets=ANTHROPIC_API_KEY=anthropic-api-key:latest \
  --set-secrets=TELEGRAM_BOT_TOKEN=telegram-bot-token:latest
```

---

## 6) Verify the deployment

```bash
# Get the service URL
gcloud run services describe openclaw-gateway \
  --region=us-central1 \
  --format="value(status.url)"

# Test health endpoint
curl https://openclaw-gateway-HASH-uc.a.run.app/health
# Expected: {"ok":true}

# View logs (structured JSON with severity)
gcloud run services logs read openclaw-gateway --region=us-central1 --limit=50
```

Open the service URL in a browser to access the Control UI. Paste your gateway token when prompted.

---

## Cloud Run configuration details

| Setting                 | Value | Reason                                                                       |
| ----------------------- | ----- | ---------------------------------------------------------------------------- |
| `min-instances`         | 1     | Avoids cold starts that disconnect messaging channels                        |
| `max-instances`         | 1     | SQLite requires single-writer; multiple instances would corrupt the database |
| `cpu`                   | 2     | Matches Fly.io's shared-cpu-2x allocation                                    |
| `memory`                | 2Gi   | Matches Fly.io's 2 GB allocation                                             |
| `timeout`               | 3600  | Maximum request timeout for long-lived WebSocket connections                 |
| `execution-environment` | gen2  | Required for WebSocket support and extended timeouts                         |
| `no-cpu-throttling`     | —     | Keeps CPU always allocated for background WebSocket processing               |
| `session-affinity`      | —     | Routes returning clients to the same instance                                |

---

## WebSocket considerations

Cloud Run gen2 supports WebSocket connections with a maximum request timeout of 3600 seconds (1 hour). When the timeout expires, the connection closes and the gateway's built-in reconnection logic re-establishes messaging channel connections automatically.

If you need longer uninterrupted connections, consider [Compute Engine](/install/gcp) which has no timeout limit.

---

## Persistent storage notes

### What is persisted

| Data             | Location              | Notes                        |
| ---------------- | --------------------- | ---------------------------- |
| Gateway config   | `/data/openclaw.json` | Main configuration           |
| SQLite databases | `/data/*.db`          | Sessions, memory, embeddings |
| Auth profiles    | `/data/`              | OAuth tokens, API key state  |
| Channel state    | `/data/`              | WhatsApp sessions, etc.      |

### GCS FUSE limitations

- **No WAL mode**: SQLite must use `journal_mode=DELETE` (the default for this deployment)
- **Higher latency**: GCS FUSE adds latency vs. local disk; acceptable for moderate workloads
- **Single instance**: Only one Cloud Run instance should access the bucket to avoid corruption

---

## Updating

Re-run Cloud Build to deploy a new version:

```bash
cd openclaw
git pull
gcloud builds submit --config cloudbuild.yaml \
  --substitutions=_BUCKET_NAME=my-openclaw-openclaw-data
```

---

## Troubleshooting

**Container fails to start**

```bash
gcloud run services logs read openclaw-gateway --region=us-central1 --limit=100
```

Common causes:

- Missing `OPENCLAW_GATEWAY_TOKEN` secret — ensure the secret exists and has a version
- GCS bucket permissions — the Cloud Run service account needs `storage.objectAdmin` on the bucket

**Health check failures**

The startup probe allows up to 3 minutes (`initialDelaySeconds=10`, `periodSeconds=10`, `failureThreshold=18`). If the gateway needs more time on first boot, increase `failureThreshold`.

**WebSocket disconnections**

Cloud Run gen2 has a 3600s request timeout. Channels auto-reconnect when the timeout expires. If you see frequent disconnections, check Cloud Run logs for timeout events.

**SQLite errors on GCS FUSE**

Ensure only one instance is running (`max-instances=1`). If you see `SQLITE_BUSY` or locking errors, verify no other processes are accessing the same GCS bucket.

---

## Cost optimization

- **Scale to zero**: Set `min-instances=0` if you don't need persistent messaging channel connections and can tolerate cold starts (~10–30s). This reduces cost to near-zero during idle periods.
- **Smaller machine**: Use `--cpu=1 --memory=512Mi` for lighter workloads.
- **Committed use**: Consider [committed use discounts](https://cloud.google.com/run/pricing#committed-use-discounts) for always-on instances.

---

## Next steps

- Set up messaging channels: [Channels](/channels)
- Pair local devices as nodes: [Nodes](/nodes)
- Configure the Gateway: [Gateway configuration](/gateway/configuration)
