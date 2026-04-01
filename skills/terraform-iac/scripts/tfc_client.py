#!/usr/bin/env python3
"""
Terraform Cloud API client for the terraform-iac OpenClaw skill.

Usage:
  tfc_client.py plan            --workspace NAME --dir PATH
  tfc_client.py apply           --run-id RUN_ID
  tfc_client.py destroy         --workspace NAME --dir PATH
  tfc_client.py outputs         --workspace NAME
  tfc_client.py state           --workspace NAME
  tfc_client.py create-workspace --name NAME --cloud aws|azure
  tfc_client.py list-workspaces

Required env vars:
  TFC_TOKEN   Terraform Cloud Org API token
  TFC_ORG     Terraform Cloud organization name
"""

import argparse
import json
import os
import sys
import tarfile
import tempfile
import time
from pathlib import Path

try:
    import requests
except ImportError:
    print("ERROR: 'requests' not installed. Run: pip install requests")
    sys.exit(1)

TFC_API = "https://app.terraform.io/api/v2"


def get_headers():
    token = os.environ.get("TFC_TOKEN")
    if not token:
        print("ERROR: TFC_TOKEN env var not set")
        sys.exit(1)
    return {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/vnd.api+json",
    }


def get_org():
    org = os.environ.get("TFC_ORG")
    if not org:
        print("ERROR: TFC_ORG env var not set")
        sys.exit(1)
    return org


def api_get(path):
    r = requests.get(f"{TFC_API}{path}", headers=get_headers())
    r.raise_for_status()
    return r.json()


def api_post(path, body):
    r = requests.post(f"{TFC_API}{path}", headers=get_headers(), json=body)
    r.raise_for_status()
    return r.json()


def api_patch(path, body):
    r = requests.patch(f"{TFC_API}{path}", headers=get_headers(), json=body)
    r.raise_for_status()
    return r.json()


def get_workspace_id(workspace_name):
    org = get_org()
    data = api_get(f"/organizations/{org}/workspaces/{workspace_name}")
    return data["data"]["id"]


def upload_config(workspace_id, config_dir):
    """Create a config version and upload the .tf files as a tar.gz."""
    # Create config version
    cv = api_post(f"/workspaces/{workspace_id}/configuration-versions", {
        "data": {
            "type": "configuration-versions",
            "attributes": {"auto-queue-runs": False},
        }
    })
    upload_url = cv["data"]["attributes"]["upload-url"]
    cv_id = cv["data"]["id"]

    # Tar the config directory
    with tempfile.NamedTemporaryFile(suffix=".tar.gz", delete=False) as tmp:
        tmp_path = tmp.name

    with tarfile.open(tmp_path, "w:gz") as tar:
        for tf_file in Path(config_dir).glob("*.tf"):
            tar.add(tf_file, arcname=tf_file.name)

    # Upload
    with open(tmp_path, "rb") as f:
        r = requests.put(
            upload_url,
            data=f,
            headers={"Content-Type": "application/octet-stream"},
        )
        r.raise_for_status()

    os.unlink(tmp_path)
    return cv_id


def wait_for_run(run_id, target_status=("planned", "planned_and_finished", "errored", "canceled")):
    """Poll run until it reaches a terminal or target status."""
    print(f"Waiting for run {run_id}...", end="", flush=True)
    while True:
        data = api_get(f"/runs/{run_id}")
        status = data["data"]["attributes"]["status"]
        print(f"\r  Status: {status:<30}", end="", flush=True)
        if status in target_status:
            print()
            return data
        time.sleep(3)


def print_plan_output(run_id):
    """Fetch and print the plan log."""
    data = api_get(f"/runs/{run_id}")
    plan_id = data["data"]["relationships"]["plan"]["data"]["id"]
    plan_data = api_get(f"/plans/{plan_id}")
    log_url = plan_data["data"]["attributes"].get("log-read-url")
    if log_url:
        r = requests.get(log_url)
        print("\n--- Plan Output ---")
        print(r.text)
        print("-------------------")
    changes = plan_data["data"]["attributes"].get("resource-changes", {})
    print(f"\nSummary: +{changes.get('add',0)} add, ~{changes.get('change',0)} change, -{changes.get('remove',0)} destroy")


def cmd_plan(args):
    ws_id = get_workspace_id(args.workspace)
    print(f"Uploading config from {args.dir}...")
    upload_config(ws_id, args.dir)

    # Queue a plan-only run
    run = api_post("/runs", {
        "data": {
            "type": "runs",
            "attributes": {"plan-only": True, "message": "OpenClaw plan"},
            "relationships": {
                "workspace": {"data": {"type": "workspaces", "id": ws_id}}
            },
        }
    })
    run_id = run["data"]["id"]
    print(f"Run ID: {run_id}")

    result = wait_for_run(run_id)
    status = result["data"]["attributes"]["status"]

    if status == "errored":
        print("ERROR: Plan failed.")
        print_plan_output(run_id)
        sys.exit(1)

    print_plan_output(run_id)
    print(f"\nRun ID for apply: {run_id}")


def cmd_apply(args):
    # Queue a new apply run (plan-only=False) using the same workspace
    # If run_id provided, confirm it; otherwise create a new run
    run_id = args.run_id

    # Confirm the run
    api_post(f"/runs/{run_id}/actions/apply", {"comment": "Approved via OpenClaw"})
    print(f"Apply triggered for run {run_id}")

    result = wait_for_run(run_id, target_status=("applied", "errored", "canceled"))
    status = result["data"]["attributes"]["status"]

    if status == "applied":
        print("✅ Apply complete.")
    else:
        print(f"❌ Apply ended with status: {status}")
        sys.exit(1)


def cmd_destroy(args):
    ws_id = get_workspace_id(args.workspace)
    print(f"Uploading config from {args.dir}...")
    upload_config(ws_id, args.dir)

    run = api_post("/runs", {
        "data": {
            "type": "runs",
            "attributes": {"is-destroy": True, "message": "OpenClaw destroy"},
            "relationships": {
                "workspace": {"data": {"type": "workspaces", "id": ws_id}}
            },
        }
    })
    run_id = run["data"]["id"]
    print(f"Destroy Run ID: {run_id}")

    result = wait_for_run(run_id)
    print_plan_output(run_id)
    print(f"\nRun ID to confirm destroy: {run_id}")
    print("Run: tfc_client.py apply --run-id", run_id)


def cmd_outputs(args):
    ws_id = get_workspace_id(args.workspace)
    data = api_get(f"/workspaces/{ws_id}/current-state-version-outputs")
    outputs = data.get("data", [])
    if not outputs:
        print("No outputs found.")
        return
    print("\n--- Outputs ---")
    for o in outputs:
        name = o["attributes"]["name"]
        value = o["attributes"]["value"]
        sensitive = o["attributes"]["sensitive"]
        print(f"  {name} = {'<sensitive>' if sensitive else json.dumps(value)}")


def cmd_state(args):
    ws_id = get_workspace_id(args.workspace)
    data = api_get(f"/workspaces/{ws_id}/current-state-version")
    attrs = data["data"]["attributes"]
    resources = attrs.get("resources-processed", "unknown")
    serial = attrs.get("serial", "unknown")
    created = attrs.get("created-at", "unknown")
    print(f"\n--- State: {args.workspace} ---")
    print(f"  Serial:    {serial}")
    print(f"  Resources: {resources}")
    print(f"  Updated:   {created}")

    # List resources from state
    sv_id = data["data"]["id"]
    resources_data = api_get(f"/state-versions/{sv_id}/resources")
    for r in resources_data.get("data", []):
        a = r["attributes"]
        print(f"  - {a.get('provider-type','?')}.{a.get('name','?')} ({a.get('module','')})")


def cmd_create_workspace(args):
    org = get_org()
    cloud_vars = {
        "aws": {"AWS_DEFAULT_REGION": "us-east-1"},
        "azure": {"ARM_ENVIRONMENT": "public"},
    }
    body = {
        "data": {
            "type": "workspaces",
            "attributes": {
                "name": args.name,
                "execution-mode": "remote",
                "terraform-version": "1.9.0",
                "description": f"OpenClaw managed — {args.cloud.upper()} infrastructure",
            },
        }
    }
    data = api_post(f"/organizations/{org}/workspaces", body)
    ws_id = data["data"]["id"]
    print(f"✅ Workspace '{args.name}' created (id: {ws_id})")
    print(f"   Set provider credentials as workspace variables in TFC UI or via API.")
    if args.cloud in cloud_vars:
        print(f"   Suggested variables for {args.cloud.upper()}:")
        for k in cloud_vars[args.cloud]:
            print(f"     {k}")


def cmd_list_workspaces(args):
    org = get_org()
    data = api_get(f"/organizations/{org}/workspaces")
    workspaces = data.get("data", [])
    print(f"\n--- Workspaces in {org} ---")
    for ws in workspaces:
        a = ws["attributes"]
        print(f"  {a['name']:<40} {a.get('execution-mode','?'):<10} tf:{a.get('terraform-version','?')}")


def main():
    parser = argparse.ArgumentParser(description="Terraform Cloud client for OpenClaw")
    sub = parser.add_subparsers(dest="command", required=True)

    p_plan = sub.add_parser("plan")
    p_plan.add_argument("--workspace", required=True)
    p_plan.add_argument("--dir", required=True)

    p_apply = sub.add_parser("apply")
    p_apply.add_argument("--run-id", required=True)

    p_destroy = sub.add_parser("destroy")
    p_destroy.add_argument("--workspace", required=True)
    p_destroy.add_argument("--dir", required=True)

    p_outputs = sub.add_parser("outputs")
    p_outputs.add_argument("--workspace", required=True)

    p_state = sub.add_parser("state")
    p_state.add_argument("--workspace", required=True)

    p_cw = sub.add_parser("create-workspace")
    p_cw.add_argument("--name", required=True)
    p_cw.add_argument("--cloud", required=True, choices=["aws", "azure"])

    sub.add_parser("list-workspaces")

    args = parser.parse_args()

    commands = {
        "plan": cmd_plan,
        "apply": cmd_apply,
        "destroy": cmd_destroy,
        "outputs": cmd_outputs,
        "state": cmd_state,
        "create-workspace": cmd_create_workspace,
        "list-workspaces": cmd_list_workspaces,
    }
    commands[args.command](args)


if __name__ == "__main__":
    main()
