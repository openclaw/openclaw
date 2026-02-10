---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: "Run OpenClaw Gateway 24/7 on a GCP Compute Engine VM (Docker) with durable state"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
read_when:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - You want OpenClaw running 24/7 on GCP（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - You want a production-grade, always-on Gateway on your own VM（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - You want full control over persistence, binaries, and restart behavior（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: "GCP"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# OpenClaw on GCP Compute Engine (Docker, Production VPS Guide)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Goal（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Run a persistent OpenClaw Gateway on a GCP Compute Engine VM using Docker, with durable state, baked-in binaries, and safe restart behavior.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If you want "OpenClaw 24/7 for ~$5-12/mo", this is a reliable setup on Google Cloud.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Pricing varies by machine type and region; pick the smallest VM that fits your workload and scale up if you hit OOMs.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## What are we doing (simple terms)?（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Create a GCP project and enable billing（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Create a Compute Engine VM（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Install Docker (isolated app runtime)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Start the OpenClaw Gateway in Docker（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Persist `~/.openclaw` + `~/.openclaw/workspace` on the host (survives restarts/rebuilds)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Access the Control UI from your laptop via an SSH tunnel（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The Gateway can be accessed via:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- SSH port forwarding from your laptop（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Direct port exposure if you manage firewalling and tokens yourself（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
This guide uses Debian on GCP Compute Engine.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Ubuntu also works; map packages accordingly.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
For the generic Docker flow, see [Docker](/install/docker).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Quick path (experienced operators)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. Create GCP project + enable Compute Engine API（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. Create Compute Engine VM (e2-small, Debian 12, 20GB)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. SSH into the VM（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
4. Install Docker（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
5. Clone OpenClaw repository（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
6. Create persistent host directories（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
7. Configure `.env` and `docker-compose.yml`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
8. Bake required binaries, build, and launch（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## What you need（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- GCP account (free tier eligible for e2-micro)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- gcloud CLI installed (or use Cloud Console)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- SSH access from your laptop（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Basic comfort with SSH + copy/paste（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- ~20-30 minutes（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Docker and Docker Compose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Model auth credentials（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Optional provider credentials（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - WhatsApp QR（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Telegram bot token（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Gmail OAuth（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## 1) Install gcloud CLI (or use Console)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Option A: gcloud CLI** (recommended for automation)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Install from [https://cloud.google.com/sdk/docs/install](https://cloud.google.com/sdk/docs/install)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Initialize and authenticate:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
gcloud init（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
gcloud auth login（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Option B: Cloud Console**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
All steps can be done via the web UI at [https://console.cloud.google.com](https://console.cloud.google.com)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## 2) Create a GCP project（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**CLI:**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
gcloud projects create my-openclaw-project --name="OpenClaw Gateway"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
gcloud config set project my-openclaw-project（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Enable billing at [https://console.cloud.google.com/billing](https://console.cloud.google.com/billing) (required for Compute Engine).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Enable the Compute Engine API:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
gcloud services enable compute.googleapis.com（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Console:**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. Go to IAM & Admin > Create Project（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. Name it and create（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. Enable billing for the project（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
4. Navigate to APIs & Services > Enable APIs > search "Compute Engine API" > Enable（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## 3) Create the VM（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Machine types:**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Type     | Specs                    | Cost               | Notes              |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| -------- | ------------------------ | ------------------ | ------------------ |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| e2-small | 2 vCPU, 2GB RAM          | ~$12/mo            | Recommended        |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| e2-micro | 2 vCPU (shared), 1GB RAM | Free tier eligible | May OOM under load |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**CLI:**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
gcloud compute instances create openclaw-gateway \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  --zone=us-central1-a \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  --machine-type=e2-small \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  --boot-disk-size=20GB \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  --image-family=debian-12 \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  --image-project=debian-cloud（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Console:**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. Go to Compute Engine > VM instances > Create instance（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. Name: `openclaw-gateway`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. Region: `us-central1`, Zone: `us-central1-a`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
4. Machine type: `e2-small`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
5. Boot disk: Debian 12, 20GB（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
6. Create（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## 4) SSH into the VM（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**CLI:**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
gcloud compute ssh openclaw-gateway --zone=us-central1-a（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Console:**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Click the "SSH" button next to your VM in the Compute Engine dashboard.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Note: SSH key propagation can take 1-2 minutes after VM creation. If connection is refused, wait and retry.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## 5) Install Docker (on the VM)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
sudo apt-get update（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
sudo apt-get install -y git curl ca-certificates（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
curl -fsSL https://get.docker.com | sudo sh（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
sudo usermod -aG docker $USER（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Log out and back in for the group change to take effect:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
exit（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Then SSH back in:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
gcloud compute ssh openclaw-gateway --zone=us-central1-a（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Verify:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
docker --version（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
docker compose version（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## 6) Clone the OpenClaw repository（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
git clone https://github.com/openclaw/openclaw.git（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
cd openclaw（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
This guide assumes you will build a custom image to guarantee binary persistence.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## 7) Create persistent host directories（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Docker containers are ephemeral.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
All long-lived state must live on the host.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
mkdir -p ~/.openclaw（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
mkdir -p ~/.openclaw/workspace（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## 8) Configure environment variables（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Create `.env` in the repository root.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
OPENCLAW_IMAGE=openclaw:latest（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
OPENCLAW_GATEWAY_TOKEN=change-me-now（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
OPENCLAW_GATEWAY_BIND=lan（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
OPENCLAW_GATEWAY_PORT=18789（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
OPENCLAW_CONFIG_DIR=/home/$USER/.openclaw（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
OPENCLAW_WORKSPACE_DIR=/home/$USER/.openclaw/workspace（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
GOG_KEYRING_PASSWORD=change-me-now（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
XDG_CONFIG_HOME=/home/node/.openclaw（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Generate strong secrets:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openssl rand -hex 32（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Do not commit this file.**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## 9) Docker Compose configuration（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Create or update `docker-compose.yml`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```yaml（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
services:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  openclaw-gateway:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    image: ${OPENCLAW_IMAGE}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    build: .（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    restart: unless-stopped（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    env_file:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      - .env（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    environment:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      - HOME=/home/node（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      - NODE_ENV=production（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      - TERM=xterm-256color（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      - OPENCLAW_GATEWAY_BIND=${OPENCLAW_GATEWAY_BIND}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      - OPENCLAW_GATEWAY_PORT=${OPENCLAW_GATEWAY_PORT}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      - OPENCLAW_GATEWAY_TOKEN=${OPENCLAW_GATEWAY_TOKEN}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      - GOG_KEYRING_PASSWORD=${GOG_KEYRING_PASSWORD}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      - XDG_CONFIG_HOME=${XDG_CONFIG_HOME}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      - PATH=/home/linuxbrew/.linuxbrew/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    volumes:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      - ${OPENCLAW_CONFIG_DIR}:/home/node/.openclaw（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      - ${OPENCLAW_WORKSPACE_DIR}:/home/node/.openclaw/workspace（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    ports:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      # Recommended: keep the Gateway loopback-only on the VM; access via SSH tunnel.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      # To expose it publicly, remove the `127.0.0.1:` prefix and firewall accordingly.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      - "127.0.0.1:${OPENCLAW_GATEWAY_PORT}:18789"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      # Optional: only if you run iOS/Android nodes against this VM and need Canvas host.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      # If you expose this publicly, read /gateway/security and firewall accordingly.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      # - "18793:18793"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    command:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      [（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "node",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "dist/index.js",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "gateway",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "--bind",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "${OPENCLAW_GATEWAY_BIND}",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "--port",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "${OPENCLAW_GATEWAY_PORT}",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      ]（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## 10) Bake required binaries into the image (critical)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Installing binaries inside a running container is a trap.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Anything installed at runtime will be lost on restart.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
All external binaries required by skills must be installed at image build time.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The examples below show three common binaries only:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `gog` for Gmail access（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `goplaces` for Google Places（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `wacli` for WhatsApp（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
These are examples, not a complete list.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
You may install as many binaries as needed using the same pattern.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If you add new skills later that depend on additional binaries, you must:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. Update the Dockerfile（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. Rebuild the image（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. Restart the containers（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Example Dockerfile**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```dockerfile（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
FROM node:22-bookworm（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
RUN apt-get update && apt-get install -y socat && rm -rf /var/lib/apt/lists/*（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Example binary 1: Gmail CLI（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
RUN curl -L https://github.com/steipete/gog/releases/latest/download/gog_Linux_x86_64.tar.gz \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  | tar -xz -C /usr/local/bin && chmod +x /usr/local/bin/gog（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Example binary 2: Google Places CLI（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
RUN curl -L https://github.com/steipete/goplaces/releases/latest/download/goplaces_Linux_x86_64.tar.gz \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  | tar -xz -C /usr/local/bin && chmod +x /usr/local/bin/goplaces（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Example binary 3: WhatsApp CLI（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
RUN curl -L https://github.com/steipete/wacli/releases/latest/download/wacli_Linux_x86_64.tar.gz \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  | tar -xz -C /usr/local/bin && chmod +x /usr/local/bin/wacli（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Add more binaries below using the same pattern（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
WORKDIR /app（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
COPY ui/package.json ./ui/package.json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
COPY scripts ./scripts（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
RUN corepack enable（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
RUN pnpm install --frozen-lockfile（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
COPY . .（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
RUN pnpm build（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
RUN pnpm ui:install（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
RUN pnpm ui:build（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
ENV NODE_ENV=production（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
CMD ["node","dist/index.js"]（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## 11) Build and launch（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
docker compose build（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
docker compose up -d openclaw-gateway（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Verify binaries:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
docker compose exec openclaw-gateway which gog（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
docker compose exec openclaw-gateway which goplaces（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
docker compose exec openclaw-gateway which wacli（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Expected output:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
/usr/local/bin/gog（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
/usr/local/bin/goplaces（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
/usr/local/bin/wacli（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## 12) Verify Gateway（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
docker compose logs -f openclaw-gateway（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Success:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
[gateway] listening on ws://0.0.0.0:18789（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## 13) Access from your laptop（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Create an SSH tunnel to forward the Gateway port:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
gcloud compute ssh openclaw-gateway --zone=us-central1-a -- -L 18789:127.0.0.1:18789（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Open in your browser:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`http://127.0.0.1:18789/`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Paste your gateway token.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## What persists where (source of truth)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
OpenClaw runs in Docker, but Docker is not the source of truth.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
All long-lived state must survive restarts, rebuilds, and reboots.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Component           | Location                          | Persistence mechanism  | Notes                            |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| ------------------- | --------------------------------- | ---------------------- | -------------------------------- |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Gateway config      | `/home/node/.openclaw/`           | Host volume mount      | Includes `openclaw.json`, tokens |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Model auth profiles | `/home/node/.openclaw/`           | Host volume mount      | OAuth tokens, API keys           |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Skill configs       | `/home/node/.openclaw/skills/`    | Host volume mount      | Skill-level state                |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Agent workspace     | `/home/node/.openclaw/workspace/` | Host volume mount      | Code and agent artifacts         |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| WhatsApp session    | `/home/node/.openclaw/`           | Host volume mount      | Preserves QR login               |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Gmail keyring       | `/home/node/.openclaw/`           | Host volume + password | Requires `GOG_KEYRING_PASSWORD`  |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| External binaries   | `/usr/local/bin/`                 | Docker image           | Must be baked at build time      |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Node runtime        | Container filesystem              | Docker image           | Rebuilt every image build        |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| OS packages         | Container filesystem              | Docker image           | Do not install at runtime        |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Docker container    | Ephemeral                         | Restartable            | Safe to destroy                  |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Updates（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
To update OpenClaw on the VM:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
cd ~/openclaw（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
git pull（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
docker compose build（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
docker compose up -d（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Troubleshooting（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**SSH connection refused**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
SSH key propagation can take 1-2 minutes after VM creation. Wait and retry.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**OS Login issues**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Check your OS Login profile:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
gcloud compute os-login describe-profile（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Ensure your account has the required IAM permissions (Compute OS Login or Compute OS Admin Login).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Out of memory (OOM)**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If using e2-micro and hitting OOM, upgrade to e2-small or e2-medium:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Stop the VM first（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
gcloud compute instances stop openclaw-gateway --zone=us-central1-a（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Change machine type（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
gcloud compute instances set-machine-type openclaw-gateway \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  --zone=us-central1-a \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  --machine-type=e2-small（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Start the VM（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
gcloud compute instances start openclaw-gateway --zone=us-central1-a（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Service accounts (security best practice)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
For personal use, your default user account works fine.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
For automation or CI/CD pipelines, create a dedicated service account with minimal permissions:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. Create a service account:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   ```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   gcloud iam service-accounts create openclaw-deploy \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
     --display-name="OpenClaw Deployment"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   ```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. Grant Compute Instance Admin role (or narrower custom role):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   ```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   gcloud projects add-iam-policy-binding my-openclaw-project \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
     --member="serviceAccount:openclaw-deploy@my-openclaw-project.iam.gserviceaccount.com" \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
     --role="roles/compute.instanceAdmin.v1"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   ```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Avoid using the Owner role for automation. Use the principle of least privilege.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
See [https://cloud.google.com/iam/docs/understanding-roles](https://cloud.google.com/iam/docs/understanding-roles) for IAM role details.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Next steps（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Set up messaging channels: [Channels](/channels)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Pair local devices as nodes: [Nodes](/nodes)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Configure the Gateway: [Gateway configuration](/gateway/configuration)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
