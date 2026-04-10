#!/usr/bin/env python3
"""
Terraform IaC client for the terraform-iac OpenClaw skill.
Uses local Terraform CLI with TFC as remote state backend.

Usage:
  tfc_client.py generate  --resource s3|rg --name NAME --workspace NAME --dir PATH [--region REGION]
  tfc_client.py plan      --dir PATH
  tfc_client.py apply     --dir PATH
  tfc_client.py destroy   --dir PATH
  tfc_client.py state     --workspace NAME
  tfc_client.py outputs   --workspace NAME
  tfc_client.py list-workspaces

Required env vars:
  TFC_TOKEN   Terraform Cloud user or team API token (not org token)
  TFC_ORG     Terraform Cloud organization name
"""

import argparse
import json
import os
import subprocess
import sys
from pathlib import Path

requests = None


def _require_requests():
    global requests
    if requests is None:
        try:
            import requests as _r
            requests = _r
        except ImportError:
            print("ERROR: 'requests' not installed. Run: pip install requests")
            sys.exit(1)
    return requests

TFC_API = "https://app.terraform.io/api/v2"


def sanitize_hcl(value):
    """Escape a user-provided string for safe interpolation into HCL templates."""
    if not isinstance(value, str):
        return str(value)
    return value.replace("\\", "\\\\").replace('"', '\\"').replace("\n", "\\n").replace("\r", "")


def validate_dir(path_str):
    """Validate --dir is a safe path under /tmp or the user's home directory."""
    resolved = Path(path_str).resolve()
    allowed_roots = [Path("/tmp").resolve(), Path.home().resolve()]
    if not any(resolved == root or root in resolved.parents for root in allowed_roots):
        print(f"ERROR: --dir must be under /tmp or $HOME, got '{resolved}'")
        sys.exit(1)
    return str(resolved)


def get_token():
    token = os.environ.get("TFC_TOKEN")
    if not token:
        credfile = Path.home() / ".terraform.d" / "credentials.tfrc.json"
        if credfile.exists():
            mode = credfile.stat().st_mode & 0o777
            if mode & 0o077:
                print(f"WARNING: {credfile} is accessible by other users (mode {oct(mode)}). Run: chmod 600 {credfile}")
            try:
                data = json.loads(credfile.read_text())
                token = data.get("credentials", {}).get("app.terraform.io", {}).get("token")
            except Exception:
                token = None
    if not token:
        print("ERROR: TFC_TOKEN not found in env or ~/.terraform.d/credentials.tfrc.json")
        sys.exit(1)
    return token


def get_org():
    org = os.environ.get("TFC_ORG")
    if not org:
        print("ERROR: TFC_ORG env var is required. Set it to your Terraform Cloud organization name.")
        sys.exit(1)
    return org


def api_headers():
    return {
        "Authorization": f"Bearer {get_token()}",
        "Content-Type": "application/vnd.api+json",
    }


def _resolve_terraform():
    """Resolve terraform binary to an absolute path."""
    import shutil
    tf = shutil.which("terraform")
    if not tf:
        print("ERROR: terraform not found on PATH")
        sys.exit(1)
    return tf


def run_tf(cmd, cwd):
    """Run a terraform command, streaming output."""
    env = os.environ.copy()
    env["TF_TOKEN_app_terraform_io"] = get_token()
    env["TF_CLI_ARGS"] = "-no-color"
    result = subprocess.run(
        [_resolve_terraform()] + cmd,
        cwd=cwd,
        env=env,
        shell=False,
    )
    return result.returncode


def tf_init(cwd):
    print("Running terraform init...")
    rc = run_tf(["init", "-upgrade"], cwd)
    if rc != 0:
        print("ERROR: terraform init failed")
        sys.exit(1)


def prompt(question, default=None, choices=None):
    """Interactive prompt with default and optional choices. All returned strings are HCL-safe."""
    hint = ""
    if choices:
        hint = f" [{'/'.join(choices)}]"
    elif default is not None:
        hint = f" (default: {default})"
    while True:
        val = input(f"  {question}{hint}: ").strip()
        if not val and default is not None:
            return sanitize_hcl(default) if isinstance(default, str) else default
        if choices and val not in choices:
            print(f"    ⚠️  Choose one of: {', '.join(choices)}")
            continue
        if val:
            return sanitize_hcl(val)
        print("    ⚠️  Value required")


def prompt_num(question, default=None, min_val=None, max_val=None):
    """Interactive prompt that validates and returns a numeric string."""
    while True:
        hint = f" (default: {default})" if default is not None else ""
        val = input(f"  {question}{hint}: ").strip()
        if not val and default is not None:
            val = str(default)
        try:
            num = float(val)
            if min_val is not None and num < min_val:
                print(f"    ⚠️  Must be >= {min_val}, got {num}")
                continue
            if max_val is not None and num > max_val:
                print(f"    ⚠️  Must be <= {max_val}, got {num}")
                continue
            return str(int(num)) if num == int(num) else str(num)
        except (ValueError, TypeError):
            print(f"    ⚠️  Must be a number, got '{val}'")


def prompt_iam_user(org, workspace, outdir):
    """Interactively gather IAM user config with least-privilege login."""

    POLICY_PRESETS = {
        "1": {"name": "Console login only (no AWS access)", "policies": [], "desc": "Can only log in and change own password"},
        "2": {"name": "Read-only", "policies": ["arn:aws:iam::aws:policy/ReadOnlyAccess"], "desc": "View all resources, no modifications"},
        "3": {"name": "Billing viewer", "policies": ["arn:aws:iam::aws:policy/AWSBillingReadOnlyAccess"], "desc": "View billing and cost data only"},
        "4": {"name": "S3 read-only", "policies": ["arn:aws:iam::aws:policy/AmazonS3ReadOnlyAccess"], "desc": "Read S3 buckets and objects"},
        "5": {"name": "EC2 read-only", "policies": ["arn:aws:iam::aws:policy/AmazonEC2ReadOnlyAccess"], "desc": "View EC2 instances and networking"},
        "6": {"name": "CloudWatch read-only", "policies": ["arn:aws:iam::aws:policy/CloudWatchReadOnlyAccess"], "desc": "View metrics, logs, alarms"},
        "7": {"name": "Developer (PowerUser)", "policies": ["arn:aws:iam::aws:policy/PowerUserAccess"], "desc": "Full access except IAM and Organizations"},
        "8": {"name": "Custom policy ARN", "policies": [], "desc": "Attach your own managed policy"},
    }

    print("""
👤 AWS IAM User Wizard (Least Privilege)
────────────────────────────────────────────────────────
Creates an IAM user with:
  - Console login (password with forced reset)
  - Self-manage credentials policy (change own password, MFA)
  - Optional access keys for CLI/API
  - Least-privilege: only permissions you explicitly grant

Best practices enforced:
  ✅ Force password reset on first login
  ✅ Self-manage own password and MFA
  ✅ No access keys unless explicitly requested
  ✅ MFA enforcement option
  ❌ No admin access preset (use landing-zone for that)
────────────────────────────────────────────────────────""")

    username = prompt("IAM username (e.g. john.doe)")
    region   = prompt("AWS region", default="us-east-1")
    env      = prompt("Environment", default="prod", choices=["dev", "staging", "prod"])

    # Validate username
    import re
    if not re.match(r'^[\w+=,.@-]+$', username) or len(username) > 64:
        print(f"  ❌ Invalid IAM username. Use letters, numbers, and _+=,.@- (max 64 chars)")
        sys.exit(1)

    # IAM group
    print("\n  IAM Group (recommended for managing permissions):")
    print("    Users should belong to groups, not have direct policies.")
    group_choice = prompt("Add user to an IAM group?", default="yes", choices=["yes", "no"])
    group_name = ""
    create_group = False
    if group_choice == "yes":
        group_action = prompt("Create new group or use existing name?", default="new", choices=["new", "existing"])
        if group_action == "new":
            group_name = prompt("Group name (e.g. developers, viewers, billing)", default="viewers")
            create_group = True
        else:
            group_name = prompt("Existing group name")

    # Permission level
    print("\n  Permission level:")
    for k, v in POLICY_PRESETS.items():
        print(f"    {k}) {v['name']:<35} — {v['desc']}")
    perm_choice = prompt("Permission level", default="1", choices=["1","2","3","4","5","6","7","8"])
    preset = POLICY_PRESETS[perm_choice]
    policies = preset["policies"][:]

    if perm_choice == "8":
        custom_arn = prompt("Managed policy ARN")
        policies = [custom_arn]

    # Additional policies
    if perm_choice != "1":
        add_more = prompt("Attach additional policies?", default="no", choices=["yes", "no"])
        while add_more == "yes":
            extra_arn = prompt("Policy ARN")
            policies.append(extra_arn)
            add_more = prompt("Add another?", default="no", choices=["yes", "no"])

    # MFA enforcement
    print("\n  MFA enforcement:")
    print("    Strongly recommended for console users.")
    print("    When enabled, user must set up MFA before accessing any resources.")
    enforce_mfa = prompt("Enforce MFA?", default="yes", choices=["yes", "no"])
    enforce_mfa = enforce_mfa == "yes"

    # Access keys
    print("\n  Access keys (CLI/API):")
    print("    ⚠️  Only create if the user needs programmatic access.")
    print("    Console-only users should NOT have access keys.")
    create_keys = prompt("Create access keys?", default="no", choices=["yes", "no"])
    create_keys = create_keys == "yes"

    # Password
    print("\n  Console password:")
    print("    Terraform will auto-generate a secure password.")
    print("    Retrieve after apply with: terraform output -raw password")
    print("    User must change password on first login.")
    pw_length = prompt_num("Password length (min 14)", default=20, min_val=14)

    # Summary
    print(f"""
📋 Design Summary:
   Username    : {username}
   Group       : {group_name if group_name else 'none'}{' (new)' if create_group else ''}
   Permissions : {preset['name']}
   Policies    : {len(policies)} attached
   MFA enforce : {'yes' if enforce_mfa else 'no'}
   Access keys : {'yes' if create_keys else 'no'}
   Password    : auto-generated ({pw_length} chars), forced reset on first login
""")
    confirm = prompt("Proceed?", default="yes", choices=["yes", "no"])
    if confirm != "yes":
        print("Aborted.")
        sys.exit(0)

    # Build group block
    group_block = ""
    group_membership_block = ""
    group_policy_blocks = ""
    if group_name:
        if create_group:
            group_block = f"""
resource "aws_iam_group" "this" {{
  name = "{group_name}"
}}
"""
            group_ref = "aws_iam_group.this.name"
        else:
            group_ref = f'"{group_name}"'

        group_membership_block = f"""
resource "aws_iam_group_membership" "this" {{
  name  = "{username}-membership"
  group = {group_ref}
  users = [aws_iam_user.this.name]
}}
"""
        # Attach policies to group instead of user
        for i, pol in enumerate(policies):
            group_policy_blocks += f"""
resource "aws_iam_group_policy_attachment" "policy_{i}" {{
  group      = {group_ref}
  policy_arn = "{pol}"
}}
"""

    # If no group, attach directly to user
    user_policy_blocks = ""
    if not group_name:
        for i, pol in enumerate(policies):
            user_policy_blocks += f"""
resource "aws_iam_user_policy_attachment" "policy_{i}" {{
  user       = aws_iam_user.this.name
  policy_arn = "{pol}"
}}
"""

    # Self-manage credentials policy
    self_manage_block = f"""
resource "aws_iam_user_policy" "self_manage" {{
  name = "{username}-self-manage"
  user = aws_iam_user.this.name
  policy = jsonencode({{
    Version = "2012-10-17"
    Statement = [
      {{
        Sid      = "AllowSelfManagePassword"
        Effect   = "Allow"
        Action   = [
          "iam:ChangePassword",
          "iam:GetUser",
        ]
        Resource = "arn:aws:iam::*:user/${{aws_iam_user.this.name}}"
      }},
      {{
        Sid      = "AllowSelfManageMFA"
        Effect   = "Allow"
        Action   = [
          "iam:CreateVirtualMFADevice",
          "iam:DeleteVirtualMFADevice",
          "iam:EnableMFADevice",
          "iam:ResyncMFADevice",
          "iam:ListMFADevices",
        ]
        Resource = [
          "arn:aws:iam::*:user/${{aws_iam_user.this.name}}",
          "arn:aws:iam::*:mfa/${{aws_iam_user.this.name}}",
        ]
      }},
      {{
        Sid      = "AllowListMFA"
        Effect   = "Allow"
        Action   = ["iam:ListVirtualMFADevices"]
        Resource = "*"
      }},
    ]
  }})
}}
"""

    # MFA enforcement policy
    mfa_block = ""
    if enforce_mfa:
        mfa_block = f"""
resource "aws_iam_user_policy" "enforce_mfa" {{
  name = "{username}-enforce-mfa"
  user = aws_iam_user.this.name
  policy = jsonencode({{
    Version = "2012-10-17"
    Statement = [
      {{
        Sid       = "DenyAllExceptMFASetupWithoutMFA"
        Effect    = "Deny"
        NotAction = [
          "iam:CreateVirtualMFADevice",
          "iam:EnableMFADevice",
          "iam:GetUser",
          "iam:ListMFADevices",
          "iam:ListVirtualMFADevices",
          "iam:ResyncMFADevice",
          "iam:ChangePassword",
          "sts:GetSessionToken",
        ]
        Resource  = "*"
        Condition = {{
          BoolIfExists = {{ "aws:MultiFactorAuthPresent" = "false" }}
        }}
      }}
    ]
  }})
}}
"""

    # Access keys block
    keys_block = ""
    keys_output = ""
    if create_keys:
        keys_block = f"""
resource "aws_iam_access_key" "this" {{
  user = aws_iam_user.this.name
}}
"""
        keys_output = f"""
output "access_key_id"     {{ value = aws_iam_access_key.this.id }}
output "secret_access_key" {{ value = aws_iam_access_key.this.secret, sensitive = true }}
"""

    main_tf = f"""terraform {{
  required_providers {{
    aws = {{ source = "hashicorp/aws", version = "~> 5.0" }}
  }}
  cloud {{
    organization = "{org}"
    workspaces {{ name = "{workspace}" }}
  }}
}}

provider "aws" {{ region = "{region}" }}

locals {{
  tags = {{
    ManagedBy   = "terraform"
    CreatedBy   = "openclaw"
    Environment = "{env}"
  }}
}}

resource "aws_iam_user" "this" {{
  name          = "{username}"
  force_destroy = false
  tags          = merge(local.tags, {{ Name = "{username}" }})
}}

resource "aws_iam_user_login_profile" "this" {{
  user                    = aws_iam_user.this.name
  password_length         = {pw_length}
  password_reset_required = true
}}
{group_block}
{group_membership_block}
{group_policy_blocks}
{user_policy_blocks}
{self_manage_block}
{mfa_block}
{keys_block}
output "username"    {{ value = aws_iam_user.this.name }}
output "password"    {{ value = aws_iam_user_login_profile.this.password, sensitive = true }}
output "console_url" {{ value = "https://${{data.aws_caller_identity.current.account_id}}.signin.aws.amazon.com/console" }}
{keys_output}
data "aws_caller_identity" "current" {{}}
"""
    (outdir / "main.tf").write_text(main_tf)
    print(f"\n✅ Generated {outdir}/main.tf for IAM user '{username}'")
    print(f"   Group       : {group_name if group_name else 'none'}")
    print(f"   Permissions : {preset['name']}")
    print(f"   MFA enforce : {'yes — user must set up MFA before accessing resources' if enforce_mfa else 'no'}")
    print(f"   Access keys : {'yes — retrieve with: terraform output secret_access_key' if create_keys else 'no (console only)'}")
    print(f"   Password    : auto-generated ({pw_length} chars), retrieve with: terraform output -raw password")
    print(f"   Self-manage : change password + manage MFA")


def prompt_lambda(org, workspace, outdir):
    """Interactively gather Lambda config, generate function code, IAM, API GW, and test."""
    import textwrap
    import zipfile

    SUPPORTED_RUNTIMES = {
        "python": {
            "runtime": "python3.12", "handler": "index.handler", "ext": "py", "file": "index.py",
            "layers": {"requests": "arn:aws:lambda:REGION:770693421928:layer:Klayers-p312-requests:19"},
        },
        "node": {
            "runtime": "nodejs20.x", "handler": "index.handler", "ext": "mjs", "file": "index.mjs",
            "layers": {},
        },
        "go": {
            "runtime": "provided.al2023", "handler": "bootstrap", "ext": "go", "file": "main.go",
            "layers": {},
        },
    }

    CODE_TEMPLATES = {
        "python": {
            "rest-api": '''import json\n\ndef handler(event, context):\n    method = event.get("httpMethod", "GET")\n    path = event.get("path", "/")\n    body = event.get("body")\n    if body:\n        try:\n            body = json.loads(body)\n        except Exception:\n            pass\n\n    # --- YOUR LOGIC HERE ---\n    response_body = {{\n        "message": "Hello from {name}",\n        "method": method,\n        "path": path,\n    }}\n\n    return {{\n        "statusCode": 200,\n        "headers": {{"Content-Type": "application/json"}},\n        "body": json.dumps(response_body),\n    }}\n''',
            "data-processor": '''import json\n\ndef handler(event, context):\n    """Process incoming data records."""\n    records = event.get("Records", [event])\n    results = []\n    for record in records:\n        # --- YOUR PROCESSING LOGIC HERE ---\n        processed = {{\n            "status": "processed",\n            "input": record,\n        }}\n        results.append(processed)\n\n    return {{\n        "statusCode": 200,\n        "processed": len(results),\n        "results": results,\n    }}\n''',
            "cron-job": '''import json\nfrom datetime import datetime\n\ndef handler(event, context):\n    """Scheduled task triggered by EventBridge."""\n    now = datetime.utcnow().isoformat()\n    print(f"Cron triggered at {{now}}")\n\n    # --- YOUR SCHEDULED LOGIC HERE ---\n    result = {{\n        "status": "completed",\n        "timestamp": now,\n        "message": "Scheduled task for {name} ran successfully",\n    }}\n\n    print(json.dumps(result))\n    return result\n''',
            "s3-trigger": '''import json\nimport urllib.parse\n\ndef handler(event, context):\n    """Process S3 event notifications."""\n    for record in event.get("Records", []):\n        bucket = record["s3"]["bucket"]["name"]\n        key = urllib.parse.unquote_plus(record["s3"]["object"]["key"])\n        size = record["s3"]["object"].get("size", 0)\n        print(f"New object: s3://{{bucket}}/{{key}} ({{size}} bytes)")\n\n        # --- YOUR S3 PROCESSING LOGIC HERE ---\n\n    return {{"statusCode": 200, "processed": len(event.get("Records", []))}}\n''',
            "custom": '''import json\n\ndef handler(event, context):\n    """Lambda function: {purpose}"""\n\n    # --- IMPLEMENT: {purpose} ---\n\n    return {{\n        "statusCode": 200,\n        "body": json.dumps({{"message": "Success"}}),\n    }}\n''',
        },
        "node": {
            "rest-api": '''export const handler = async (event) => {{\n  const method = event.httpMethod || "GET";\n  const path = event.path || "/";\n  let body = event.body;\n  if (body) try {{ body = JSON.parse(body); }} catch (e) {{}}\n\n  // --- YOUR LOGIC HERE ---\n  const responseBody = {{\n    message: "Hello from {name}",\n    method,\n    path,\n  }};\n\n  return {{\n    statusCode: 200,\n    headers: {{ "Content-Type": "application/json" }},\n    body: JSON.stringify(responseBody),\n  }};\n}};\n''',
            "data-processor": '''export const handler = async (event) => {{\n  const records = event.Records || [event];\n  const results = [];\n  for (const record of records) {{\n    // --- YOUR PROCESSING LOGIC HERE ---\n    results.push({{ status: "processed", input: record }});\n  }}\n  return {{ statusCode: 200, processed: results.length, results }};\n}};\n''',
            "cron-job": '''export const handler = async (event) => {{\n  const now = new Date().toISOString();\n  console.log(`Cron triggered at ${{now}}`);\n\n  // --- YOUR SCHEDULED LOGIC HERE ---\n\n  return {{ status: "completed", timestamp: now, message: "Scheduled task ran" }};\n}};\n''',
            "s3-trigger": '''export const handler = async (event) => {{\n  for (const record of event.Records || []) {{\n    const bucket = record.s3.bucket.name;\n    const key = decodeURIComponent(record.s3.object.key.replace(/\\+/g, " "));\n    console.log(`New object: s3://${{bucket}}/${{key}}`);\n    // --- YOUR S3 PROCESSING LOGIC HERE ---\n  }}\n  return {{ statusCode: 200, processed: (event.Records || []).length }};\n}};\n''',
            "custom": '''export const handler = async (event) => {{\n  // --- IMPLEMENT: {purpose} ---\n  return {{\n    statusCode: 200,\n    body: JSON.stringify({{ message: "Success" }}),\n  }};\n}};\n''',
        },
    }

    print("""
⚡ AWS Lambda Serverless Wizard
────────────────────────────────────────────────────────
Creates a Lambda function with:
  - Function code (generated based on your purpose)
  - IAM execution role with least-privilege
  - Optional API Gateway HTTP endpoint
  - Optional scheduled trigger (EventBridge cron)
  - Optional S3 event trigger
  - Test invocation command

Supported runtimes: Python 3.12, Node.js 20, Go (AL2023)
────────────────────────────────────────────────────────""")

    name   = prompt("Function name (e.g. marsmovers-api)")
    region = prompt("AWS region", default="us-east-1")
    env    = prompt("Environment", default="dev", choices=["dev", "staging", "prod"])

    # Runtime
    print("\n  Runtime:")
    print("    1) Python 3.12  — most popular, great for APIs and data processing")
    print("    2) Node.js 20   — fast cold starts, great for web APIs")
    print("    3) Go (AL2023)  — fastest execution, compiled binary")
    rt_choice = prompt("Runtime", default="1", choices=["1", "2", "3"])
    rt_map = {"1": "python", "2": "node", "3": "go"}
    lang = rt_map[rt_choice]
    rt_info = SUPPORTED_RUNTIMES[lang]

    # Purpose / template
    print("\n  What will this function do?")
    print("    1) REST API         — HTTP endpoint (API Gateway)")
    print("    2) Data processor   — process records/events")
    print("    3) Cron job         — scheduled task (EventBridge)")
    print("    4) S3 trigger       — react to S3 uploads")
    print("    5) Custom           — describe your purpose, code generated")
    purpose_choice = prompt("Function purpose", default="1", choices=["1", "2", "3", "4", "5"])
    purpose_map = {"1": "rest-api", "2": "data-processor", "3": "cron-job", "4": "s3-trigger", "5": "custom"}
    purpose_key = purpose_map[purpose_choice]

    purpose = ""
    if purpose_key == "custom":
        purpose = prompt("Describe what the function should do")

    # Memory & timeout
    print("\n  Resource limits:")
    print("    Memory: 128-3008 MB (128 default, 256 recommended for APIs)")
    print("    Timeout: 3-900 seconds (30s recommended for APIs, 300s for processing)")
    memory = prompt_num("Memory (MB)", default=256, min_val=128, max_val=3008)
    timeout = prompt_num("Timeout (seconds)", default=30, min_val=3, max_val=900)

    # Environment variables
    env_vars = {}
    print("\n  ⚠️  Do NOT put secrets (passwords, API keys) here — use TFC workspace")
    print("    variables or AWS SSM Parameter Store references instead.")
    add_env = prompt("Add environment variables to the function?", default="no", choices=["yes", "no"])
    while add_env == "yes":
        ev_key = prompt("Variable name (e.g. DB_HOST)")
        ev_val = prompt(f"Value for {ev_key}")
        env_vars[ev_key] = ev_val
        add_env = prompt("Add another?", default="no", choices=["yes", "no"])

    # API Gateway
    create_apigw = False
    if purpose_key == "rest-api":
        create_apigw = True
        print("\n  ℹ️  API Gateway HTTP endpoint will be created automatically.")
    else:
        apigw = prompt("\n  Create API Gateway HTTP endpoint?", default="no", choices=["yes", "no"])
        create_apigw = apigw == "yes"

    # Cron schedule
    create_cron = False
    cron_expr = ""
    if purpose_key == "cron-job":
        create_cron = True
        print("\n  Schedule (EventBridge cron expression):")
        print("    Examples:")
        print("      rate(5 minutes)       — every 5 minutes")
        print("      rate(1 hour)          — every hour")
        print("      rate(1 day)           — daily")
        print("      cron(0 9 * * ? *)     — daily at 9:00 UTC")
        print("      cron(0 9 ? * MON *)   — every Monday at 9:00 UTC")
        cron_expr = prompt("Schedule expression", default="rate(1 hour)")
    else:
        cron = prompt("\n  Add a scheduled trigger (EventBridge)?", default="no", choices=["yes", "no"])
        if cron == "yes":
            create_cron = True
            cron_expr = prompt("Schedule expression", default="rate(1 hour)")

    # S3 trigger
    create_s3_trigger = False
    s3_bucket_name = ""
    s3_prefix = ""
    s3_suffix = ""
    if purpose_key == "s3-trigger":
        create_s3_trigger = True
        s3_bucket_name = prompt("\n  S3 bucket name to watch")
        s3_prefix = prompt("Object prefix filter (e.g. uploads/, leave blank for all)", default="")
        s3_suffix = prompt("Object suffix filter (e.g. .csv, leave blank for all)", default="")

    # Summary
    purpose_labels = {"rest-api": "REST API", "data-processor": "Data Processor", "cron-job": "Cron Job", "s3-trigger": "S3 Trigger", "custom": f"Custom: {purpose}"}
    print(f"""
📋 Design Summary:
   Name        : {name}
   Runtime     : {rt_info['runtime']}
   Purpose     : {purpose_labels[purpose_key]}
   Memory      : {memory} MB
   Timeout     : {timeout}s
   Env vars    : {len(env_vars)} {'(' + ', '.join(env_vars.keys()) + ')' if env_vars else ''}
   API Gateway : {'yes' if create_apigw else 'no'}
   Cron        : {cron_expr if create_cron else 'no'}
   S3 trigger  : {s3_bucket_name if create_s3_trigger else 'no'}
   Region      : {region}
""")
    confirm = prompt("Proceed?", default="yes", choices=["yes", "no"])
    if confirm != "yes":
        print("Aborted.")
        sys.exit(0)

    # Generate function code
    code_dir = outdir / "src"
    code_dir.mkdir(parents=True, exist_ok=True)

    if lang == "go":
        code_content = f'''package main\n\nimport (\n\t"context"\n\t"encoding/json"\n\t"github.com/aws/aws-lambda-go/lambda"\n)\n\ntype Event struct {{\n\tBody string `json:"body"`\n}}\n\ntype Response struct {{\n\tStatusCode int    `json:"statusCode"`\n\tBody       string `json:"body"`\n}}\n\nfunc handler(ctx context.Context, event Event) (Response, error) {{\n\t// --- IMPLEMENT: {purpose or purpose_key} ---\n\tbody, _ := json.Marshal(map[string]string{{"message": "Hello from {name}"}})\n\treturn Response{{StatusCode: 200, Body: string(body)}}, nil\n}}\n\nfunc main() {{\n\tlambda.Start(handler)\n}}\n'''
    else:
        template = CODE_TEMPLATES.get(lang, {}).get(purpose_key, CODE_TEMPLATES[lang]["custom"])
        code_content = template.format(name=name, purpose=purpose or purpose_key)

    code_file = code_dir / rt_info["file"]
    code_file.write_text(code_content)
    print(f"  ✅ Generated function code: {code_file}")

    # Create zip
    zip_path = outdir / "function.zip"
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.write(code_file, rt_info["file"])
    print(f"  ✅ Created deployment package: {zip_path}")

    # Build env vars block
    env_block = ""
    if env_vars:
        vars_hcl = "\n".join([f'      {k} = "{v}"' for k, v in env_vars.items()])
        env_block = f"""
  environment {{
    variables = {{
{vars_hcl}
    }}
  }}
"""

    # API Gateway block
    apigw_block = ""
    apigw_output = ""
    if create_apigw:
        apigw_block = f"""
resource "aws_apigatewayv2_api" "this" {{
  name          = "{name}-api"
  protocol_type = "HTTP"
  tags          = local.tags
}}

resource "aws_apigatewayv2_stage" "default" {{
  api_id      = aws_apigatewayv2_api.this.id
  name        = "$default"
  auto_deploy = true
}}

resource "aws_apigatewayv2_integration" "this" {{
  api_id                 = aws_apigatewayv2_api.this.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.this.invoke_arn
  payload_format_version = "2.0"
}}

resource "aws_apigatewayv2_route" "default" {{
  api_id    = aws_apigatewayv2_api.this.id
  route_key = "$default"
  target    = "integrations/${{aws_apigatewayv2_integration.this.id}}"
}}

resource "aws_lambda_permission" "apigw" {{
  statement_id  = "AllowAPIGateway"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.this.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${{aws_apigatewayv2_api.this.execution_arn}}/*/*"
}}
"""
        apigw_output = f"""
output "api_endpoint" {{ value = aws_apigatewayv2_stage.default.invoke_url }}
"""

    # Cron block
    cron_block = ""
    if create_cron:
        cron_block = f"""
resource "aws_cloudwatch_event_rule" "cron" {{
  name                = "{name}-schedule"
  schedule_expression = "{cron_expr}"
  tags                = local.tags
}}

resource "aws_cloudwatch_event_target" "cron" {{
  rule = aws_cloudwatch_event_rule.cron.name
  arn  = aws_lambda_function.this.arn
}}

resource "aws_lambda_permission" "cron" {{
  statement_id  = "AllowEventBridge"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.this.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.cron.arn
}}
"""

    # S3 trigger block
    s3_trigger_block = ""
    if create_s3_trigger:
        filter_prefix = ""
        filter_suffix = ""
        if s3_prefix:
            filter_prefix = f'    filter_prefix = "{s3_prefix}"'
        if s3_suffix:
            filter_suffix = f'    filter_suffix = "{s3_suffix}"'
        s3_trigger_block = f"""
data "aws_s3_bucket" "trigger" {{
  bucket = "{s3_bucket_name}"
}}

resource "aws_lambda_permission" "s3" {{
  statement_id  = "AllowS3"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.this.function_name
  principal     = "s3.amazonaws.com"
  source_arn    = data.aws_s3_bucket.trigger.arn
}}

resource "aws_s3_bucket_notification" "trigger" {{
  bucket = data.aws_s3_bucket.trigger.id
  lambda_function {{
    lambda_function_arn = aws_lambda_function.this.arn
    events              = ["s3:ObjectCreated:*"]
{filter_prefix}
{filter_suffix}
  }}
  depends_on = [aws_lambda_permission.s3]
}}
"""

    # Extra IAM policies based on purpose
    extra_policy = ""
    if purpose_key == "s3-trigger":
        extra_policy = f"""
resource "aws_iam_role_policy" "s3_read" {{
  name = "{name}-s3-read"
  role = aws_iam_role.lambda_exec.id
  policy = jsonencode({{
    Version = "2012-10-17"
    Statement = [{{
      Effect   = "Allow"
      Action   = ["s3:GetObject", "s3:ListBucket"]
      Resource = ["arn:aws:s3:::{s3_bucket_name}", "arn:aws:s3:::{s3_bucket_name}/*"]
    }}]
  }})
}}
"""

    main_tf = f"""terraform {{
  required_providers {{
    aws = {{ source = "hashicorp/aws", version = "~> 5.0" }}
  }}
  cloud {{
    organization = "{org}"
    workspaces {{ name = "{workspace}" }}
  }}
}}

provider "aws" {{ region = "{region}" }}

locals {{
  tags = {{
    ManagedBy   = "terraform"
    CreatedBy   = "openclaw"
    Environment = "{env}"
    Name        = "{name}"
  }}
}}

resource "aws_iam_role" "lambda_exec" {{
  name = "{name}-role"
  assume_role_policy = jsonencode({{
    Version = "2012-10-17"
    Statement = [{{
      Effect    = "Allow"
      Principal = {{ Service = "lambda.amazonaws.com" }}
      Action    = "sts:AssumeRole"
    }}]
  }})
  tags = local.tags
}}

resource "aws_iam_role_policy_attachment" "lambda_basic" {{
  role       = aws_iam_role.lambda_exec.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}}
{extra_policy}
resource "aws_cloudwatch_log_group" "this" {{
  name              = "/aws/lambda/{name}"
  retention_in_days = {90 if env == 'prod' else 14}
  tags              = local.tags
}}

resource "aws_lambda_function" "this" {{
  function_name = "{name}"
  role          = aws_iam_role.lambda_exec.arn
  handler       = "{rt_info['handler']}"
  runtime       = "{rt_info['runtime']}"
  filename      = "${{path.module}}/function.zip"
  source_code_hash = filebase64sha256("${{path.module}}/function.zip")
  memory_size   = {memory}
  timeout       = {timeout}
{env_block}
  depends_on = [aws_cloudwatch_log_group.this]
  tags       = local.tags
}}
{apigw_block}
{cron_block}
{s3_trigger_block}
output "function_name" {{ value = aws_lambda_function.this.function_name }}
output "function_arn"  {{ value = aws_lambda_function.this.arn }}
{apigw_output}
"""
    (outdir / "main.tf").write_text(main_tf)

    # Generate test script
    test_script = outdir / "test.sh"
    test_content = f"""#!/bin/bash
# Test invocation for {name}
set -e

echo "=== Testing Lambda: {name} ==="

# Direct invoke
echo "\n--- Direct Invoke ---"
aws lambda invoke \\
  --function-name {name} \\
  --payload '{{"httpMethod":"GET","path":"/"}}' \\
  --cli-binary-format raw-in-base64-out \\
  --region {region} \\
  /tmp/lambda-response.json
cat /tmp/lambda-response.json
echo
"""
    if create_apigw:
        test_content += f"""
# API Gateway test
echo "\n--- API Gateway Test ---"
endpoint=$(terraform -chdir={outdir} output -raw api_endpoint 2>/dev/null || echo "")
if [ -n "$endpoint" ]; then
  echo "GET $endpoint"
  curl -s "$endpoint" | python3 -m json.tool
else
  echo "Run 'terraform apply' first to get the API endpoint"
fi
"""
    test_content += f"""
echo "\n=== Test complete ==="
"""
    test_script.write_text(test_content)
    os.chmod(test_script, 0o755)

    print(f"\n✅ Generated {outdir}/main.tf for Lambda '{name}'")
    print(f"   Runtime     : {rt_info['runtime']}")
    print(f"   Purpose     : {purpose_labels[purpose_key]}")
    print(f"   Code        : {code_file}")
    print(f"   Package     : {zip_path}")
    if create_apigw:
        print(f"   API Gateway : HTTP endpoint (URL available after apply)")
    if create_cron:
        print(f"   Schedule    : {cron_expr}")
    if create_s3_trigger:
        print(f"   S3 trigger  : {s3_bucket_name}")
    print(f"   Test        : bash {test_script}")
    print(f"   Logs        : /aws/lambda/{name} ({90 if env == 'prod' else 14} day retention)")


def prompt_sg(org, workspace, outdir):
    """Interactively gather Security Group config."""

    COMMON_PRESETS = {
        "1": {
            "name": "Web Server (HTTP/HTTPS)",
            "rules": [
                {"type": "ingress", "port": 80,  "proto": "tcp", "cidr": "0.0.0.0/0", "desc": "HTTP from anywhere"},
                {"type": "ingress", "port": 443, "proto": "tcp", "cidr": "0.0.0.0/0", "desc": "HTTPS from anywhere"},
            ],
        },
        "2": {
            "name": "SSH Bastion",
            "rules": [
                {"type": "ingress", "port": 22, "proto": "tcp", "cidr": "PROMPT", "desc": "SSH from trusted IP"},
            ],
        },
        "3": {
            "name": "Database (PostgreSQL)",
            "rules": [
                {"type": "ingress", "port": 5432, "proto": "tcp", "cidr": "10.0.0.0/8", "desc": "PostgreSQL from private network"},
            ],
        },
        "4": {
            "name": "Database (MySQL)",
            "rules": [
                {"type": "ingress", "port": 3306, "proto": "tcp", "cidr": "10.0.0.0/8", "desc": "MySQL from private network"},
            ],
        },
        "5": {
            "name": "Redis/ElastiCache",
            "rules": [
                {"type": "ingress", "port": 6379, "proto": "tcp", "cidr": "10.0.0.0/8", "desc": "Redis from private network"},
            ],
        },
        "6": {
            "name": "Application (custom port)",
            "rules": [],
        },
        "7": {
            "name": "Full custom",
            "rules": [],
        },
    }

    print("""
🛡️  AWS Security Group Wizard
────────────────────────────────────────────────────────
Security groups are virtual firewalls for your resources.

Best practices:
  - Least privilege: only open ports you need
  - Never use 0.0.0.0/0 for SSH or DB ports
  - Use CIDR ranges for internal traffic (10.0.0.0/8)
  - Separate SGs per tier (web, app, db)
  - All outbound allowed by default (standard)
────────────────────────────────────────────────────────""")

    name   = prompt("Security group name (e.g. marsmovers-web-sg)")
    region = prompt("AWS region", default="us-east-1")
    env    = prompt("Environment", default="dev", choices=["dev", "staging", "prod"])

    # VPC
    print("\n  VPC:")
    vpc_source = prompt("Use existing TFC workspace outputs for VPC?", default="no", choices=["yes", "no"])
    data_blocks = ""
    if vpc_source == "yes":
        vpc_ws = prompt("TFC workspace name with VPC outputs", default="prod-aws")
        data_blocks = f"""
data "terraform_remote_state" "vpc" {{
  backend = "remote"
  config = {{
    organization = "{org}"
    workspaces = {{ name = "{vpc_ws}" }}
  }}
}}
"""
        vpc_ref = "data.terraform_remote_state.vpc.outputs.vpc_id"
    else:
        vpc_id = prompt("VPC ID", default="vpc-xxxxxxxxxxxxxxxxx")
        vpc_ref = f'"{vpc_id}"'

    # Preset selection
    print("\n  Choose a preset or build custom:")
    print("    1) Web Server       — HTTP (80) + HTTPS (443) from anywhere")
    print("    2) SSH Bastion      — SSH (22) from your IP only")
    print("    3) Database (PG)    — PostgreSQL (5432) from private network")
    print("    4) Database (MySQL) — MySQL (3306) from private network")
    print("    5) Redis/Cache      — Redis (6379) from private network")
    print("    6) Application      — Custom port from your CIDR")
    print("    7) Full custom      — Build rules one by one")
    preset = prompt("Preset", default="1", choices=["1","2","3","4","5","6","7"])

    rules = []
    preset_info = COMMON_PRESETS[preset]

    if preset in ("1", "3", "4", "5"):
        rules = preset_info["rules"][:]
    elif preset == "2":
        my_ip = prompt("Your IP or CIDR for SSH access (e.g. 203.0.113.10/32)")
        if not my_ip.endswith("/32") and "/" not in my_ip:
            my_ip += "/32"
            print(f"  ℹ️  Auto-appended /32: {my_ip}")
        rules = [{"type": "ingress", "port": 22, "proto": "tcp", "cidr": my_ip, "desc": "SSH from trusted IP"}]
    elif preset == "6":
        app_port = prompt_num("Application port (e.g. 8080, 3000, 8443)", min_val=1, max_val=65535)
        app_cidr = prompt("Source CIDR", default="10.0.0.0/8")
        rules = [{"type": "ingress", "port": int(app_port), "proto": "tcp", "cidr": app_cidr, "desc": f"App port {app_port}"}]

    # Additional rules
    if preset != "7":
        print(f"\n  Current rules ({preset_info['name']}):")
        for r in rules:
            print(f"    {r['type']:<8} {r['proto']:<5} :{r['port']:<6} from {r['cidr']:<18} — {r['desc']}")

    add_more = prompt("\n  Add more ingress rules?", default="no", choices=["yes", "no"])
    while add_more == "yes" or preset == "7":
        print("\n  Common ports: 22=SSH, 80=HTTP, 443=HTTPS, 3000=Node,")
        print("    3306=MySQL, 5432=PostgreSQL, 6379=Redis, 8080=Alt HTTP,")
        print("    8443=Alt HTTPS, 27017=MongoDB")
        r_port  = prompt_num("Port number", min_val=1, max_val=65535)
        r_port_int = int(r_port)
        r_proto = prompt("Protocol", default="tcp", choices=["tcp", "udp", "icmp"])
        r_cidr  = prompt("Source CIDR", default="10.0.0.0/8")
        r_desc  = prompt("Description", default=f"Port {r_port}")

        if r_cidr == "0.0.0.0/0" and r_port_int in (22, 3306, 5432, 6379, 27017):
            print(f"  ⚠️  WARNING: Opening port {r_port} to 0.0.0.0/0 is a security risk!")
            force = prompt("  Are you sure?", default="no", choices=["yes", "no"])
            if force != "yes":
                print("  Skipped.")
                add_more = prompt("  Add another rule?", default="no", choices=["yes", "no"])
                continue

        rules.append({"type": "ingress", "port": r_port_int, "proto": r_proto, "cidr": r_cidr, "desc": r_desc})
        if preset == "7":
            preset = "done"
        add_more = prompt("  Add another rule?", default="no", choices=["yes", "no"])

    # Egress
    print("\n  Egress (outbound) rules:")
    print("    1) Allow all outbound (standard, recommended)")
    print("    2) Restrict outbound to HTTPS only (443)")
    print("    3) No outbound (fully locked down)")
    egress_choice = prompt("Egress policy", default="3", choices=["1", "2", "3"])

    # Summary
    print(f"\n📋 Design Summary:")
    print(f"   Name        : {name}")
    print(f"   Environment : {env}")
    print(f"   Ingress rules:")
    for r in rules:
        print(f"     {r['proto']:<5} :{r['port']:<6} from {r['cidr']:<18} — {r['desc']}")
    egress_labels = {"1": "All outbound allowed", "2": "HTTPS (443) only", "3": "No outbound"}
    print(f"   Egress      : {egress_labels[egress_choice]}")
    print()
    confirm = prompt("Proceed?", default="yes", choices=["yes", "no"])
    if confirm != "yes":
        print("Aborted.")
        sys.exit(0)

    # Build ingress blocks
    ingress_blocks = ""
    for i, r in enumerate(rules):
        ingress_blocks += f"""
  ingress {{
    from_port   = {r['port']}
    to_port     = {r['port']}
    protocol    = "{r['proto']}"
    cidr_blocks = ["{r['cidr']}"]
    description = "{r['desc']}"
  }}
"""

    # Build egress block
    if egress_choice == "1":
        egress_block = """
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
    description = "Allow all outbound"
  }
"""
    elif egress_choice == "2":
        egress_block = """
  egress {
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
    description = "HTTPS outbound only"
  }
"""
    else:
        egress_block = "  # No egress rules — fully locked down\n"

    main_tf = f"""terraform {{
  required_providers {{
    aws = {{ source = "hashicorp/aws", version = "~> 5.0" }}
  }}
  cloud {{
    organization = "{org}"
    workspaces {{ name = "{workspace}" }}
  }}
}}

provider "aws" {{ region = "{region}" }}
{data_blocks}
locals {{
  tags = {{
    ManagedBy   = "terraform"
    CreatedBy   = "openclaw"
    Environment = "{env}"
    Name        = "{name}"
  }}
}}

resource "aws_security_group" "this" {{
  name        = "{name}"
  description = "Managed by OpenClaw terraform-iac skill"
  vpc_id      = {vpc_ref}
{ingress_blocks}
{egress_block}
  tags = local.tags
}}

output "sg_id"   {{ value = aws_security_group.this.id }}
output "sg_name" {{ value = aws_security_group.this.name }}
"""
    (outdir / "main.tf").write_text(main_tf)
    print(f"\n✅ Generated {outdir}/main.tf for Security Group '{name}'")
    print(f"   Ingress rules : {len(rules)}")
    print(f"   Egress        : {egress_labels[egress_choice]}")


def prompt_landing_zone(org, workspace, outdir):
    """Interactively gather AWS Control Tower Landing Zone config."""

    print("""
🏢 AWS Control Tower Landing Zone Wizard
────────────────────────────────────────────────────────
Sets up a multi-account AWS landing zone with:
  - AWS Organizations with SCPs
  - Organizational Units (Security, Sandbox, Workloads)
  - Core accounts (Log Archive, Audit/Security)
  - CloudTrail org-wide trail
  - AWS Config aggregator
  - Guardrails via SCPs

⚠️  PREREQUISITES:
  - Must run from the AWS Organizations MANAGEMENT account
  - AWS Organizations must be enabled
  - IAM user/role needs OrganizationsFullAccess

Best practice:
  - Separate accounts per workload/environment
  - Centralized logging in Log Archive account
  - Security tooling in dedicated Audit account
  - SCPs to prevent dangerous actions
────────────────────────────────────────────────────────""")

    name   = prompt("Landing zone name (e.g. marsmovers-lz)", default="landing-zone")
    import re
    if not re.match(r'^[a-z0-9][a-z0-9-_]{1,60}[a-z0-9]$', name.lower().replace(" ", "-")):
        print("❌ Invalid landing zone name. Use 3-62 chars of lowercase letters, numbers, hyphens, or underscores, and start/end with a letter or number.")
        sys.exit(1)
    region = prompt("Home region", default="us-east-1")

    # Existing organization check
    print("\n  AWS Organizations:")
    print("    If your management account already has an organization,")
    print("    provide the org ID so Terraform can import it instead of")
    print("    trying to create a new one (which would fail).")
    existing_org_id = prompt("Existing Organization ID (e.g. o-abc123, or 'none' to create new)", default="none")
    has_existing_org = existing_org_id.lower() != "none"

    # Organizational Units
    print("\n  Organizational Units (OUs):")
    print("    Default OUs (always created):")
    print("      Security     — Log Archive + Audit accounts, security tooling")
    print("      Application  — Workload accounts (dev, staging, prod)")
    print("")
    print("    Optional OUs:")
    print("      Sandbox        — Developer experimentation, relaxed guardrails")
    print("      Infrastructure — Shared services (networking, DNS, CI/CD)")
    print("      Policy-Staging — Test SCPs before applying to production OUs")
    print("      Suspended      — Quarantined accounts (locked down, no access)")
    print("      Exceptions     — Accounts needing temporary SCP exemptions")
    print("")
    default_ous = ["Security", "Application"]
    extra = prompt("Add additional OUs? (comma-separated, or 'none')", default="Sandbox,Suspended")
    if extra.lower() == "none":
        ous = default_ous
    else:
        extra_ous = [o.strip() for o in extra.split(",") if o.strip()]
        ous = default_ous[:]
        seen_safe = {ou.lower().replace(" ", "_").replace("-", "_") for ou in ous}
        for ou in extra_ous:
            safe = ou.lower().replace(" ", "_").replace("-", "_")
            if safe in seen_safe:
                print(f"    ⚠️  Skipping duplicate OU: '{ou}'")
                continue
            seen_safe.add(safe)
            ous.append(ou)
    print(f"  ℹ️  Final OUs: {', '.join(ous)}")

    # Core accounts
    print("\n  Core accounts:")
    print("    These are created under the Security OU.")
    log_email   = prompt("Log Archive account email (must be unique, not used by any AWS account)")
    audit_email = prompt("Audit/Security account email (must be unique)")

    # Guardrails / SCPs
    print("\n  Service Control Policies (guardrails):")
    print("    1) Minimal   — deny root user access only")
    print("    2) Standard  — deny root, deny leaving org, deny disabling CloudTrail/Config")
    print("    3) Strict    — standard + region restriction + deny S3 public access")
    scp_level = prompt("Guardrail level", default="2", choices=["1", "2", "3"])

    # Region restriction
    allowed_regions = []
    if scp_level == "3":
        regions_str = prompt("Allowed AWS regions (comma-separated)", default="us-east-1,us-west-2")
        allowed_regions = [r.strip() for r in regions_str.split(",") if r.strip()]

    # CloudTrail org trail
    org_trail = prompt("Enable organization-wide CloudTrail?", default="yes", choices=["yes", "no"])
    org_trail = org_trail == "yes"

    # Config aggregator
    config_agg = prompt("Enable AWS Config aggregator (org-wide compliance)?", default="yes", choices=["yes", "no"])
    config_agg = config_agg == "yes"

    # AWS SSO / Identity Center
    print("\n  AWS IAM Identity Center (SSO):")
    print("    Federated login for all accounts — no IAM users needed.")
    print("    Users sign in once, assume roles in any account.")
    enable_sso = prompt("Enable IAM Identity Center?", default="yes", choices=["yes", "no"])
    enable_sso = enable_sso == "yes"
    sso_groups = []
    if enable_sso:
        print("\n    SSO permission sets (groups → account access):")
        print("      Default groups created:")
        print("        Admins       — AdministratorAccess to all accounts")
        print("        Developers   — PowerUserAccess to Application OU accounts")
        print("        ReadOnly     — ViewOnlyAccess to all accounts")
        print("        SecurityAudit — SecurityAudit to all accounts")
        extra_sso = prompt("Add custom SSO groups? (comma-separated, or 'none')", default="none")
        sso_groups = ["Admins", "Developers", "ReadOnly", "SecurityAudit"]
        if extra_sso.lower() != "none":
            seen_safe = {g.lower().replace(" ", "_").replace("-", "_") for g in sso_groups}
            for g in extra_sso.split(","):
                g = g.strip()
                if not g:
                    continue
                safe = g.lower().replace(" ", "_").replace("-", "_")
                if safe in seen_safe:
                    print(f"      ⚠️  Skipping duplicate SSO group: '{g}'")
                    continue
                seen_safe.add(safe)
                sso_groups.append(g)

    # GuardDuty
    print("\n  Amazon GuardDuty:")
    print("    Org-wide threat detection — monitors CloudTrail, VPC Flow Logs, DNS.")
    print("    Findings sent to delegated admin (Audit account).")
    enable_gd = prompt("Enable GuardDuty org-wide?", default="yes", choices=["yes", "no"])
    enable_gd = enable_gd == "yes"

    # Security Hub
    print("\n  AWS Security Hub:")
    print("    Centralized security findings from GuardDuty, Config, Inspector.")
    print("    Runs CIS and AWS Foundational benchmarks automatically.")
    enable_sh = prompt("Enable Security Hub org-wide?", default="yes", choices=["yes", "no"])
    enable_sh = enable_sh == "yes"
    sh_standards = []
    if enable_sh:
        print("    Standards to enable:")
        print("      1) AWS Foundational Security Best Practices (recommended)")
        print("      2) CIS AWS Foundations Benchmark")
        print("      3) Both")
        sh_choice = prompt("Standards", default="3", choices=["1", "2", "3"])
        if sh_choice in ("1", "3"):
            sh_standards.append("aws-foundational")
        if sh_choice in ("2", "3"):
            sh_standards.append("cis")

    # VPC Baseline
    print("\n  VPC Baseline:")
    print("    Auto-deploy a standard VPC template into workload accounts.")
    print("    Includes public/private subnets, IGW, NAT GW, flow logs.")
    enable_vpc_baseline = prompt("Include VPC baseline template?", default="yes", choices=["yes", "no"])
    enable_vpc_baseline = enable_vpc_baseline == "yes"
    vpc_cidr = "10.0.0.0/16"
    vpc_azs = 2
    if enable_vpc_baseline:
        vpc_cidr = prompt("VPC CIDR for workload accounts", default="10.0.0.0/16")
        vpc_azs = int(prompt("Number of AZs", default="2", choices=["2", "3"]))

    # Account Vending
    print("\n  Account Vending Machine:")
    print("    Terraform module to create new workload accounts on demand.")
    print("    Each account gets: OU placement, budget alert, cross-account role.")
    print("    Note: baseline VPC and CloudTrail are org-wide (configured above),")
    print("    not per-account. Deploy per-account baselines separately if needed.")
    enable_vending = prompt("Include account vending module?", default="yes", choices=["yes", "no"])
    enable_vending = enable_vending == "yes"
    vending_budget = "100"
    vending_email_domain = ""
    if enable_vending:
        vending_email_domain = prompt("Email domain for new accounts (e.g. marsmovers.com)")
        vending_budget = prompt_num("Default monthly budget per account (USD)", default=100, min_val=1)

    # Summary
    print(f"""
📋 Landing Zone Design Summary:
   Name             : {name}
   Home region      : {region}
   OUs              : {', '.join(ous)}
   Log Archive      : {log_email}
   Audit account    : {audit_email}
   Guardrails       : {'Minimal' if scp_level == '1' else 'Standard' if scp_level == '2' else 'Strict'}
   {'Allowed regions  : ' + ', '.join(allowed_regions) if allowed_regions else ''}
   Org CloudTrail   : {'yes' if org_trail else 'no'}
   Config aggregator: {'yes' if config_agg else 'no'}
   IAM Identity Ctr : {'yes (' + str(len(sso_groups)) + ' groups)' if enable_sso else 'no'}
   GuardDuty        : {'yes (org-wide)' if enable_gd else 'no'}
   Security Hub     : {'yes (' + ', '.join(sh_standards) + ')' if enable_sh else 'no'}
   VPC baseline     : {'yes (' + vpc_cidr + ', ' + str(vpc_azs) + ' AZs)' if enable_vpc_baseline else 'no'}
   Account vending  : {'yes (budget $' + vending_budget + '/mo)' if enable_vending else 'no'}
""")
    confirm = prompt("Proceed?", default="yes", choices=["yes", "no"])
    if confirm != "yes":
        print("Aborted.")
        sys.exit(0)

    # Build OU blocks
    ou_blocks = ""
    for ou in ous:
        ou_safe = ou.lower().replace(" ", "_").replace("-", "_")
        ou_blocks += f"""
resource "aws_organizations_organizational_unit" "{ou_safe}" {{
  name      = "{ou}"
  parent_id = aws_organizations_organization.this.roots[0].id
  tags      = local.tags
}}
"""

    # Build SCP blocks
    scp_blocks = ""
    app_ou_ref = "aws_organizations_organizational_unit.application.id" if "Application" in ous else "aws_organizations_organization.this.roots[0].id"

    # Always: deny root
    scp_blocks += f"""
resource "aws_organizations_policy" "deny_root" {{
  name        = "{name}-deny-root-access"
  description = "Deny all actions by root user"
  type        = "SERVICE_CONTROL_POLICY"
  content     = jsonencode({{
    Version = "2012-10-17"
    Statement = [{{
      Sid       = "DenyRootUser"
      Effect    = "Deny"
      Action    = "*"
      Resource  = "*"
      Condition = {{ StringLike = {{ "aws:PrincipalArn" = "arn:aws:iam::*:root" }} }}
    }}]
  }})
  tags = local.tags
}}

resource "aws_organizations_policy_attachment" "deny_root" {{
  policy_id = aws_organizations_policy.deny_root.id
  target_id = aws_organizations_organization.this.roots[0].id
}}
"""

    if scp_level in ("2", "3"):
        scp_blocks += f"""
resource "aws_organizations_policy" "deny_leave_org" {{
  name        = "{name}-deny-leave-org"
  description = "Deny accounts from leaving the organization"
  type        = "SERVICE_CONTROL_POLICY"
  content     = jsonencode({{
    Version = "2012-10-17"
    Statement = [{{
      Sid      = "DenyLeaveOrg"
      Effect   = "Deny"
      Action   = ["organizations:LeaveOrganization"]
      Resource = "*"
    }}]
  }})
  tags = local.tags
}}

resource "aws_organizations_policy_attachment" "deny_leave_org" {{
  policy_id = aws_organizations_policy.deny_leave_org.id
  target_id = aws_organizations_organization.this.roots[0].id
}}

resource "aws_organizations_policy" "deny_disable_security" {{
  name        = "{name}-deny-disable-security"
  description = "Deny disabling CloudTrail, Config, and GuardDuty"
  type        = "SERVICE_CONTROL_POLICY"
  content     = jsonencode({{
    Version = "2012-10-17"
    Statement = [{{
      Sid      = "DenyDisableSecurity"
      Effect   = "Deny"
      Action   = [
        "cloudtrail:StopLogging",
        "cloudtrail:DeleteTrail",
        "config:StopConfigurationRecorder",
        "config:DeleteConfigurationRecorder",
        "guardduty:DeleteDetector",
        "guardduty:DisassociateFromMasterAccount"
      ]
      Resource = "*"
    }}]
  }})
  tags = local.tags
}}

resource "aws_organizations_policy_attachment" "deny_disable_security" {{
  policy_id = aws_organizations_policy.deny_disable_security.id
  target_id = aws_organizations_organization.this.roots[0].id
}}
"""

    if scp_level == "3":
        regions_json = json.dumps(allowed_regions)
        scp_blocks += f"""
resource "aws_organizations_policy" "region_restrict" {{
  name        = "{name}-region-restriction"
  description = "Restrict to allowed regions only"
  type        = "SERVICE_CONTROL_POLICY"
  content     = jsonencode({{
    Version = "2012-10-17"
    Statement = [{{
      Sid       = "DenyOutsideAllowedRegions"
      Effect    = "Deny"
      Action    = "*"
      Resource  = "*"
      Condition = {{
        StringNotEquals = {{ "aws:RequestedRegion" = {regions_json} }}
        ArnNotLike      = {{ "aws:PrincipalArn" = "arn:aws:iam::*:role/OrganizationAccountAccessRole" }}
      }}
    }}]
  }})
  tags = local.tags
}}

resource "aws_organizations_policy_attachment" "region_restrict" {{
  policy_id = aws_organizations_policy.region_restrict.id
  target_id = {app_ou_ref}
}}

resource "aws_organizations_policy" "deny_s3_public" {{
  name        = "{name}-deny-s3-public"
  description = "Deny S3 public access"
  type        = "SERVICE_CONTROL_POLICY"
  content     = jsonencode({{
    Version = "2012-10-17"
    Statement = [{{
      Sid      = "DenyS3PublicAccess"
      Effect   = "Deny"
      Action   = ["s3:PutBucketPublicAccessBlock"]
      Resource = "*"
      Condition = {{
        StringNotEquals = {{
          "s3:PublicAccessBlockConfiguration/BlockPublicAcls"       = "true"
          "s3:PublicAccessBlockConfiguration/BlockPublicPolicy"     = "true"
          "s3:PublicAccessBlockConfiguration/IgnorePublicAcls"      = "true"
          "s3:PublicAccessBlockConfiguration/RestrictPublicBuckets" = "true"
        }}
      }}
    }}]
  }})
  tags = local.tags
}}

resource "aws_organizations_policy_attachment" "deny_s3_public" {{
  policy_id = aws_organizations_policy.deny_s3_public.id
  target_id = aws_organizations_organization.this.roots[0].id
}}
"""

    # Core accounts
    security_ou_ref = "aws_organizations_organizational_unit.security.id" if "Security" in ous else "aws_organizations_organization.this.roots[0].id"

    account_blocks = f"""
resource "aws_organizations_account" "log_archive" {{
  name      = "{name}-log-archive"
  email     = "{log_email}"
  parent_id = {security_ou_ref}
  role_name = "OrganizationAccountAccessRole"
  tags      = merge(local.tags, {{ Purpose = "Log Archive" }})

  lifecycle {{ ignore_changes = [role_name] }}
}}

resource "aws_organizations_account" "audit" {{
  name      = "{name}-audit"
  email     = "{audit_email}"
  parent_id = {security_ou_ref}
  role_name = "OrganizationAccountAccessRole"
  tags      = merge(local.tags, {{ Purpose = "Audit" }})

  lifecycle {{ ignore_changes = [role_name] }}
}}
"""

    # Org CloudTrail
    trail_block = ""
    trail_bucket_block = ""
    if org_trail:
        landing_zone_name = name.strip().lower().replace(" ", "-").replace("_", "-")
        if not landing_zone_name:
            print("❌ Landing zone name cannot be empty")
            sys.exit(1)
        if not validate_landing_zone_name(landing_zone_name):
            print("❌ Landing zone name must be 3-63 chars and use only lowercase letters, numbers, and hyphens.")
            sys.exit(1)
        if landing_zone_name != name.lower().replace(" ", "-").replace("_", "-"):
            print(f"  ℹ️  Normalized landing zone name to '{landing_zone_name}' before deriving the trail bucket")
        name = landing_zone_name
        trail_bucket = f"{name}-org-trail-logs"
        errors = validate_s3_bucket_name(trail_bucket)
        if errors:
            print(f"  ⚠️  Auto-derived trail bucket name '{trail_bucket}' is invalid:")
            for e in errors:
                print(f"     - {e}")
            trail_bucket = prompt("S3 bucket name for org trail logs")
            trail_bucket = trail_bucket.lower().replace(" ", "-").replace("_", "-")
            errors = validate_s3_bucket_name(trail_bucket)
            if errors:
                print("❌ Invalid S3 bucket name:")
                for e in errors:
                    print(f"   - {e}")
                sys.exit(1)
        trail_bucket_block = f"""
resource "aws_s3_bucket" "org_trail" {{
  bucket        = "{trail_bucket}"
  force_destroy = false
  tags          = local.tags
}}

resource "aws_s3_bucket_public_access_block" "org_trail" {{
  bucket                  = aws_s3_bucket.org_trail.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}}

resource "aws_s3_bucket_server_side_encryption_configuration" "org_trail" {{
  bucket = aws_s3_bucket.org_trail.id
  rule {{
    apply_server_side_encryption_by_default {{ sse_algorithm = "AES256" }}
  }}
}}

resource "aws_s3_bucket_lifecycle_configuration" "org_trail" {{
  bucket = aws_s3_bucket.org_trail.id
  rule {{
    id     = "archive"
    status = "Enabled"
    transition {{
      days          = 90
      storage_class = "GLACIER"
    }}
    expiration {{ days = 365 }}
  }}
}}

resource "aws_s3_bucket_policy" "org_trail" {{
  bucket = aws_s3_bucket.org_trail.id
  policy = jsonencode({{
    Version = "2012-10-17"
    Statement = [
      {{
        Sid       = "AWSCloudTrailAclCheck"
        Effect    = "Allow"
        Principal = {{ Service = "cloudtrail.amazonaws.com" }}
        Action    = "s3:GetBucketAcl"
        Resource  = aws_s3_bucket.org_trail.arn
      }},
      {{
        Sid       = "AWSCloudTrailWrite"
        Effect    = "Allow"
        Principal = {{ Service = "cloudtrail.amazonaws.com" }}
        Action    = "s3:PutObject"
        Resource  = "${{aws_s3_bucket.org_trail.arn}}/AWSLogs/${{data.aws_caller_identity.current.account_id}}/*"
        Condition = {{ StringEquals = {{ "s3:x-amz-acl" = "bucket-owner-full-control" }} }}
      }},
      {{
        Sid       = "AWSCloudTrailOrgWrite"
        Effect    = "Allow"
        Principal = {{ Service = "cloudtrail.amazonaws.com" }}
        Action    = "s3:PutObject"
        Resource  = "${{aws_s3_bucket.org_trail.arn}}/AWSLogs/${{aws_organizations_organization.this.id}}/*"
        Condition = {{ StringEquals = {{ "s3:x-amz-acl" = "bucket-owner-full-control" }} }}
      }}
    ]
  }})
}}
"""
        trail_block = f"""
resource "aws_cloudtrail" "org" {{
  name                          = "{name}-org-trail"
  s3_bucket_name                = aws_s3_bucket.org_trail.id
  is_organization_trail         = true
  is_multi_region_trail         = true
  include_global_service_events = true
  enable_log_file_validation    = true
  depends_on                    = [aws_s3_bucket_policy.org_trail]
  tags                          = local.tags
}}
"""

    # Config aggregator
    config_block = ""
    if config_agg:
        config_block = f"""
resource "aws_config_configuration_aggregator" "org" {{
  name = "{name}-org-aggregator"
  organization_aggregation_source {{
    all_regions = true
    role_arn    = aws_iam_role.config_aggregator.arn
  }}
  tags = local.tags
}}

resource "aws_iam_role" "config_aggregator" {{
  name = "{name}-config-aggregator-role"
  assume_role_policy = jsonencode({{
    Version = "2012-10-17"
    Statement = [{{
      Effect    = "Allow"
      Principal = {{ Service = "config.amazonaws.com" }}
      Action    = "sts:AssumeRole"
    }}]
  }})
  tags = local.tags
}}

resource "aws_iam_role_policy_attachment" "config_aggregator" {{
  role       = aws_iam_role.config_aggregator.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSConfigRoleForOrganizations"
}}
"""

    # SSO / Identity Center
    sso_block = ""
    if enable_sso:
        sso_perm_sets = ""
        sso_group_blocks = ""
        perm_set_map = {
            "Admins": "arn:aws:iam::aws:policy/AdministratorAccess",
            "Developers": "arn:aws:iam::aws:policy/PowerUserAccess",
            "ReadOnly": "arn:aws:iam::aws:policy/ViewOnlyAccess",
            "SecurityAudit": "arn:aws:iam::aws:policy/SecurityAudit",
        }
        # Map groups to target account scope
        grp_account_scope = {
            "Admins": "all",
            "Developers": "workloads",
            "ReadOnly": "all",
            "SecurityAudit": "all",
        }
        for grp in sso_groups:
            grp_safe = grp.lower().replace(" ", "_").replace("-", "_")
            policy_arn = perm_set_map.get(grp, "arn:aws:iam::aws:policy/ViewOnlyAccess")
            scope = grp_account_scope.get(grp, "all")
            sso_perm_sets += f"""
resource "aws_ssoadmin_permission_set" "{grp_safe}" {{
  name             = "{grp}"
  instance_arn     = tolist(data.aws_ssoadmin_instances.this.arns)[0]
  session_duration = "PT8H"
  tags             = local.tags
}}

resource "aws_ssoadmin_managed_policy_attachment" "{grp_safe}" {{
  instance_arn       = tolist(data.aws_ssoadmin_instances.this.arns)[0]
  permission_set_arn = aws_ssoadmin_permission_set.{grp_safe}.arn
  managed_policy_arn = "{policy_arn}"
}}

resource "aws_identitystore_group" "{grp_safe}" {{
  identity_store_id = tolist(data.aws_ssoadmin_instances.this.identity_store_ids)[0]
  display_name      = "{grp}"
  description       = "SSO group for {grp}"
}}
"""
            # Account assignments for core accounts
            if scope == "all":
                for acct_key, acct_ref in [("mgmt", "data.aws_caller_identity.current.account_id"), ("log_archive", "aws_organizations_account.log_archive.id"), ("audit", "aws_organizations_account.audit.id")]:
                    sso_perm_sets += f"""
resource "aws_ssoadmin_account_assignment" "{grp_safe}_{acct_key}" {{
  instance_arn       = tolist(data.aws_ssoadmin_instances.this.arns)[0]
  permission_set_arn = aws_ssoadmin_permission_set.{grp_safe}.arn
  principal_id       = aws_identitystore_group.{grp_safe}.group_id
  principal_type     = "GROUP"
  target_id          = {acct_ref}
  target_type        = "AWS_ACCOUNT"
}}
"""
        sso_block = f"""
data "aws_ssoadmin_instances" "this" {{}}
{sso_perm_sets}
"""

    # GuardDuty
    guardduty_block = ""
    if enable_gd:
        guardduty_block = f"""
# GuardDuty: management account enables detector and delegates admin to Audit
resource "aws_guardduty_detector" "this" {{
  enable = true
  tags   = local.tags
}}

resource "aws_guardduty_organization_admin_account" "audit" {{
  admin_account_id = aws_organizations_account.audit.id
  depends_on       = [aws_guardduty_detector.this]
}}

# NOTE: aws_guardduty_organization_configuration must be applied from the
# delegated admin (Audit) account, and it must target the delegated admin
# detector created in that account. Use the Audit account workspace for the
# org-wide configuration below after creating an Audit-account detector.
#
#   resource "aws_guardduty_detector" "admin" {{
#     enable = true
#   }}
#
#   resource "aws_guardduty_organization_configuration" "this" {{
#     detector_id = aws_guardduty_detector.admin.id
#     auto_enable_organization_members = "ALL"
#   }}
#
# The management workspace only creates the detector and assigns delegated admin.
"""

    # Security Hub
    securityhub_block = ""
    if enable_sh:
        standards_blocks = ""
        if "aws-foundational" in sh_standards:
            standards_blocks += f"""
resource "aws_securityhub_standards_subscription" "aws_foundational" {{
  standards_arn = "arn:aws:securityhub:::standards/aws-foundational-security-best-practices/v/1.0.0"
  depends_on    = [aws_securityhub_account.this]
}}
"""
        if "cis" in sh_standards:
            standards_blocks += f"""
resource "aws_securityhub_standards_subscription" "cis" {{
  standards_arn = "arn:aws:securityhub:::ruleset/cis-aws-foundations-benchmark/v/1.4.0"
  depends_on    = [aws_securityhub_account.this]
}}
"""
        securityhub_block = f"""
resource "aws_securityhub_account" "this" {{}}

resource "aws_securityhub_organization_admin_account" "audit" {{
  admin_account_id = aws_organizations_account.audit.id
  depends_on       = [aws_securityhub_account.this]
}}

# NOTE: aws_securityhub_organization_configuration and standards subscriptions
# must be applied from the delegated admin (Audit) account, not the management
# account. Deploy the following in a separate workspace with Audit account
# credentials:
#
#   resource "aws_securityhub_account" "admin" {{}}
#
#   resource "aws_securityhub_organization_configuration" "this" {{
#     auto_enable           = true
#     auto_enable_standards = "DEFAULT"
#     depends_on            = [aws_securityhub_account.admin]
#   }}
{standards_blocks}
"""

    # VPC Baseline
    vpc_baseline_block = ""
    if enable_vpc_baseline:
        base = vpc_cidr.split("/")[0].rsplit(".", 2)[0]
        pub_subs  = [f"{base}.{i}.0/24" for i in range(vpc_azs)]
        priv_subs = [f"{base}.{i+10}.0/24" for i in range(vpc_azs)]
        vpc_baseline_block = f"""
# ============================================================
# VPC Baseline Module (deploy into each workload account)
# ============================================================
# This is a reference template. Use with account vending or
# deploy separately per account using terraform_remote_state.
#
# VPC CIDR     : {vpc_cidr}
# Public subs  : {', '.join(pub_subs)}
# Private subs : {', '.join(priv_subs)}
# AZs          : {vpc_azs}
#
# To deploy: copy this block into a per-account workspace,
# or use the account vending module below.
# ============================================================

module "vpc_baseline" {{
  source  = "terraform-aws-modules/vpc/aws"
  version = "~> 5.0"

  name = "{name}-workload-vpc"
  cidr = "{vpc_cidr}"

  azs             = [for i in range({vpc_azs}) : data.aws_availability_zones.available.names[i]]
  public_subnets  = {json.dumps(pub_subs)}
  private_subnets = {json.dumps(priv_subs)}

  enable_nat_gateway   = true
  single_nat_gateway   = true
  enable_dns_hostnames = true
  enable_dns_support   = true

  enable_flow_log                      = true
  create_flow_log_cloudwatch_log_group = true
  create_flow_log_iam_role             = true
  flow_log_max_aggregation_interval    = 60

  tags = local.tags
}}

data "aws_availability_zones" "available" {{ state = "available" }}
"""

    # Account Vending
    vending_block = ""
    if enable_vending:
        vending_block = f"""
# ============================================================
# Account Vending Machine
# ============================================================
# Usage: add entries to the 'workload_accounts' variable to
# create new accounts with baseline resources.
#
# Each account gets:
#   - Placed in Application OU
#   - Monthly budget alert
#   - OrganizationAccountAccessRole for cross-account access
# ============================================================

variable "workload_accounts" {{
  description = "Map of workload accounts to create"
  type = map(object({{
    email       = string
    environment = optional(string, "dev")
    budget      = optional(number, {vending_budget})
  }}))
  default = {{
    # Example:
    # "app-dev" = {{
    #   email       = "app-dev@{vending_email_domain}"
    #   environment = "dev"
    #   budget      = 100
    # }}
  }}
}}

resource "aws_organizations_account" "workload" {{
  for_each  = var.workload_accounts
  name      = "${{each.key}}"
  email     = each.value.email
  parent_id = {app_ou_ref}
  role_name = "OrganizationAccountAccessRole"
  tags      = merge(local.tags, {{
    Environment = each.value.environment
    Purpose     = "Workload"
  }})
  lifecycle {{ ignore_changes = [role_name] }}
}}

resource "aws_budgets_budget" "workload" {{
  for_each     = var.workload_accounts
  name         = "${{each.key}}-monthly-budget"
  budget_type  = "COST"
  limit_amount = tostring(each.value.budget)
  limit_unit   = "USD"
  time_unit    = "MONTHLY"

  cost_filter {{
    name   = "LinkedAccount"
    values = [aws_organizations_account.workload[each.key].id]
  }}

  notification {{
    comparison_operator        = "GREATER_THAN"
    threshold                  = 80
    threshold_type             = "PERCENTAGE"
    notification_type          = "ACTUAL"
    subscriber_email_addresses = [each.value.email]
  }}

  notification {{
    comparison_operator        = "GREATER_THAN"
    threshold                  = 100
    threshold_type             = "PERCENTAGE"
    notification_type          = "FORECASTED"
    subscriber_email_addresses = [each.value.email]
  }}
}}

output "workload_account_ids" {{
  value = {{ for k, v in aws_organizations_account.workload : k => v.id }}
}}
"""
        # Add SSO assignments for workload accounts if SSO is enabled
        if enable_sso:
            for grp in sso_groups:
                grp_safe = grp.lower().replace(" ", "_").replace("-", "_")
                scope = grp_account_scope.get(grp, "all")
                if scope in ("all", "workloads"):
                    vending_block += f"""
resource "aws_ssoadmin_account_assignment" "{grp_safe}_workload" {{
  for_each           = var.workload_accounts
  instance_arn       = tolist(data.aws_ssoadmin_instances.this.arns)[0]
  permission_set_arn = aws_ssoadmin_permission_set.{grp_safe}.arn
  principal_id       = aws_identitystore_group.{grp_safe}.group_id
  principal_type     = "GROUP"
  target_id          = aws_organizations_account.workload[each.key].id
  target_type        = "AWS_ACCOUNT"
}}
"""

    # Extra service access principals
    extra_principals = []
    if enable_gd:
        extra_principals.append('"guardduty.amazonaws.com"')
    if enable_sh:
        extra_principals.append('"securityhub.amazonaws.com"')

    extra_principals_str = ""
    if extra_principals:
        extra_principals_str = "\n".join([f"    {p}," for p in extra_principals])

    guardduty_admin_block = ""
    if enable_gd:
        guardduty_admin_block = f"""
resource \"aws_guardduty_organization_admin_account\" \"audit\" {{
  admin_account_id = aws_organizations_account.audit.id
  depends_on       = [aws_organizations_organization.this]
}}

resource \"aws_guardduty_organization_configuration\" \"this\" {{
  auto_enable = true
  detector_id  = aws_guardduty_detector.audit.id
  depends_on   = [aws_guardduty_organization_admin_account.audit]
}}
"""

    guardduty_block = f"""
resource \"aws_guardduty_detector\" \"audit\" {{
  enable                               = true
  finding_publishing_frequency        = \"SIX_HOURS\"
  datasources {{
    s3_logs {{ enable = true }}
    kubernetes {{ audit_logs {{ enable = true }} }}
    malware_protection {{ scan_ec2_instance_with_findings {{ ebs_volumes = true }} }}
  }}
  tags = local.tags
}}

{guardduty_admin_block}"""

    # Generate import block for existing organizations
    org_import_block = ""
    if has_existing_org:
        org_import_block = f"""
import {{
  to = aws_organizations_organization.this
  id = "{existing_org_id}"
}}
"""

    main_tf = f"""terraform {{
  required_providers {{
    aws = {{ source = "hashicorp/aws", version = "~> 5.0" }}
  }}
  cloud {{
    organization = "{org}"
    workspaces {{ name = "{workspace}" }}
  }}
}}

provider "aws" {{ region = "{region}" }}

data "aws_caller_identity" "current" {{}}

locals {{
  tags = {{
    ManagedBy   = "terraform"
    CreatedBy   = "openclaw"
    LandingZone = "{name}"
  }}
}}
{org_import_block}
resource "aws_organizations_organization" "this" {{
  aws_service_access_principals = [
    "cloudtrail.amazonaws.com",
    "config.amazonaws.com",
    "sso.amazonaws.com",
{extra_principals_str}
  ]
  enabled_policy_types = ["SERVICE_CONTROL_POLICY"]
  feature_set          = "ALL"

  # If your organization already exists, import it:
  #   terraform import aws_organizations_organization.this <org-id>
  # The org-id is printed by: aws organizations describe-organization
}}
{ou_blocks}
{account_blocks}
{scp_blocks}
{trail_bucket_block}
{trail_block}
{config_block}
{sso_block}
{guardduty_block}
{securityhub_block}
{vpc_baseline_block}
{vending_block}
output "org_id"             {{ value = aws_organizations_organization.this.id }}
output "log_archive_id"     {{ value = aws_organizations_account.log_archive.id }}
output "audit_account_id"   {{ value = aws_organizations_account.audit.id }}
"""
    (outdir / "main.tf").write_text(main_tf)
    print(f"\n✅ Generated {outdir}/main.tf for Landing Zone '{name}'")
    print(f"   OUs             : {', '.join(ous)}")
    print(f"   Core accounts   : Log Archive, Audit")
    print(f"   Guardrails      : {'Minimal' if scp_level == '1' else 'Standard' if scp_level == '2' else 'Strict'}")
    print(f"   Org CloudTrail  : {'enabled' if org_trail else 'disabled'}")
    print(f"   Config agg      : {'enabled' if config_agg else 'disabled'}")
    print(f"   IAM Identity Ctr: {'enabled (' + str(len(sso_groups)) + ' groups)' if enable_sso else 'disabled'}")
    print(f"   GuardDuty       : {'enabled (org-wide)' if enable_gd else 'disabled'}")
    print(f"   Security Hub    : {'enabled (' + ', '.join(sh_standards) + ')' if enable_sh else 'disabled'}")
    print(f"   VPC baseline    : {'enabled (' + vpc_cidr + ')' if enable_vpc_baseline else 'disabled'}")
    print(f"   Account vending : {'enabled ($' + vending_budget + '/mo budget)' if enable_vending else 'disabled'}")

def prompt_efs(org, workspace, outdir):
    """Interactively gather EFS config."""

    print("""
📁 AWS EFS (Elastic File System) Wizard
────────────────────────────────────────────────────────
Shared NFS file system mountable by multiple EC2/ECS/EKS.
Automatically scales, no capacity provisioning needed.

Performance modes:
  - generalPurpose : low latency, most workloads (default)
  - maxIO          : high throughput, big data / media

Throughput modes:
  - bursting  : scales with storage size (free tier friendly)
  - elastic   : auto-scales throughput independent of size
  - provisioned : fixed throughput you set (predictable cost)

Storage classes:
  - Standard              : frequent access
  - Infrequent Access (IA): auto-tiered, 90%+ cost savings
────────────────────────────────────────────────────────""")

    name   = prompt("EFS name (e.g. marsmovers-shared-fs)")
    region = prompt("AWS region", default="us-east-1")
    env    = prompt("Environment", default="dev", choices=["dev", "staging", "prod"])

    # Performance mode
    print("\n  Performance mode:")
    print("    1) generalPurpose — low latency, web apps, CMS, dev (recommended)")
    print("    2) maxIO          — high parallelism, big data, media processing")
    perf = prompt("Performance mode", default="1", choices=["1", "2"])
    perf_mode = "generalPurpose" if perf == "1" else "maxIO"

    # Throughput mode
    print("\n  Throughput mode:")
    print("    1) bursting    — scales with storage, good for spiky workloads (cheapest)")
    print("    2) elastic     — auto-scales throughput, pay per use (recommended for prod)")
    print("    3) provisioned — fixed throughput you set, predictable cost")
    tp = prompt("Throughput mode", default="1", choices=["1", "2", "3"])
    tp_map = {"1": "bursting", "2": "elastic", "3": "provisioned"}
    tp_mode = tp_map[tp]
    provisioned_block = ""
    if tp_mode == "provisioned":
        tp_mibps = prompt_num("Provisioned throughput (MiB/s, min 1)", default=10, min_val=1)
        provisioned_block = f'  provisioned_throughput_in_mibps = {tp_mibps}'

    # Encryption
    encrypted = prompt("Encrypt at rest? (recommended)", default="yes", choices=["yes", "no"])
    encrypted = encrypted == "yes"

    # Lifecycle / IA tiering
    print("\n  Lifecycle policy (move infrequently accessed files to cheaper storage):")
    print("    Saves up to 92% on storage costs for cold files.")
    ia_enabled = prompt("Enable Infrequent Access tiering?", default="yes", choices=["yes", "no"])
    ia_enabled = ia_enabled == "yes"
    ia_days = "30"
    if ia_enabled:
        ia_days = prompt("Move to IA after (days)", default="30", choices=["7", "14", "30", "60", "90"])

    # VPC / Subnets for mount targets
    print("\n  Mount targets (EFS needs one per AZ in your VPC):")
    print("    If you deployed a VPC with this skill, enter its workspace name.")
    print("    Otherwise enter subnet IDs manually (comma-separated).")
    vpc_source = prompt("Use existing TFC workspace outputs for subnets?", default="no", choices=["yes", "no"])

    data_blocks = ""
    mount_blocks = ""
    sg_vpc_ref = ""

    if vpc_source == "yes":
        vpc_ws = prompt("TFC workspace name with VPC outputs", default="prod-aws")
        data_blocks = f"""
data "terraform_remote_state" "vpc" {{
  backend = "remote"
  config = {{
    organization = "{org}"
    workspaces = {{ name = "{vpc_ws}" }}
  }}
}}
"""
        sg_vpc_ref = "data.terraform_remote_state.vpc.outputs.vpc_id"
        # Dynamic mount targets from remote state
        mount_blocks = f"""
resource "aws_efs_mount_target" "this" {{
  count           = length(data.terraform_remote_state.vpc.outputs.private_subnets)
  file_system_id  = aws_efs_file_system.this.id
  subnet_id       = data.terraform_remote_state.vpc.outputs.private_subnets[count.index]
  security_groups = [aws_security_group.efs.id]
}}
"""
        subnet_display = f"private subnets from {vpc_ws}"
    else:
        vpc_id = prompt("VPC ID", default="vpc-xxxxxxxxxxxxxxxxx")
        subnets_str = prompt("Subnet IDs (comma-separated, one per AZ)", default="subnet-aaa,subnet-bbb")
        subnets = [s.strip() for s in subnets_str.split(",") if s.strip()]
        sg_vpc_ref = f'"{vpc_id}"'
        for i, sub in enumerate(subnets):
            mount_blocks += f"""
resource "aws_efs_mount_target" "mt_{i}" {{
  file_system_id  = aws_efs_file_system.this.id
  subnet_id       = "{sub}"
  security_groups = [aws_security_group.efs.id]
}}
"""
        subnet_display = ", ".join(subnets)

    # Lifecycle block
    lifecycle_block = ""
    if ia_enabled:
        lifecycle_block = f"""
  lifecycle_policy {{
    transition_to_ia = "AFTER_{ia_days}_DAYS"
  }}
  lifecycle_policy {{
    transition_to_primary_storage_class = "AFTER_1_ACCESS"
  }}
"""

    print(f"""
📋 Design Summary:
   Name           : {name}
   Performance    : {perf_mode}
   Throughput     : {tp_mode}{(' (' + tp_mibps + ' MiB/s)') if tp_mode == 'provisioned' else ''}
   Encrypted      : {'yes' if encrypted else 'no'}
   IA tiering     : {'after ' + ia_days + ' days' if ia_enabled else 'disabled'}
   Mount targets  : {subnet_display}
   Environment    : {env}
   Region         : {region}
""")
    confirm = prompt("Proceed?", default="yes", choices=["yes", "no"])
    if confirm != "yes":
        print("Aborted.")
        sys.exit(0)

    main_tf = f"""terraform {{
  required_providers {{
    aws = {{ source = "hashicorp/aws", version = "~> 5.0" }}
  }}
  cloud {{
    organization = "{org}"
    workspaces {{ name = "{workspace}" }}
  }}
}}

provider "aws" {{ region = "{region}" }}
{data_blocks}
locals {{
  tags = {{
    ManagedBy   = "terraform"
    CreatedBy   = "openclaw"
    Environment = "{env}"
    Name        = "{name}"
  }}
}}

resource "aws_security_group" "efs" {{
  name        = "{name}-efs-sg"
  description = "Allow NFS traffic for EFS {name}"
  vpc_id      = {sg_vpc_ref}

  ingress {{
    from_port   = 2049
    to_port     = 2049
    protocol    = "tcp"
    cidr_blocks = ["10.0.0.0/8"]
    description = "NFS from private network"
  }}

  egress {{
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }}

  tags = merge(local.tags, {{ Name = "{name}-efs-sg" }})
}}

resource "aws_efs_file_system" "this" {{
  creation_token   = "{name}"
  performance_mode = "{perf_mode}"
  throughput_mode  = "{tp_mode}"
{provisioned_block}
  encrypted        = {str(encrypted).lower()}
{lifecycle_block}
  tags = merge(local.tags, {{ Name = "{name}" }})
}}
{mount_blocks}
resource "aws_efs_backup_policy" "this" {{
  file_system_id = aws_efs_file_system.this.id
  backup_policy {{
    status = "ENABLED"
  }}
}}

output "efs_id"      {{ value = aws_efs_file_system.this.id }}
output "efs_dns"     {{ value = aws_efs_file_system.this.dns_name }}
output "efs_sg_id"   {{ value = aws_security_group.efs.id }}
"""
    (outdir / "main.tf").write_text(main_tf)
    print(f"\n✅ Generated {outdir}/main.tf for EFS '{name}'")
    print(f"   Performance : {perf_mode}")
    print(f"   Throughput  : {tp_mode}")
    print(f"   Encrypted   : {'yes' if encrypted else 'no'}")
    print(f"   Backup      : enabled (AWS Backup)")
    if ia_enabled:
        print(f"   IA tiering  : after {ia_days} days (auto-promote on access)")


def prompt_cloudwatch(org, workspace, outdir):
    """Interactively gather CloudWatch alarms + dashboard config."""

    print("""
📊 AWS CloudWatch Wizard
────────────────────────────────────────────────────────
Sets up CloudWatch metric alarms with SNS notifications.
Optionally creates a dashboard for visual monitoring.

Common alarm patterns:
  - EC2: CPU, status checks, disk, network
  - RDS: CPU, connections, free storage, replica lag
  - Lambda: errors, duration, throttles
  - ALB: 5xx errors, latency, unhealthy hosts
  - Billing: estimated charges
────────────────────────────────────────────────────────""")

    name   = prompt("Monitoring stack name (e.g. marsmovers-monitoring)")
    region = prompt("AWS region", default="us-east-1")
    env    = prompt("Environment", default="prod", choices=["dev", "staging", "prod"])

    # SNS topic for notifications
    print("\n  Alarm notifications:")
    print("    Alarms need an SNS topic to send alerts.")
    sns_choice = prompt("Create new SNS topic or use existing?", default="new", choices=["new", "existing"])
    if sns_choice == "existing":
        sns_arn = prompt("Existing SNS topic ARN")
        sns_block = ""
        sns_ref = f'"{sns_arn}"'
    else:
        sns_topic_name = f"{name}-alerts"
        email = prompt("Alert email address")
        sns_block = f"""
resource "aws_sns_topic" "alerts" {{
  name = "{sns_topic_name}"
  tags = local.tags
}}

resource "aws_sns_topic_subscription" "email" {{
  topic_arn = aws_sns_topic.alerts.arn
  protocol  = "email"
  endpoint  = "{email}"
}}
"""
        sns_ref = "aws_sns_topic.alerts.arn"

    # Alarm type selection
    print("\n  Which alarm set do you want?")
    print("    1) EC2 instance alarms (CPU, status check, network)")
    print("    2) RDS database alarms (CPU, connections, storage)")
    print("    3) Lambda function alarms (errors, duration, throttles)")
    print("    4) Billing alarm (estimated monthly charges)")
    print("    5) Custom metric alarm")
    alarm_type = prompt("Alarm set", default="1", choices=["1", "2", "3", "4", "5"])

    alarm_blocks = ""
    dashboard_widgets = []

    if alarm_type == "1":
        instance_id = prompt("EC2 Instance ID (e.g. i-0abc1234)")
        cpu_threshold = prompt_num("CPU alarm threshold (%)", default=80, min_val=1, max_val=100)
        alarm_blocks = f"""
resource "aws_cloudwatch_metric_alarm" "cpu_high" {{
  alarm_name          = "{name}-ec2-cpu-high"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 2
  metric_name         = "CPUUtilization"
  namespace           = "AWS/EC2"
  period              = 300
  statistic           = "Average"
  threshold           = {cpu_threshold}
  alarm_description   = "EC2 CPU > {cpu_threshold}% for 10 min"
  alarm_actions       = [{sns_ref}]
  ok_actions          = [{sns_ref}]
  dimensions = {{ InstanceId = "{instance_id}" }}
  tags = local.tags
}}

resource "aws_cloudwatch_metric_alarm" "status_check" {{
  alarm_name          = "{name}-ec2-status-check"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 2
  metric_name         = "StatusCheckFailed"
  namespace           = "AWS/EC2"
  period              = 300
  statistic           = "Maximum"
  threshold           = 0
  alarm_description   = "EC2 status check failed"
  alarm_actions       = [{sns_ref}]
  ok_actions          = [{sns_ref}]
  dimensions = {{ InstanceId = "{instance_id}" }}
  tags = local.tags
}}

resource "aws_cloudwatch_metric_alarm" "network_in" {{
  alarm_name          = "{name}-ec2-network-in-high"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 2
  metric_name         = "NetworkIn"
  namespace           = "AWS/EC2"
  period              = 300
  statistic           = "Average"
  threshold           = 500000000  # 500MB in 5 min
  alarm_description   = "EC2 inbound network > 500MB/5min"
  alarm_actions       = [{sns_ref}]
  dimensions = {{ InstanceId = "{instance_id}" }}
  tags = local.tags
}}
"""
        dashboard_widgets = [
            f'{{ "type": "metric", "properties": {{ "metrics": [["AWS/EC2", "CPUUtilization", "InstanceId", "{instance_id}"]], "period": 300, "title": "EC2 CPU" }} }}',
            f'{{ "type": "metric", "properties": {{ "metrics": [["AWS/EC2", "NetworkIn", "InstanceId", "{instance_id}"], ["AWS/EC2", "NetworkOut", "InstanceId", "{instance_id}"]], "period": 300, "title": "EC2 Network" }} }}',
            f'{{ "type": "metric", "properties": {{ "metrics": [["AWS/EC2", "StatusCheckFailed", "InstanceId", "{instance_id}"]], "period": 300, "title": "EC2 Status" }} }}',
        ]
        alarm_summary = f"EC2 alarms for {instance_id}: CPU>{cpu_threshold}%, status check, network"

    elif alarm_type == "2":
        db_id = prompt("RDS DB instance identifier (e.g. marsmovers-db)")
        cpu_threshold = prompt_num("CPU alarm threshold (%)", default=80, min_val=1, max_val=100)
        conn_threshold = prompt_num("Max connections alarm threshold", default=100, min_val=1)
        storage_threshold = prompt_num("Free storage alarm threshold (bytes, default 5GB)", default=5368709120, min_val=0)
        alarm_blocks = f"""
resource "aws_cloudwatch_metric_alarm" "rds_cpu" {{
  alarm_name          = "{name}-rds-cpu-high"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 2
  metric_name         = "CPUUtilization"
  namespace           = "AWS/RDS"
  period              = 300
  statistic           = "Average"
  threshold           = {cpu_threshold}
  alarm_description   = "RDS CPU > {cpu_threshold}% for 10 min"
  alarm_actions       = [{sns_ref}]
  ok_actions          = [{sns_ref}]
  dimensions = {{ DBInstanceIdentifier = "{db_id}" }}
  tags = local.tags
}}

resource "aws_cloudwatch_metric_alarm" "rds_connections" {{
  alarm_name          = "{name}-rds-connections-high"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 2
  metric_name         = "DatabaseConnections"
  namespace           = "AWS/RDS"
  period              = 300
  statistic           = "Average"
  threshold           = {conn_threshold}
  alarm_description   = "RDS connections > {conn_threshold}"
  alarm_actions       = [{sns_ref}]
  ok_actions          = [{sns_ref}]
  dimensions = {{ DBInstanceIdentifier = "{db_id}" }}
  tags = local.tags
}}

resource "aws_cloudwatch_metric_alarm" "rds_storage" {{
  alarm_name          = "{name}-rds-free-storage-low"
  comparison_operator = "LessThanThreshold"
  evaluation_periods  = 1
  metric_name         = "FreeStorageSpace"
  namespace           = "AWS/RDS"
  period              = 300
  statistic           = "Average"
  threshold           = {storage_threshold}
  alarm_description   = "RDS free storage below threshold"
  alarm_actions       = [{sns_ref}]
  ok_actions          = [{sns_ref}]
  dimensions = {{ DBInstanceIdentifier = "{db_id}" }}
  tags = local.tags
}}
"""
        dashboard_widgets = [
            f'{{ "type": "metric", "properties": {{ "metrics": [["AWS/RDS", "CPUUtilization", "DBInstanceIdentifier", "{db_id}"]], "period": 300, "title": "RDS CPU" }} }}',
            f'{{ "type": "metric", "properties": {{ "metrics": [["AWS/RDS", "DatabaseConnections", "DBInstanceIdentifier", "{db_id}"]], "period": 300, "title": "RDS Connections" }} }}',
            f'{{ "type": "metric", "properties": {{ "metrics": [["AWS/RDS", "FreeStorageSpace", "DBInstanceIdentifier", "{db_id}"]], "period": 300, "title": "RDS Free Storage" }} }}',
        ]
        alarm_summary = f"RDS alarms for {db_id}: CPU>{cpu_threshold}%, connections>{conn_threshold}, storage"

    elif alarm_type == "3":
        fn_name = prompt("Lambda function name")
        error_threshold = prompt_num("Error count alarm threshold (per 5 min)", default=5, min_val=0)
        duration_threshold = prompt_num("Duration alarm threshold (ms)", default=10000, min_val=1)
        alarm_blocks = f"""
resource "aws_cloudwatch_metric_alarm" "lambda_errors" {{
  alarm_name          = "{name}-lambda-errors"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "Errors"
  namespace           = "AWS/Lambda"
  period              = 300
  statistic           = "Sum"
  threshold           = {error_threshold}
  alarm_description   = "Lambda errors > {error_threshold} in 5 min"
  alarm_actions       = [{sns_ref}]
  ok_actions          = [{sns_ref}]
  dimensions = {{ FunctionName = "{fn_name}" }}
  tags = local.tags
}}

resource "aws_cloudwatch_metric_alarm" "lambda_duration" {{
  alarm_name          = "{name}-lambda-duration"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 2
  metric_name         = "Duration"
  namespace           = "AWS/Lambda"
  period              = 300
  statistic           = "Average"
  threshold           = {duration_threshold}
  alarm_description   = "Lambda avg duration > {duration_threshold}ms"
  alarm_actions       = [{sns_ref}]
  dimensions = {{ FunctionName = "{fn_name}" }}
  tags = local.tags
}}

resource "aws_cloudwatch_metric_alarm" "lambda_throttles" {{
  alarm_name          = "{name}-lambda-throttles"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "Throttles"
  namespace           = "AWS/Lambda"
  period              = 300
  statistic           = "Sum"
  threshold           = 0
  alarm_description   = "Lambda throttled"
  alarm_actions       = [{sns_ref}]
  dimensions = {{ FunctionName = "{fn_name}" }}
  tags = local.tags
}}
"""
        dashboard_widgets = [
            f'{{ "type": "metric", "properties": {{ "metrics": [["AWS/Lambda", "Errors", "FunctionName", "{fn_name}"], ["AWS/Lambda", "Invocations", "FunctionName", "{fn_name}"]], "period": 300, "title": "Lambda Errors/Invocations" }} }}',
            f'{{ "type": "metric", "properties": {{ "metrics": [["AWS/Lambda", "Duration", "FunctionName", "{fn_name}"]], "period": 300, "title": "Lambda Duration" }} }}',
            f'{{ "type": "metric", "properties": {{ "metrics": [["AWS/Lambda", "Throttles", "FunctionName", "{fn_name}"]], "period": 300, "title": "Lambda Throttles" }} }}',
        ]
        alarm_summary = f"Lambda alarms for {fn_name}: errors>{error_threshold}, duration>{duration_threshold}ms, throttles"

    elif alarm_type == "4":
        billing_threshold = prompt_num("Monthly billing alarm threshold (USD)", default=100, min_val=1)
        alarm_blocks = f"""
resource "aws_cloudwatch_metric_alarm" "billing" {{
  alarm_name          = "{name}-billing-alarm"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "EstimatedCharges"
  namespace           = "AWS/Billing"
  period              = 21600  # 6 hours
  statistic           = "Maximum"
  threshold           = {billing_threshold}
  alarm_description   = "Estimated charges > ${billing_threshold}"
  alarm_actions       = [{sns_ref}]
  dimensions = {{ Currency = "USD" }}
  tags = local.tags
}}
"""
        dashboard_widgets = [
            f'{{ "type": "metric", "properties": {{ "metrics": [["AWS/Billing", "EstimatedCharges", "Currency", "USD"]], "period": 21600, "stat": "Maximum", "title": "Estimated Charges (USD)" }} }}',
        ]
        alarm_summary = f"Billing alarm: >${billing_threshold} USD/month"
        print(f"  ℹ️  Billing metrics require us-east-1. Region forced to us-east-1.")
        region = "us-east-1"

    else:  # custom
        cw_namespace = prompt("CloudWatch namespace (e.g. AWS/EC2, Custom/MyApp)")
        cw_metric = prompt("Metric name")
        cw_stat = prompt("Statistic", default="Average", choices=["Average", "Sum", "Maximum", "Minimum", "SampleCount"])
        cw_period = prompt_num("Period (seconds)", default=300, min_val=10)
        cw_operator = prompt("Comparison", default="GreaterThanThreshold", choices=["GreaterThanThreshold", "LessThanThreshold", "GreaterThanOrEqualToThreshold", "LessThanOrEqualToThreshold"])
        cw_threshold = prompt_num("Threshold value", default=0)
        cw_eval = prompt_num("Evaluation periods", default=2, min_val=1)
        cw_dim_key = prompt("Dimension key (e.g. InstanceId, leave blank for none)", default="")
        cw_dim_val = ""
        dim_block = ""
        if cw_dim_key:
            cw_dim_val = prompt(f"Dimension value for {cw_dim_key}")
            dim_block = f'  dimensions = {{ {cw_dim_key} = "{cw_dim_val}" }}'
        alarm_blocks = f"""
resource "aws_cloudwatch_metric_alarm" "custom" {{
  alarm_name          = "{name}-custom-alarm"
  comparison_operator = "{cw_operator}"
  evaluation_periods  = {cw_eval}
  metric_name         = "{cw_metric}"
  namespace           = "{cw_namespace}"
  period              = {cw_period}
  statistic           = "{cw_stat}"
  threshold           = {cw_threshold}
  alarm_description   = "Custom alarm: {cw_namespace}/{cw_metric} {cw_operator} {cw_threshold}"
  alarm_actions       = [{sns_ref}]
  ok_actions          = [{sns_ref}]
{dim_block}
  tags = local.tags
}}
"""
        dashboard_widgets = []
        alarm_summary = f"Custom alarm: {cw_namespace}/{cw_metric} {cw_stat} {cw_operator} {cw_threshold}"

    # Dashboard
    create_dashboard = prompt("\n  Create a CloudWatch dashboard?", default="yes", choices=["yes", "no"])
    dashboard_block = ""
    if create_dashboard == "yes" and dashboard_widgets:
        widgets_json = ",\n      ".join(dashboard_widgets)
        dashboard_block = f"""
resource "aws_cloudwatch_dashboard" "this" {{
  dashboard_name = "{name}-dashboard"
  dashboard_body = <<-EOF
{{
  "widgets": [
      {widgets_json}
  ]
}}
EOF
}}
"""

    print(f"""
📋 Design Summary:
   Name       : {name}
   Alarms     : {alarm_summary}
   Dashboard  : {'yes' if create_dashboard == 'yes' and dashboard_widgets else 'no'}
   SNS        : {'new topic' if sns_choice == 'new' else 'existing'}
   Region     : {region}
""")
    confirm = prompt("Proceed?", default="yes", choices=["yes", "no"])
    if confirm != "yes":
        print("Aborted.")
        sys.exit(0)

    main_tf = f"""terraform {{
  required_providers {{
    aws = {{ source = "hashicorp/aws", version = "~> 5.0" }}
  }}
  cloud {{
    organization = "{org}"
    workspaces {{ name = "{workspace}" }}
  }}
}}

provider "aws" {{ region = "{region}" }}

locals {{
  tags = {{
    ManagedBy   = "terraform"
    CreatedBy   = "openclaw"
    Environment = "{env}"
  }}
}}
{sns_block}
{alarm_blocks}
{dashboard_block}
"""
    (outdir / "main.tf").write_text(main_tf)
    print(f"\n✅ Generated {outdir}/main.tf for CloudWatch '{name}'")
    print(f"   Alarms    : {alarm_summary}")
    if create_dashboard == "yes" and dashboard_widgets:
        print(f"   Dashboard : {name}-dashboard")


def prompt_cloudtrail(org, workspace, outdir):
    """Interactively gather CloudTrail config."""

    print("""
🛡️  AWS CloudTrail Wizard
────────────────────────────────────────────────────────
CloudTrail records all API calls in your AWS account.
Logs are stored in an S3 bucket with encryption.

Best practice:
  - Enable multi-region for full coverage
  - Enable log file validation to detect tampering
  - Send to CloudWatch Logs for real-time alerting
  - Encrypt with KMS for compliance
────────────────────────────────────────────────────────""")

    name   = prompt("Trail name (e.g. marsmovers-audit-trail)")
    normalized_name = name.strip().lower().replace(" ", "-").replace("_", "-")
    if not normalized_name:
        print("  ❌ Trail name cannot be empty")
        sys.exit(1)
    name_errors = validate_landing_zone_name(normalized_name)
    if name_errors:
        print("  ❌ Trail name must be a valid landing-zone style name: lowercase letters, numbers, and hyphens only, 3-63 chars.")
        sys.exit(1)
    name = normalized_name
    region = prompt("AWS region", default="us-east-1")
    env    = prompt("Environment", default="prod", choices=["dev", "staging", "prod"])

    # Scope
    multi_region = prompt("Enable multi-region trail? (recommended for production)", default="yes", choices=["yes", "no"])
    multi_region = multi_region == "yes"

    # Event types
    print("\n  Which events to log?")
    print("    1) Management events only (API calls — default, free tier)")
    print("    2) Management + S3 data events (object-level access — costs extra)")
    print("    3) Management + Lambda data events (invocation logs — costs extra)")
    print("    4) Management + S3 + Lambda data events")
    event_type = prompt("Event scope", default="1", choices=["1", "2", "3", "4"])

    # S3 bucket for logs
    print("\n  CloudTrail needs an S3 bucket for log storage.")
    bucket_choice = prompt("Create a new bucket or use existing?", default="new", choices=["new", "existing"])
    if bucket_choice == "existing":
        bucket_name = prompt("Existing S3 bucket name")
        bucket_errors = validate_s3_bucket_name(bucket_name)
        if bucket_errors:
            print(f"  ❌ Invalid S3 bucket name: {bucket_name}")
            for e in bucket_errors:
                print(f"   - {e}")
            sys.exit(1)
        bucket_block = ""
        bucket_policy_block = ""
        bucket_ref = f'"{bucket_name}"'
    else:
        bucket_name = f"{name}-logs-{region}".lower().replace("_", "-")
        bucket_errors = validate_s3_bucket_name(bucket_name)
        if bucket_errors:
            print(f"  ⚠️  Auto-generated bucket name '{bucket_name}' is invalid, enter manually:")
            bucket_name = prompt("S3 bucket name for trail logs")
            bucket_errors = validate_s3_bucket_name(bucket_name)
            if bucket_errors:
                print(f"  ❌ Invalid S3 bucket name: {bucket_name}")
                for e in bucket_errors:
                    print(f"   - {e}")
                sys.exit(1)
        else:
            print(f"  ℹ️  Will create bucket: {bucket_name}")
        bucket_ref = "aws_s3_bucket.trail_logs.id"
        bucket_block = f"""
resource "aws_s3_bucket" "trail_logs" {{
  bucket        = "{bucket_name}"
  force_destroy = false
  tags          = local.tags
}}

resource "aws_s3_bucket_versioning" "trail_logs" {{
  bucket = aws_s3_bucket.trail_logs.id
  versioning_configuration {{ status = "Enabled" }}
}}

resource "aws_s3_bucket_server_side_encryption_configuration" "trail_logs" {{
  bucket = aws_s3_bucket.trail_logs.id
  rule {{
    apply_server_side_encryption_by_default {{ sse_algorithm = "AES256" }}
  }}
}}

resource "aws_s3_bucket_public_access_block" "trail_logs" {{
  bucket                  = aws_s3_bucket.trail_logs.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}}

resource "aws_s3_bucket_lifecycle_configuration" "trail_logs" {{
  bucket = aws_s3_bucket.trail_logs.id
  rule {{
    id     = "archive-old-logs"
    status = "Enabled"
    transition {{
      days          = 90
      storage_class = "GLACIER"
    }}
    expiration {{
      days = 365
    }}
  }}
}}
"""
        bucket_policy_block = f"""
data "aws_caller_identity" "current" {{}}

resource "aws_s3_bucket_policy" "trail_logs" {{
  bucket = aws_s3_bucket.trail_logs.id
  policy = jsonencode({{
    Version = "2012-10-17"
    Statement = [
      {{
        Sid       = "AWSCloudTrailAclCheck"
        Effect    = "Allow"
        Principal = {{ Service = "cloudtrail.amazonaws.com" }}
        Action    = "s3:GetBucketAcl"
        Resource  = aws_s3_bucket.trail_logs.arn
      }},
      {{
        Sid       = "AWSCloudTrailWrite"
        Effect    = "Allow"
        Principal = {{ Service = "cloudtrail.amazonaws.com" }}
        Action    = "s3:PutObject"
        Resource  = "${{aws_s3_bucket.trail_logs.arn}}/AWSLogs/${{data.aws_caller_identity.current.account_id}}/*"
        Condition = {{ StringEquals = {{ "s3:x-amz-acl" = "bucket-owner-full-control" }} }}
      }}
    ]
  }})
}}
"""

    # CloudWatch Logs integration
    cw_logs = prompt("Send logs to CloudWatch Logs for real-time alerting?", default="yes", choices=["yes", "no"])
    cw_logs = cw_logs == "yes"

    cw_block = ""
    cw_role_block = ""
    cw_ref = ""
    cw_role_ref = ""
    if cw_logs:
        retention = prompt("CloudWatch log retention (days)", default="90", choices=["30", "60", "90", "180", "365"])
        cw_block = f"""
resource "aws_cloudwatch_log_group" "trail" {{
  name              = "/aws/cloudtrail/{name}"
  retention_in_days = {retention}
  tags              = local.tags
}}
"""
        cw_role_block = f"""
resource "aws_iam_role" "cloudtrail_cw" {{
  name = "{name}-cloudwatch-role"
  assume_role_policy = jsonencode({{
    Version = "2012-10-17"
    Statement = [{{
      Effect    = "Allow"
      Principal = {{ Service = "cloudtrail.amazonaws.com" }}
      Action    = "sts:AssumeRole"
    }}]
  }})
  tags = local.tags
}}

resource "aws_iam_role_policy" "cloudtrail_cw" {{
  name = "{name}-cloudwatch-policy"
  role = aws_iam_role.cloudtrail_cw.id
  policy = jsonencode({{
    Version = "2012-10-17"
    Statement = [{{
      Effect   = "Allow"
      Action   = ["logs:CreateLogStream", "logs:PutLogEvents"]
      Resource = "${{aws_cloudwatch_log_group.trail.arn}}:*"
    }}]
  }})
}}
"""
        cw_ref = f"  cloud_watch_logs_group_arn  = \"${{aws_cloudwatch_log_group.trail.arn}}:*\""
        cw_role_ref = f"  cloud_watch_logs_role_arn   = aws_iam_role.cloudtrail_cw.arn"

    # Log file validation
    log_validation = prompt("Enable log file validation? (detects tampering)", default="yes", choices=["yes", "no"])
    log_validation = log_validation == "yes"

    # Data event selectors
    event_selector_block = ""
    if event_type in ("2", "4"):
        event_selector_block += """
  event_selector {
    read_write_type           = "All"
    include_management_events = true
    data_resource {
      type   = "AWS::S3::Object"
      values = ["arn:aws:s3"]
    }
  }
"""
    if event_type in ("3", "4"):
        event_selector_block += """
  event_selector {
    read_write_type           = "All"
    include_management_events = true
    data_resource {
      type   = "AWS::Lambda::Function"
      values = ["arn:aws:lambda"]
    }
  }
"""

    event_labels = {"1": "Management only", "2": "Management + S3 data", "3": "Management + Lambda data", "4": "Management + S3 + Lambda data"}
    print(f"""
📋 Design Summary:
   Trail name     : {name}
   Multi-region   : {'yes' if multi_region else 'no'}
   Events         : {event_labels[event_type]}
   Log bucket     : {bucket_name}
   CloudWatch     : {'yes, ' + retention + ' day retention' if cw_logs else 'no'}
   Log validation : {'yes' if log_validation else 'no'}
   Lifecycle      : 90d → Glacier, 365d → expire
   Environment    : {env}
""")
    confirm = prompt("Proceed?", default="yes", choices=["yes", "no"])
    if confirm != "yes":
        print("Aborted.")
        sys.exit(0)

    depends = ""
    if bucket_choice == "new":
        depends = "  depends_on = [aws_s3_bucket_policy.trail_logs]"

    main_tf = f"""terraform {{
  required_providers {{
    aws = {{ source = "hashicorp/aws", version = "~> 5.0" }}
  }}
  cloud {{
    organization = "{org}"
    workspaces {{ name = "{workspace}" }}
  }}
}}

provider "aws" {{ region = "{region}" }}

locals {{
  tags = {{
    ManagedBy   = "terraform"
    CreatedBy   = "openclaw"
    Environment = "{env}"
  }}
}}
{bucket_block}
{bucket_policy_block}
{cw_block}
{cw_role_block}
resource "aws_cloudtrail" "this" {{
  name                          = "{name}"
  s3_bucket_name                = {bucket_ref}
  is_multi_region_trail         = {str(multi_region).lower()}
  include_global_service_events = true
  enable_log_file_validation    = {str(log_validation).lower()}
{cw_ref}
{cw_role_ref}
{event_selector_block}
{depends}
  tags = local.tags
}}

output "trail_arn"    {{ value = aws_cloudtrail.this.arn }}
output "trail_bucket" {{ value = {bucket_ref} }}
"""
    (outdir / "main.tf").write_text(main_tf)
    print(f"\n✅ Generated {outdir}/main.tf for CloudTrail '{name}'")
    print(f"   Multi-region    : {'yes' if multi_region else 'no'}")
    print(f"   Log validation  : {'enabled' if log_validation else 'disabled'}")
    print(f"   CloudWatch Logs : {'enabled' if cw_logs else 'disabled'}")


def prompt_budget(org, workspace, outdir):
    """Interactively gather AWS Budget + Forecast alert config."""
    import re

    print("""
💰 AWS Budget & Forecast Alert Wizard
────────────────────────────────────────────────────────
Creates a monthly cost budget with actual spend alerts
and forecasted overspend alerts. Notifications via email
or SNS topic.

Best practice: set budget at 80% of your expected spend,
alert at 50%, 80%, and 100% thresholds.
────────────────────────────────────────────────────────""")

    name = prompt("Budget name (e.g. marsmovers-monthly)", default="monthly-cost-budget")
    region = prompt("AWS region", default="us-east-1")

    # Budget amount
    print("\n  What is your expected monthly AWS spend?")
    print("    Common ranges:")
    print("      Dev/test   : $50 - $200")
    print("      Staging    : $200 - $500")
    print("      Production : $500 - $5000+")
    budget_str = prompt_num("Monthly budget limit (USD)", default=100, min_val=1)
    budget = float(budget_str)

    # Alert thresholds
    print(f"\n  Alert thresholds (% of ${budget:.0f} budget):")
    print("    Recommended: 50%, 80%, 100%")
    print("    Enter comma-separated values.")
    thresholds_str = prompt("Alert thresholds (%)", default="50,80,100")
    thresholds = []
    for t in thresholds_str.split(","):
        t = t.strip()
        try:
            val = int(t)
            if not (1 <= val <= 200):
                print(f"  ❌ Threshold must be 1-200%, got {val}")
                sys.exit(1)
            thresholds.append(val)
        except ValueError:
            print(f"  ❌ Invalid threshold: '{t}'")
            sys.exit(1)
    thresholds.sort()

    # Forecast alert
    forecast = prompt("Add forecasted overspend alert? (recommended)", default="yes", choices=["yes", "no"])
    forecast = forecast == "yes"
    forecast_threshold = 100
    if forecast:
        forecast_threshold = int(prompt_num("Forecast alert threshold (%)", default=100, min_val=1, max_val=200))

    # Notification
    print("\n  Notification method:")
    print("    1) Email (simple, no extra infra)")
    print("    2) SNS topic (for Slack/PagerDuty/Lambda integration)")
    notify_type = prompt("Notification type", default="1", choices=["1", "2"])

    if notify_type == "1":
        email = prompt("Alert email address")
        sns_block = ""
        subscriber_block = f"""      subscriber {{
        subscription_type = "EMAIL"
        address           = "{email}"
      }}"""
    else:
        sns_arn = prompt("SNS topic ARN (e.g. arn:aws:sns:us-east-1:123456789:alerts)")
        sns_block = ""
        subscriber_block = f"""      subscriber {{
        subscription_type = "SNS"
        address           = "{sns_arn}"
      }}"""

    # Summary
    alert_desc = ", ".join([f"{t}%" for t in thresholds])
    print(f"""
📋 Design Summary:
   Budget name : {name}
   Limit       : ${budget:.2f}/month
   Alerts at   : {alert_desc} of actual spend
   Forecast    : {'yes, alert at ' + str(forecast_threshold) + '%' if forecast else 'no'}
   Notify via  : {'email' if notify_type == '1' else 'SNS'}
""")
    confirm = prompt("Proceed?", default="yes", choices=["yes", "no"])
    if confirm != "yes":
        print("Aborted.")
        sys.exit(0)

    # Build notification blocks
    notif_blocks = ""
    for t in thresholds:
        notif_blocks += f"""
    notification {{
      comparison_operator        = "GREATER_THAN"
      threshold                  = {t}
      threshold_type             = "PERCENTAGE"
      notification_type          = "ACTUAL"
{subscriber_block}
    }}
"""

    if forecast:
        notif_blocks += f"""
    notification {{
      comparison_operator        = "GREATER_THAN"
      threshold                  = {forecast_threshold}
      threshold_type             = "PERCENTAGE"
      notification_type          = "FORECASTED"
{subscriber_block}
    }}
"""

    main_tf = f"""terraform {{
  required_providers {{
    aws = {{ source = "hashicorp/aws", version = "~> 5.0" }}
  }}
  cloud {{
    organization = "{org}"
    workspaces {{ name = "{workspace}" }}
  }}
}}

provider "aws" {{ region = "{region}" }}

resource "aws_budgets_budget" "this" {{
  name         = "{name}"
  budget_type  = "COST"
  limit_amount = "{budget:.2f}"
  limit_unit   = "USD"
  time_unit    = "MONTHLY"
{notif_blocks}
  tags = {{
    ManagedBy = "terraform"
    CreatedBy = "openclaw"
  }}
}}

output "budget_name" {{ value = aws_budgets_budget.this.name }}
output "budget_limit" {{ value = "${budget:.2f} USD/month" }}
"""
    (outdir / "main.tf").write_text(main_tf)
    print(f"\n✅ Generated {outdir}/main.tf for budget '{name}'")
    print(f"   Limit  : ${budget:.2f}/month")
    print(f"   Alerts : {alert_desc} actual" + (f", {forecast_threshold}% forecast" if forecast else ""))


def prompt_ec2(org, workspace, outdir):
    """Interactively gather EC2 config with instance type guidance and limits."""

    # Allowed instance types: max 4 vCPU, 16GB RAM
    ALLOWED_INSTANCES = {
        # General Purpose
        "t3.micro":   {"vcpu": 2,  "ram": 1,   "desc": "General purpose, burstable — dev/test"},
        "t3.small":   {"vcpu": 2,  "ram": 2,   "desc": "General purpose, burstable — dev/test"},
        "t3.medium":  {"vcpu": 2,  "ram": 4,   "desc": "General purpose, burstable — light workloads"},
        "t3.large":   {"vcpu": 2,  "ram": 8,   "desc": "General purpose, burstable — moderate workloads"},
        "t3.xlarge":  {"vcpu": 4,  "ram": 16,  "desc": "General purpose, burstable — max allowed"},
        "m5.large":   {"vcpu": 2,  "ram": 8,   "desc": "General purpose, balanced — production"},
        "m5.xlarge":  {"vcpu": 4,  "ram": 16,  "desc": "General purpose, balanced — production, max allowed"},
        "m6i.large":  {"vcpu": 2,  "ram": 8,   "desc": "General purpose, latest gen — production"},
        "m6i.xlarge": {"vcpu": 4,  "ram": 16,  "desc": "General purpose, latest gen — production, max allowed"},
        # Compute Optimized
        "c5.large":   {"vcpu": 2,  "ram": 4,   "desc": "Compute optimized — CPU-intensive apps"},
        "c5.xlarge":  {"vcpu": 4,  "ram": 8,   "desc": "Compute optimized — CPU-intensive apps"},
        "c6i.large":  {"vcpu": 2,  "ram": 4,   "desc": "Compute optimized, latest gen"},
        "c6i.xlarge": {"vcpu": 4,  "ram": 8,   "desc": "Compute optimized, latest gen"},
        # Memory Optimized
        "r5.large":   {"vcpu": 2,  "ram": 16,  "desc": "Memory optimized — databases, caches"},
        "r6i.large":  {"vcpu": 2,  "ram": 16,  "desc": "Memory optimized, latest gen"},
    }

    print("""
🖥️  EC2 Instance Wizard
────────────────────────────────────────────────────────
⚠️  RESTRICTION: Max 4 vCPU and 16 GB RAM per instance.
   Larger instance types are not permitted in this workspace.
   For higher capacity, consider EKS (horizontal scaling)
   or RDS (managed databases) instead.
────────────────────────────────────────────────────────""")

    # Show instance type table
    print("  Available instance types:")
    print(f"  {'Type':<14} {'vCPU':>5} {'RAM (GB)':>9}  Description")
    print(f"  {'-'*14} {'-'*5} {'-'*9}  {'-'*40}")
    for itype, spec in ALLOWED_INSTANCES.items():
        print(f"  {itype:<14} {spec['vcpu']:>5} {spec['ram']:>9}  {spec['desc']}")
    print()

    name   = prompt("Instance name (e.g. marsmovers-app-server)")
    region = prompt("AWS region", default="us-east-1")
    env    = prompt("Environment", default="dev", choices=["dev", "staging", "prod"])

    # Workload type to suggest instance
    print("\n  What is the primary workload?")
    print("    1) Web/API server          → t3.medium or m5.large")
    print("    2) Background worker       → t3.large or c5.large")
    print("    3) CPU-intensive (ML/build) → c5.xlarge or c6i.xlarge")
    print("    4) In-memory cache/DB      → r5.large or r6i.large")
    print("    5) Dev/test (cheapest)     → t3.micro or t3.small")
    workload = prompt("Workload type", default="1", choices=["1","2","3","4","5"])
    suggestions = {
        "1": "m5.large", "2": "t3.large",
        "3": "c5.xlarge", "4": "r5.large", "5": "t3.micro"
    }
    suggested = suggestions[workload]
    instance_type = prompt(f"Instance type (suggested: {suggested})", default=suggested)
    if instance_type not in ALLOWED_INSTANCES:
        print(f"\n  ❌ '{instance_type}' is not in the allowed list or exceeds 4 vCPU / 16 GB RAM.")
        print(f"  ℹ️  Closest allowed: {suggested}")
        sys.exit(1)

    # VPC/Subnet — offer to use existing TFC state outputs or enter manually
    print("\n  VPC & Subnet configuration:")
    print("    If you deployed a VPC with this skill, enter its TFC workspace name")
    print("    to auto-discover VPC/subnet IDs from state outputs.")
    print("    Otherwise enter IDs manually (e.g. vpc-0abc1234, subnet-0abc1234).")
    vpc_source = prompt("Use existing TFC workspace outputs for VPC?", default="no", choices=["yes", "no"])

    vpc_id_ref    = ""
    subnet_id_ref = ""
    data_blocks   = ""

    if vpc_source == "yes":
        vpc_ws = prompt("TFC workspace name that contains VPC outputs", default="prod-aws")
        print(f"  ℹ️  Will reference outputs from workspace '{vpc_ws}' via terraform_remote_state")
        data_blocks = f"""
data "terraform_remote_state" "vpc" {{
  backend = "remote"
  config = {{
    organization = "{org}"
    workspaces = {{ name = "{vpc_ws}" }}
  }}
}}
"""
        vpc_id_ref    = "data.terraform_remote_state.vpc.outputs.vpc_id"
        subnet_id_ref = "data.terraform_remote_state.vpc.outputs.private_subnets[0]"
        subnet_display = f"private_subnets[0] from {vpc_ws}"
    else:
        vpc_id    = prompt("VPC ID", default="vpc-xxxxxxxxxxxxxxxxx")
        subnet_id = prompt("Subnet ID (use private subnet for production)", default="subnet-xxxxxxxxxxxxxxxxx")
        vpc_id_ref    = f'"{vpc_id}"'
        subnet_id_ref = f'"{subnet_id}"'
        subnet_display = subnet_id

    # AMI — latest Amazon Linux 2023
    ami_source = prompt("AMI", default="latest-al2023", choices=["latest-al2023", "latest-ubuntu22", "custom"])
    if ami_source == "custom":
        ami_id = prompt("Custom AMI ID (e.g. ami-0abc1234)")
        ami_block = f'  ami = "{ami_id}"'
        ami_data  = ""
    elif ami_source == "latest-ubuntu22":
        ami_data  = """
data "aws_ami" "this" {
  most_recent = true
  owners      = ["099720109477"] # Canonical
  filter {
    name   = "name"
    values = ["ubuntu/images/hvm-ssd/ubuntu-jammy-22.04-amd64-server-*"]
  }
}
"""
        ami_block = "  ami = data.aws_ami.this.id"
    else:  # latest-al2023
        ami_data  = """
data "aws_ami" "this" {
  most_recent = true
  owners      = ["amazon"]
  filter {
    name   = "name"
    values = ["al2023-ami-*-x86_64"]
  }
}
"""
        ami_block = "  ami = data.aws_ami.this.id"

    # SSH key
    key_name = prompt("EC2 Key Pair name for SSH access (leave blank to skip)", default="")
    key_block = f'  key_name = "{key_name}"' if key_name else "  # key_name = \"your-key-pair\"  # uncomment to enable SSH"
    ssh_ingress_block = ""
    if key_name:
        print("\n  SSH access:")
        print("    ⚠️  Never use 0.0.0.0/0 for SSH in production.")
        ssh_cidr = prompt("Source CIDR for SSH (e.g. 203.0.113.10/32, or 10.0.0.0/8 for VPN)", default="10.0.0.0/8")
        ssh_ingress_block = f"""
  ingress {{
    from_port   = 22
    to_port     = 22
    protocol    = "tcp"
    cidr_blocks = ["{ssh_cidr}"]
    description = "SSH access"
  }}
"""

    # Root volume
    vol_size = prompt_num("Root volume size (GB)", default=20, min_val=8, max_val=16384)

    spec = ALLOWED_INSTANCES[instance_type]
    print(f"""
📋 Design Summary:
   Name          : {name}
   Instance type : {instance_type} ({spec['vcpu']} vCPU, {spec['ram']} GB RAM)
   AMI           : {ami_source}
   Subnet        : {subnet_display}
   Volume        : {vol_size} GB gp3
   Environment   : {env}
   Region        : {region}
""")
    confirm = prompt("Proceed with this design?", default="yes", choices=["yes", "no"])
    if confirm != "yes":
        print("Aborted.")
        sys.exit(0)

    main_tf = f"""terraform {{
  required_providers {{
    aws = {{ source = "hashicorp/aws", version = "~> 5.0" }}
  }}
  cloud {{
    organization = "{org}"
    workspaces {{ name = "{workspace}" }}
  }}
}}

provider "aws" {{ region = "{region}" }}
{data_blocks}
{ami_data}
locals {{
  tags = {{
    ManagedBy   = "terraform"
    CreatedBy   = "openclaw"
    Environment = "{env}"
    Name        = "{name}"
  }}
}}

resource "aws_security_group" "this" {{
  name        = "{name}-sg"
  description = "Security group for {name}"
  vpc_id      = {vpc_id_ref}
{ssh_ingress_block}
  egress {{
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
    description = "Allow all outbound"
  }}

  tags = merge(local.tags, {{ Name = "{name}-sg" }})
}}

resource "aws_instance" "this" {{
{ami_block}
  instance_type = "{instance_type}"
  subnet_id     = {subnet_id_ref}
{key_block}

  vpc_security_group_ids = [aws_security_group.this.id]

  root_block_device {{
    volume_type           = "gp3"
    volume_size           = {vol_size}
    encrypted             = true
    delete_on_termination = true
  }}

  metadata_options {{
    http_tokens = "required"  # IMDSv2 enforced
  }}

  tags = merge(local.tags, {{ Name = "{name}" }})
}}

output "instance_id"         {{ value = aws_instance.this.id }}
output "private_ip"          {{ value = aws_instance.this.private_ip }}
output "availability_zone"   {{ value = aws_instance.this.availability_zone }}
"""
    (outdir / "main.tf").write_text(main_tf)
    print(f"\n✅ Generated {outdir}/main.tf for EC2 instance '{name}'")
    print(f"   Instance type : {instance_type} ({spec['vcpu']} vCPU, {spec['ram']} GB RAM)")
    print(f"   IMDSv2        : enforced (security best practice)")
    print(f"   Root volume   : encrypted gp3")


def prompt_vpc(org, workspace, outdir):
    """Interactively gather VPC config with design principle guidance."""
    import re

    print("""
🏗️  VPC Design Wizard
────────────────────────────────────────────────────────
Best practice: 2-3 AZs, public + private subnets, NAT GW
for private egress, IGW for public ingress.
────────────────────────────────────────────────────────""")

    name    = prompt("VPC name (e.g. marsmovers-vpc)")
    region  = prompt("AWS region", default="us-east-1")
    cidr    = prompt("VPC CIDR block", default="10.0.0.0/16")
    az_count = prompt("Number of Availability Zones", default="2", choices=["2", "3"])
    az_count = int(az_count)

    nat     = prompt("Add NAT Gateway for private subnet egress? (recommended)", default="yes", choices=["yes", "no"])
    nat     = nat == "yes"

    env     = prompt("Environment tag", default="dev", choices=["dev", "staging", "prod"])

    # Auto-generate subnets based on CIDR and AZ count
    base = cidr.split("/")[0].rsplit(".", 2)[0]  # e.g. "10.0"
    pub_subnets  = [f"{base}.{i}.0/24" for i in range(az_count)]
    priv_subnets = [f"{base}.{i+10}.0/24" for i in range(az_count)]

    print(f"""
📋 Design Summary:
   VPC CIDR   : {cidr}
   Region     : {region}
   AZs        : {az_count}
   Public     : {', '.join(pub_subnets)}
   Private    : {', '.join(priv_subnets)}
   NAT GW     : {'yes (one per AZ recommended for HA, using 1 to save cost)' if nat else 'no'}
   Environment: {env}
""")
    confirm = prompt("Proceed with this design?", default="yes", choices=["yes", "no"])
    if confirm != "yes":
        print("Aborted.")
        sys.exit(0)

    # Build AZ data sources
    az_refs = " ".join([f'data.aws_availability_zones.available.names[{i}]' for i in range(az_count)])

    pub_subnet_blocks = ""
    for i, s in enumerate(pub_subnets):
        pub_subnet_blocks += f"""
resource "aws_subnet" "public_{i}" {{
  vpc_id                  = aws_vpc.this.id
  cidr_block              = "{s}"
  availability_zone       = data.aws_availability_zones.available.names[{i}]
  map_public_ip_on_launch = true
  tags = merge(local.tags, {{ Name = "{name}-public-{i}", Tier = "public" }})
}}

resource "aws_route_table_association" "public_{i}" {{
  subnet_id      = aws_subnet.public_{i}.id
  route_table_id = aws_route_table.public.id
}}
"""

    priv_subnet_blocks = ""
    for i, s in enumerate(priv_subnets):
        priv_subnet_blocks += f"""
resource "aws_subnet" "private_{i}" {{
  vpc_id            = aws_vpc.this.id
  cidr_block        = "{s}"
  availability_zone = data.aws_availability_zones.available.names[{i}]
  tags = merge(local.tags, {{ Name = "{name}-private-{i}", Tier = "private" }})
}}
"""

    nat_blocks = ""
    nat_route_blocks = ""
    if nat:
        nat_blocks = f"""
resource "aws_eip" "nat" {{
  domain = "vpc"
  tags   = merge(local.tags, {{ Name = "{name}-nat-eip" }})
}}

resource "aws_nat_gateway" "this" {{
  allocation_id = aws_eip.nat.id
  subnet_id     = aws_subnet.public_0.id
  tags          = merge(local.tags, {{ Name = "{name}-natgw" }})
  depends_on    = [aws_internet_gateway.this]
}}
"""
        for i in range(az_count):
            nat_route_blocks += f"""
resource "aws_route_table" "private_{i}" {{
  vpc_id = aws_vpc.this.id
  route {{
    cidr_block     = "0.0.0.0/0"
    nat_gateway_id = aws_nat_gateway.this.id
  }}
  tags = merge(local.tags, {{ Name = "{name}-private-rt-{i}" }})
}}

resource "aws_route_table_association" "private_{i}" {{
  subnet_id      = aws_subnet.private_{i}.id
  route_table_id = aws_route_table.private_{i}.id
}}
"""

    pub_subnet_ids  = ", ".join([f"aws_subnet.public_{i}.id"  for i in range(az_count)])
    priv_subnet_ids = ", ".join([f"aws_subnet.private_{i}.id" for i in range(az_count)])

    main_tf = f"""terraform {{
  required_providers {{
    aws = {{ source = "hashicorp/aws", version = "~> 5.0" }}
  }}
  cloud {{
    organization = "{org}"
    workspaces {{ name = "{workspace}" }}
  }}
}}

provider "aws" {{ region = "{region}" }}

data "aws_availability_zones" "available" {{ state = "available" }}

locals {{
  tags = {{
    ManagedBy   = "terraform"
    CreatedBy   = "openclaw"
    Environment = "{env}"
    Name        = "{name}"
  }}
}}

resource "aws_vpc" "this" {{
  cidr_block           = "{cidr}"
  enable_dns_hostnames = true
  enable_dns_support   = true
  tags                 = merge(local.tags, {{ Name = "{name}" }})
}}

resource "aws_internet_gateway" "this" {{
  vpc_id = aws_vpc.this.id
  tags   = merge(local.tags, {{ Name = "{name}-igw" }})
}}

resource "aws_route_table" "public" {{
  vpc_id = aws_vpc.this.id
  route {{
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.this.id
  }}
  tags = merge(local.tags, {{ Name = "{name}-public-rt" }})
}}
{pub_subnet_blocks}
{priv_subnet_blocks}
{nat_blocks}
{nat_route_blocks}
output "vpc_id"          {{ value = aws_vpc.this.id }}
output "public_subnets"  {{ value = [{pub_subnet_ids}] }}
output "private_subnets" {{ value = [{priv_subnet_ids}] }}
"""
    (outdir / "main.tf").write_text(main_tf)
    print(f"✅ Generated {outdir}/main.tf for VPC '{name}'")


def validate_iam_role_name(name):
    """Validate IAM role name rules before generating .tf files."""
    import re
    errors = []
    if not (1 <= len(name) <= 64):
        errors.append(f"Name must be 1-64 characters (got {len(name)})")
    if not re.match(r'^[\w+=,.@-]+$', name):
        errors.append("Name can only contain letters, numbers, and these characters: _+=,.@-")
    return errors


def validate_s3_bucket_name(name):
    """Validate S3 bucket name rules before generating .tf files."""
    import re
    errors = []
    if not (3 <= len(name) <= 63):
        errors.append(f"Name must be 3-63 characters (got {len(name)})")
    if name != name.lower():
        errors.append(f"Name must be lowercase (use '{name.lower()}')")
    if not re.match(r'^[a-z0-9][a-z0-9\-\.]*[a-z0-9]$', name):
        errors.append("Name must start/end with letter or number, only lowercase letters, numbers, hyphens, dots allowed")
    if '..' in name:
        errors.append("Name cannot contain consecutive dots")
    if re.match(r'^\d+\.\d+\.\d+\.\d+$', name):
        errors.append("Name cannot be formatted as an IP address")
    if name.startswith('xn--'):
        errors.append("Name cannot start with 'xn--'")
    if name.startswith('sthree-'):
        errors.append("Name cannot start with 'sthree-'")
    return errors


def validate_azure_rg_name(name):
    """Validate Azure Resource Group name rules."""
    import re
    errors = []
    if not (1 <= len(name) <= 90):
        errors.append(f"Name must be 1-90 characters (got {len(name)})")
    if not re.match(r'^[a-zA-Z0-9_\-\.\(\)]+$', name):
        errors.append("Name can only contain letters, numbers, underscores, hyphens, dots, parentheses")
    if name.endswith('.'):
        errors.append("Name cannot end with a period")
    return errors


def cmd_generate(args):
    validate_dir(args.dir)
    outdir = Path(args.dir)
    outdir.mkdir(parents=True, exist_ok=True)
    org = sanitize_hcl(get_org())
    workspace = sanitize_hcl(args.workspace)

    if args.resource == "s3":
        name = args.name.lower().replace(" ", "-").replace("_", "-")
        if name != args.name:
            print(f"⚠️  Auto-corrected bucket name: '{args.name}' → '{name}'")
        errors = validate_s3_bucket_name(name)
        if errors:
            print("❌ Invalid S3 bucket name:")
            for e in errors:
                print(f"   - {e}")
            sys.exit(1)
        region = args.region or "us-east-1"
        main_tf = f"""terraform {{
  required_providers {{
    aws = {{ source = "hashicorp/aws", version = "~> 5.0" }}
  }}
  cloud {{
    organization = "{org}"
    workspaces {{ name = "{workspace}" }}
  }}
}}

provider "aws" {{ region = "{region}" }}

resource "aws_s3_bucket" "this" {{
  bucket = "{name}"
  tags   = {{ ManagedBy = "terraform", CreatedBy = "openclaw" }}
}}

resource "aws_s3_bucket_versioning" "this" {{
  bucket = aws_s3_bucket.this.id
  versioning_configuration {{ status = "Enabled" }}
}}

resource "aws_s3_bucket_server_side_encryption_configuration" "this" {{
  bucket = aws_s3_bucket.this.id
  rule {{
    apply_server_side_encryption_by_default {{ sse_algorithm = "AES256" }}
  }}
}}

resource "aws_s3_bucket_public_access_block" "this" {{
  bucket                  = aws_s3_bucket.this.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}}

output "bucket_arn" {{ value = aws_s3_bucket.this.arn }}
"""
        (outdir / "main.tf").write_text(main_tf)
        print(f"✅ Generated {outdir}/main.tf for S3 bucket '{name}'")

    elif args.resource == "rg":
        name = args.name
        errors = validate_azure_rg_name(name)
        if errors:
            print("\u274c Invalid Azure Resource Group name:")
            for e in errors:
                print(f"   - {e}")
            sys.exit(1)
        location = args.region or "eastus"
        main_tf = f"""terraform {{
  required_providers {{
    azurerm = {{ source = "hashicorp/azurerm", version = "~> 3.0" }}
  }}
  cloud {{
    organization = "{org}"
    workspaces {{ name = "{workspace}" }}
  }}
}}

provider "azurerm" {{ features {{}} }}

resource "azurerm_resource_group" "this" {{
  name     = "{name}"
  location = "{location}"
  tags     = {{ ManagedBy = "terraform", CreatedBy = "openclaw" }}
}}

output "resource_group_id" {{ value = azurerm_resource_group.this.id }}
"""
        (outdir / "main.tf").write_text(main_tf)
        print(f"✅ Generated {outdir}/main.tf for Azure Resource Group '{name}'")

    elif args.resource == "vpc":
        prompt_vpc(org, workspace, outdir)

    elif args.resource == "ec2":
        prompt_ec2(org, workspace, outdir)

    elif args.resource == "budget":
        prompt_budget(org, workspace, outdir)

    elif args.resource == "cloudtrail":
        prompt_cloudtrail(org, workspace, outdir)

    elif args.resource == "cloudwatch":
        prompt_cloudwatch(org, workspace, outdir)

    elif args.resource == "efs":
        prompt_efs(org, workspace, outdir)

    elif args.resource == "landing-zone":
        prompt_landing_zone(org, workspace, outdir)

    elif args.resource == "sg":
        prompt_sg(org, workspace, outdir)

    elif args.resource == "lambda":
        prompt_lambda(org, workspace, outdir)

    elif args.resource == "iam-user":
        prompt_iam_user(org, workspace, outdir)

    elif args.resource == "iam-role":
        name = args.name
        errors = validate_iam_role_name(name)
        if errors:
            print("❌ Invalid IAM role name:")
            for e in errors:
                print(f"   - {e}")
            sys.exit(1)
        service = args.service or "lambda.amazonaws.com"
        policy_arn = args.policy_arn or "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
        main_tf = f"""terraform {{
  required_providers {{
    aws = {{ source = "hashicorp/aws", version = "~> 5.0" }}
  }}
  cloud {{
    organization = "{org}"
    workspaces {{ name = "{workspace}" }}
  }}
}}

provider "aws" {{ region = "{args.region or 'us-east-1'}" }}

data "aws_iam_policy_document" "assume_role" {{
  statement {{
    effect  = "Allow"
    actions = ["sts:AssumeRole"]
    principals {{
      type        = "Service"
      identifiers = ["{service}"]
    }}
  }}
}}

resource "aws_iam_role" "this" {{
  name               = "{name}"
  assume_role_policy = data.aws_iam_policy_document.assume_role.json
  tags               = {{ ManagedBy = "terraform", CreatedBy = "openclaw" }}
}}

resource "aws_iam_role_policy_attachment" "this" {{
  role       = aws_iam_role.this.name
  policy_arn = "{policy_arn}"
}}

output "role_arn"  {{ value = aws_iam_role.this.arn }}
output "role_name" {{ value = aws_iam_role.this.name }}
"""
        (outdir / "main.tf").write_text(main_tf)
        print(f"✅ Generated {outdir}/main.tf for IAM role '{name}'")
        print(f"   Trust principal : {service}")
        print(f"   Attached policy : {policy_arn}")

    else:
        print(f"ERROR: Unknown resource type '{args.resource}'. Supported: s3, rg")
        sys.exit(1)


def cmd_plan(args):
    work_dir = validate_dir(args.dir)
    tf_init(work_dir)
    plan_file = str(Path(work_dir).resolve() / "tfplan")
    print("\nRunning terraform plan...")
    rc = run_tf(["plan", f"-out={plan_file}"], cwd=work_dir)
    if rc != 0:
        print("ERROR: Plan failed")
        sys.exit(1)
    print(f"\n✅ Plan complete. Plan saved to {plan_file}")
    print("Review above and approve to apply.")


def cmd_apply(args):
    work_dir = validate_dir(args.dir)
    plan_file = str(Path(work_dir).resolve() / "tfplan")
    if not Path(plan_file).exists():
        print(f"ERROR: No saved plan found at {plan_file}")
        print("Run 'plan' first before apply.")
        sys.exit(1)
    print("\nRunning terraform apply...")
    rc = run_tf(["apply", plan_file], cwd=work_dir)
    if rc != 0:
        print("ERROR: Apply failed")
        sys.exit(1)
    Path(plan_file).unlink(missing_ok=True)
    print("\n✅ Apply complete.")


def cmd_destroy(args):
    if getattr(args, "confirm", None) != "DESTROY":
        print("ERROR: Destroy requires explicit confirmation.")
        print("Pass --confirm DESTROY to proceed.")
        sys.exit(1)
    work_dir = validate_dir(args.dir)
    print(f"\n⚠️  DESTROYING all resources in {work_dir}")
    print("Running terraform destroy...")
    rc = run_tf(["destroy", "-auto-approve"], cwd=work_dir)
    if rc != 0:
        print("ERROR: Destroy failed")
        sys.exit(1)
    print("\n✅ Destroy complete.")


def cmd_state(args):
    _require_requests()
    from urllib.parse import quote
    org = get_org()
    ws_name = quote(args.workspace, safe="")
    r = requests.get(
        f"{TFC_API}/organizations/{quote(org, safe='')}/workspaces/{ws_name}",
        headers=api_headers()
    )
    r.raise_for_status()
    ws_id = r.json()["data"]["id"]

    r2 = requests.get(f"{TFC_API}/workspaces/{ws_id}/current-state-version", headers=api_headers())
    if r2.status_code == 404:
        print(f"No state found for workspace '{args.workspace}' — nothing deployed yet.")
        return
    r2.raise_for_status()
    attrs = r2.json()["data"]["attributes"]
    print(f"\n--- State: {args.workspace} ---")
    print(f"  Serial:  {attrs.get('serial', 'unknown')}")
    print(f"  Updated: {attrs.get('created-at', 'unknown')}")

    sv_id = r2.json()["data"]["id"]
    resources_processed = attrs.get("resources-processed", True)
    if not resources_processed:
        import time
        print("  Resources still being indexed by TFC, waiting...")
        for attempt in range(6):
            wait = 2 ** attempt
            time.sleep(wait)
            r_check = requests.get(f"{TFC_API}/state-versions/{sv_id}", headers=api_headers())
            if r_check.status_code == 200:
                if r_check.json()["data"]["attributes"].get("resources-processed", False):
                    break
            print(f"    still processing... ({attempt + 1}/6)")
        else:
            print("  ⚠️  Resources may be incomplete — TFC is still indexing. Re-run in a minute.")

    r3 = requests.get(f"{TFC_API}/state-versions/{sv_id}/resources", headers=api_headers())
    resources = r3.json().get("data", [])
    if not resources:
        print("  (no resources)")
    for res in resources:
        a = res["attributes"]
        print(f"  - {a.get('provider-type','?')}.{a.get('name','?')}")


def cmd_outputs(args):
    _require_requests()
    import time
    from urllib.parse import quote
    org = get_org()
    ws_name = quote(args.workspace, safe="")
    r = requests.get(
        f"{TFC_API}/organizations/{quote(org, safe='')}/workspaces/{ws_name}",
        headers=api_headers()
    )
    r.raise_for_status()
    ws_id = r.json()["data"]["id"]

    max_retries = 6
    for attempt in range(max_retries):
        r2 = requests.get(f"{TFC_API}/workspaces/{ws_id}/current-state-version-outputs", headers=api_headers())
        if r2.status_code == 503:
            wait = 2 ** attempt
            print(f"  Outputs still processing, retrying in {wait}s... ({attempt + 1}/{max_retries})")
            time.sleep(wait)
            continue
        if r2.status_code == 404:
            print(f"No outputs found for workspace '{args.workspace}' — nothing deployed yet.")
            return
        r2.raise_for_status()
        break
    else:
        print("ERROR: Outputs still unavailable after retries. TFC may still be processing the state.")
        print("Try again in a minute: openclaw tfc_client.py outputs --workspace " + args.workspace)
        sys.exit(1)

    outputs = r2.json().get("data", [])
    if not outputs:
        print("No outputs found.")
        return
    print("\n--- Outputs ---")
    for o in outputs:
        name = o["attributes"]["name"]
        value = o["attributes"]["value"]
        sensitive = o["attributes"]["sensitive"]
        print(f"  {name} = {'<sensitive>' if sensitive else json.dumps(value)}")


def cmd_list_workspaces(args):
    _require_requests()
    from urllib.parse import quote
    org = get_org()
    url = f"{TFC_API}/organizations/{quote(org, safe='')}/workspaces?page[size]=100"
    print(f"\n--- Workspaces in {org} ---")
    while url:
        r = requests.get(url, headers=api_headers())
        r.raise_for_status()
        body = r.json()
        for ws in body.get("data", []):
            a = ws["attributes"]
            print(f"  {a['name']:<40} {a.get('execution-mode','?'):<10} tf:{a.get('terraform-version','?')}")
        url = body.get("links", {}).get("next")


def main():
    parser = argparse.ArgumentParser(description="Terraform IaC client for OpenClaw")
    sub = parser.add_subparsers(dest="command", required=True)

    p_gen = sub.add_parser("generate")
    p_gen.add_argument("--resource", required=True, choices=["s3", "vpc", "ec2", "sg", "lambda", "iam-user", "budget", "cloudtrail", "cloudwatch", "efs", "landing-zone", "iam-role", "rg"])
    p_gen.add_argument("--name", required=True)
    p_gen.add_argument("--workspace", required=True)
    p_gen.add_argument("--dir", required=True)
    p_gen.add_argument("--region", default=None)
    p_gen.add_argument("--service", default=None, help="AWS service principal for IAM role trust policy (e.g. ec2.amazonaws.com)")
    p_gen.add_argument("--policy-arn", dest="policy_arn", default=None, help="AWS managed policy ARN to attach to IAM role")

    p_plan = sub.add_parser("plan")
    p_plan.add_argument("--dir", required=True)

    p_apply = sub.add_parser("apply")
    p_apply.add_argument("--dir", required=True)

    p_destroy = sub.add_parser("destroy")
    p_destroy.add_argument("--dir", required=True)
    p_destroy.add_argument("--confirm", default=None, help="Must be 'DESTROY' to confirm destructive action")

    p_state = sub.add_parser("state")
    p_state.add_argument("--workspace", required=True)

    p_outputs = sub.add_parser("outputs")
    p_outputs.add_argument("--workspace", required=True)

    sub.add_parser("list-workspaces")

    args = parser.parse_args()

    commands = {
        "generate": cmd_generate,
        "plan": cmd_plan,
        "apply": cmd_apply,
        "destroy": cmd_destroy,
        "state": cmd_state,
        "outputs": cmd_outputs,
        "list-workspaces": cmd_list_workspaces,
    }
    commands[args.command](args)


if __name__ == "__main__":
    main()
