---
name: terraform-iac
description: Create, modify, plan, apply, and destroy AWS and Azure infrastructure using Terraform Cloud. Use when asked to provision cloud resources, manage IaC, write Terraform configs, run terraform plan/apply/destroy, manage workspaces, or maintain infrastructure state. Triggers on phrases like "create an S3 bucket", "provision a VNet", "deploy infrastructure", "terraform plan", "apply infra", "destroy resources", "show current state", "what's deployed".
---

# Terraform IaC Agent

Manages AWS and Azure infrastructure via Terraform Cloud (TFC). All state lives in TFC — no local state files.

## Configuration

Required env vars (set once in OpenClaw config):
- `TFC_TOKEN` — Terraform Cloud **user API token** or **team API token** (not an organization token — org tokens lack permissions for plan/apply operations). Generate at: User Settings → Tokens, or Organization → Teams → Team API Token.
- `TFC_ORG` — Terraform Cloud organization name
- `TFC_WORKSPACE_AWS` — workspace name for AWS resources (e.g. `prod-aws`)
- `TFC_WORKSPACE_AZURE` — workspace name for Azure resources (e.g. `prod-azure`)

AWS provider credentials set as TFC workspace variables:
- `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_DEFAULT_REGION`

Azure provider credentials set as TFC workspace variables:
- `ARM_CLIENT_ID`, `ARM_CLIENT_SECRET`, `ARM_SUBSCRIPTION_ID`, `ARM_TENANT_ID`

## Workflow

```
User request → Generate/modify .tf files → Run plan → Show output → Wait for approval → Apply
```

**Always show plan and wait for explicit approval before applying.**

### Step 1: Understand the request

Identify:
- Cloud target: AWS, Azure, or both
- Resource type and configuration
- Whether this is create / modify / destroy

### Step 2: Generate Terraform config

Use `{baseDir}/scripts/tfc_client.py generate` with the appropriate resource type:

```bash
python3 {baseDir}/scripts/tfc_client.py generate \
  --resource s3 --name my-bucket \
  --workspace prod-aws --dir /tmp/tf-aws
```

Supported resources: `s3`, `vpc`, `ec2`, `sg`, `lambda`, `iam-user`, `iam-role`, `budget`, `cloudtrail`, `cloudwatch`, `efs`, `landing-zone`, `rg`

Interactive wizards (vpc, ec2, sg, lambda, iam-user, budget, cloudtrail, cloudwatch, efs, landing-zone) will prompt for configuration with design guidance.

See `{baseDir}/references/aws.md` and `{baseDir}/references/azure.md` for provider patterns.

### Step 3: Run plan

```bash
python3 {baseDir}/scripts/tfc_client.py plan --dir /tmp/tf-aws
```

Show the plan output to the user. Summarize what will be created/changed/destroyed.

### Step 4: Wait for approval

Ask: **"The plan looks like X. Shall I apply? (yes/no)"**

Do NOT apply without explicit confirmation.

### Step 5: Apply or abort

```bash
# Apply
python3 {baseDir}/scripts/tfc_client.py apply --dir /tmp/tf-aws

# Destroy (requires separate confirmation)
python3 {baseDir}/scripts/tfc_client.py destroy --confirm DESTROY --dir /tmp/tf-aws
```

### Step 6: Show outputs

After apply, fetch and display outputs:

```bash
python3 {baseDir}/scripts/tfc_client.py outputs --workspace prod-aws
```

## State Queries

To answer "what's currently deployed":

```bash
python3 {baseDir}/scripts/tfc_client.py state --workspace prod-aws
```

## Workspace Management

```bash
python3 {baseDir}/scripts/tfc_client.py list-workspaces
```

## Rules

- Never apply without showing plan first and getting explicit approval
- Never store credentials in `.tf` files — always use TFC workspace variables
- Destroy requires a second explicit confirmation: "Type DESTROY to confirm"
- Keep AWS and Azure in separate TFC workspaces
- Always pin provider versions in `required_providers`
