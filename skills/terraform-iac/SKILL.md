---
name: terraform-iac
description: Create, modify, plan, apply, and destroy AWS and Azure infrastructure using Terraform Cloud. Use when asked to provision cloud resources, manage IaC, write Terraform configs, run terraform plan/apply/destroy, manage workspaces, or maintain infrastructure state. Triggers on phrases like "create an S3 bucket", "provision a VNet", "deploy infrastructure", "terraform plan", "apply infra", "destroy resources", "show current state", "what's deployed".
---

# Terraform IaC Agent

Manages AWS and Azure infrastructure via Terraform Cloud (TFC). All state lives in TFC — no local state files.

## Configuration

Required env vars (set once in OpenClaw config):
- `TFC_TOKEN` — Terraform Cloud Org API token
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

Write `.tf` files to a local working directory (default: `~/.openclaw/terraform-iac/<workspace>/`).

- One file per logical group: `main.tf`, `variables.tf`, `outputs.tf`
- Use `terraform.required_providers` block with pinned versions
- For multi-cloud: separate directories per cloud, separate TFC workspaces

See `references/aws.md` and `references/azure.md` for provider patterns and common resource examples.

### Step 3: Run plan via TFC API

Use `scripts/tfc_client.py`:

```bash
python3 skills/terraform-iac/scripts/tfc_client.py plan \
  --workspace $TFC_WORKSPACE_AWS \
  --dir ~/.openclaw/terraform-iac/aws
```

Show the plan output to the user. Summarize what will be created/changed/destroyed.

### Step 4: Wait for approval

Ask: **"The plan looks like X. Shall I apply? (yes/no)"**

Do NOT apply without explicit confirmation.

### Step 5: Apply or abort

```bash
# Apply
python3 skills/terraform-iac/scripts/tfc_client.py apply --run-id <run_id>

# Destroy (requires separate confirmation)
python3 skills/terraform-iac/scripts/tfc_client.py destroy \
  --workspace $TFC_WORKSPACE_AWS \
  --dir ~/.openclaw/terraform-iac/aws
```

### Step 6: Show outputs

After apply, fetch and display outputs:

```bash
python3 skills/terraform-iac/scripts/tfc_client.py outputs --workspace $TFC_WORKSPACE_AWS
```

## State Queries

To answer "what's currently deployed":

```bash
python3 skills/terraform-iac/scripts/tfc_client.py state --workspace $TFC_WORKSPACE_AWS
```

## Workspace Management

```bash
# Create a new workspace
python3 skills/terraform-iac/scripts/tfc_client.py create-workspace --name <name> --cloud aws

# List workspaces
python3 skills/terraform-iac/scripts/tfc_client.py list-workspaces
```

## Rules

- Never apply without showing plan first and getting explicit approval
- Never store credentials in `.tf` files — always use TFC workspace variables
- Destroy requires a second explicit confirmation: "Type DESTROY to confirm"
- Keep AWS and Azure in separate TFC workspaces
- Always pin provider versions in `required_providers`
