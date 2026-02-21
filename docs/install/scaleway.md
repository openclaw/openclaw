---
summary: "Run OpenClaw Gateway 24/7 on a Scaleway DEV1-S instance (Podman rootless) with OpenTofu infrastructure-as-code"
read_when:
  - You want OpenClaw running 24/7 on a European cloud provider
  - You want a production-grade, always-on Gateway with Podman (rootless)
  - You want infrastructure-as-code with OpenTofu (one command to deploy)
  - You want SSO authentication and automatic budget protection
title: "Scaleway"
---

# OpenClaw on Scaleway (Podman, OpenTofu)

## Goal

Run a persistent OpenClaw Gateway on a Scaleway DEV1-S instance using Podman rootless containers, provisioned entirely via OpenTofu.

If you want "OpenClaw 24/7 for ~17 EUR/month in Europe", this is a fully automated setup with SSO, budget kill switch, and CI/CD.

## What are we doing (simple terms)?

- Rent a small Linux server (Scaleway DEV1-S, 2 vCPU, 2 GB RAM)
- Run OpenClaw in a Podman rootless pod (5 containers: OpenClaw, Caddy, Chrome, CLI sidecar, Token Guard)
- Use Scaleway Generative APIs for LLM inference (llama-3.1-8b, pay-per-use)
- Protect your budget with an automatic kill switch (serverless function, checks billing every hour)
- Access the UI via Pomerium SSO (GitHub OAuth) or webhooks via Caddy reverse proxy
- Everything is provisioned by OpenTofu — one `tofu apply` to deploy

## Quick path (experienced operators)

1. Fork [this deployment repo](https://github.com/Destynova2/fmj)
2. Create Scaleway API key (Organization scope) + GitHub OAuth App
3. `cp terraform/terraform.tfvars.example terraform/terraform.tfvars` — fill in variables
4. `cd terraform/bootstrap && tofu init && tofu apply -var-file=../terraform.tfvars`
5. Push Pomerium image: GitHub Actions > "Push Pomerium Image" > Run workflow
6. `cd terraform && tofu init -backend-config=backend.conf && tofu apply`
7. Visit `https://app.<your-domain>` — log in with GitHub

## What you need

- A [Scaleway account](https://console.scaleway.com/register) with an API key (IAM > API Keys, scope Organization)
- A domain name (register via [Scaleway Domains](https://console.scaleway.com/domains/) or bring your own)
- A [GitHub OAuth App](https://github.com/settings/developers) (callback URL: `https://auth.<your-domain>/oauth2/callback`)
- A [GitHub PAT](https://github.com/settings/tokens) with `repo` scope
- [OpenTofu >= 1.8](https://opentofu.org/docs/intro/install/) installed locally

## 1) Fork the deployment repo

```bash
gh repo fork Destynova2/fmj --clone
cd fmj
```

## 2) Configure variables

```bash
cp terraform/terraform.tfvars.example terraform/terraform.tfvars
```

Edit `terraform/terraform.tfvars` and fill in:

- `scw_access_key` / `scw_secret_key` / `scw_organization_id` — from Scaleway console
- `domain_name` — your domain (e.g. `example.com`)
- `admin_email` — your email (must match your GitHub account for SSO)
- `admin_ip_cidr` — your public IP in CIDR format (e.g. `1.2.3.4/32`)
- `openclaw_version` — check [releases](https://github.com/openclaw/openclaw/releases) (e.g. `2026.2.19`)
- `pomerium_idp_client_id` / `pomerium_idp_client_secret` — from your GitHub OAuth App
- `github_token` / `github_owner` / `github_repository` — for CI/CD automation

Create `terraform/backend.conf`:

```hcl
access_key = "SCWXXXXXXXXXXXXXXXXX"
secret_key = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
```

**Never commit these files** — both are in `.gitignore`.

## 3) Bootstrap

```bash
cd terraform/bootstrap
tofu init
tofu apply -var-file=../terraform.tfvars
```

This creates:
- An S3 bucket for OpenTofu state (encrypted, versioned)
- An encryption passphrase (save it: `tofu output -raw encryption_passphrase`)
- 22 GitHub Actions Secrets (auto-provisioned)

## 4) Push container images

The Pomerium image must be in the registry before deploying:

```bash
# Via GitHub Actions (recommended):
# Go to Actions > "Push Pomerium Image" > Run workflow > v0.32.0
```

Other images (Caddy, OpenClaw, CLI, Token Guard) build automatically on first push to `main`.

## 5) Deploy

```bash
cd terraform
tofu init -backend-config=backend.conf
tofu plan
tofu apply
```

This provisions ~59 resources: instance, VPC, security groups, IAM, DNS records, Pomerium, kill switch, monitoring, and more.

## 6) Verify Gateway

```bash
# Save SSH key
tofu output -raw ssh_private_key > ~/.ssh/openclaw && chmod 600 ~/.ssh/openclaw

# Check the pod
ssh -i ~/.ssh/openclaw root@$(tofu output -raw instance_public_ip) \
  "cd /tmp && sudo -u openclaw XDG_RUNTIME_DIR=/run/user/1000 podman pod ps"

# Check the UI
curl -I https://app.<your-domain>
```

You should see 5 containers running and the Pomerium SSO login page.

## What persists where (source of truth)

| Component | Location | Persistence | Notes |
|-----------|----------|-------------|-------|
| OpenTofu state | Scaleway S3 bucket | Versioned, encrypted (AES-GCM) | Created by bootstrap |
| Instance config | `cloud-init.yaml.tftpl` | Baked at first boot | Security hardening, Podman setup |
| OpenClaw data | `/home/openclaw/` on instance | Disk (20 GB) | Survives reboot, not instance destroy |
| Container images | Scaleway Container Registry | Rebuilt by CI on push | Trivy-scanned for vulnerabilities |
| Secrets | OpenTofu state + GitHub Secrets | Auto-generated | SSH key, gateway token, Pomerium secrets |
| DNS | Scaleway Domains | Managed by OpenTofu | A, CNAME, SPF, DKIM, DMARC |

## Cost

| Resource | EUR/month |
|----------|-----------|
| DEV1-S (2 vCPU, 2 GB) | 6.42 |
| Flexible IPv4 | 2.92 |
| Pomerium (256 MB serverless) | 0.42 |
| Domain (amortized) | ~2 |
| Cockpit logs | ~1 |
| LLM API (llama-3.1-8b) | ~4 |
| **Total** | **~17** |

The kill switch automatically powers off the instance if monthly billing exceeds your configured threshold (default: 15 EUR). You can raise this in `terraform.tfvars`:

```hcl
killswitch_budget_eur = 25  # default 15, minimum 13
```

## Updates

Push changes to `main` and CI handles the rest:

- `terraform/` changes → `tofu plan` + `tofu apply`
- `containers/Containerfile.*` changes → rebuild + trivy scan + push
- Renovate creates PRs for dependency updates (weekly)

## Destroy

```bash
cd terraform && tofu destroy
cd bootstrap && tofu destroy
```
