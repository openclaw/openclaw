# OpenClaw EC2 Infra

This folder provisions an EC2 host for the OpenClaw gateway and wires it to
Secrets Manager + SSM, with a GitHub Actions role for automated deploys.

OpenTofu is a drop-in replacement for Terraform, so all commands below use
`tofu`.

## Environment summary

- Region: `eu-central-1`
- Instance type: `t3.micro` (override via `instance_type`)
- OS: Amazon Linux 2023 (latest)
- Runtime: Node 22 + `openclaw` CLI
- Tooling: Homebrew (Linuxbrew) + `brew install gcc`
- State dir: `/var/lib/openclaw`
- Config file: `/var/lib/openclaw/openclaw.json` (from `infra/openclaw.json`)
- Env vars: rendered to `/etc/openclaw/openclawd.env` from Secrets Manager
- Service: `openclawd` (systemd)
- Gateway port: `18789` (not exposed by default)
- Access: SSM Session Manager only (no SSH ingress by default)
- Data volume: dedicated EBS volume mounted at `/var/lib/openclaw`

## Secrets Manager payload

Store a single JSON secret named `openclaw/prod` (override with `openclaw_secret_name`).
Use a key/value map of env vars (uppercase keys) that will be written to
`/etc/openclaw/openclawd.env`.

Example payload: `infra/openclaw-secret.example.json`

If the secret is missing or empty, the instance still boots with the config in
`infra/openclaw.json` and runs without extra env vars. Update the secret to add
keys/tokens and restart the service.

## Storage persistence

`/var/lib/openclaw` lives on a dedicated EBS volume that persists across
instance replacement. The root EBS volume still resets on replacement.

## Bootstrap remote state (one-time)

```bash
cd infra/bootstrap
tofu init
tofu apply
```

This creates:

- S3 bucket: `openclaw-tfstate-aron98`
- DynamoDB table: `openclaw-tf-lock`

## Apply infra locally

```bash
cd infra
tofu init \
  -backend-config="bucket=openclaw-tfstate-aron98" \
  -backend-config="key=openclaw/prod/terraform.tfstate" \
  -backend-config="region=eu-central-1" \
  -backend-config="dynamodb_table=openclaw-tf-lock"

tofu apply
```

If your account has no default VPC, set `vpc_id` and `subnet_id` before apply.

After apply, set the secret value:

```bash
aws secretsmanager put-secret-value \
  --secret-id openclaw/prod \
  --secret-string file://infra/openclaw-secret.example.json
```

Then restart the service via SSM or SSH:

```bash
aws ssm send-command \
  --document-name "AWS-RunShellScript" \
  --targets "Key=instanceids,Values=<instance-id>" \
  --parameters "commands=sudo systemctl restart openclawd"
```

## GitHub Actions deploy

Terraform creates an OIDC role for GitHub Actions:

- Output: `github_actions_role_arn`

Set it as a repo variable `AWS_ROLE_ARN` (or secret). The workflow uses that to
assume the role, apply Terraform, then restart `openclawd` via SSM.

If your AWS account already has a GitHub OIDC provider, set `oidc_provider_arn`
to that existing ARN to avoid a create conflict.

## Optional SSH access

If you want SSH later:

- Set `ssh_key_name` to an existing EC2 key pair.
- Set `ssh_allowed_cidrs` to your current IP range.

## Port forwarding (SSM)

```bash
aws ssm start-session \
  --target <instance-id> \
  --document-name AWS-StartPortForwardingSession \
  --parameters '{"portNumber":["18789"],"localPortNumber":["18789"]}'
```
