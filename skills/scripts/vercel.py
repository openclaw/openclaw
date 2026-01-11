#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = ["httpx", "rich"]
# ///
"""
Vercel CLI - Manage Vercel deployments and projects.

Usage:
    vercel.py projects              List all projects
    vercel.py deployments [n]       List recent deployments (default: 10)
    vercel.py status <project>      Get project status and recent deploys
    vercel.py logs <deployment_id>  Get deployment logs
    vercel.py domains               List all domains
    vercel.py env <project>         List environment variables
    vercel.py redeploy <project>    Trigger a new deployment
"""

import json
import os
import sys
from datetime import datetime

import httpx
from rich.console import Console
from rich.table import Table

console = Console()

VERCEL_TOKEN = os.environ.get("VERCEL_TOKEN")
BASE_URL = "https://api.vercel.com"


def api_get(endpoint: str, params: dict = None) -> dict:
    headers = {"Authorization": f"Bearer {VERCEL_TOKEN}"}
    resp = httpx.get(f"{BASE_URL}{endpoint}", params=params, headers=headers, timeout=30)
    resp.raise_for_status()
    return resp.json()


def api_post(endpoint: str, data: dict = None) -> dict:
    headers = {"Authorization": f"Bearer {VERCEL_TOKEN}", "Content-Type": "application/json"}
    resp = httpx.post(f"{BASE_URL}{endpoint}", json=data, headers=headers, timeout=30)
    resp.raise_for_status()
    return resp.json()


def fmt_time(ts: int) -> str:
    if not ts:
        return "?"
    return datetime.fromtimestamp(ts / 1000).strftime("%Y-%m-%d %H:%M")


def cmd_projects():
    data = api_get("/v9/projects", {"limit": 100})
    projects = data.get("projects", [])
    
    table = Table(title=f"Vercel Projects ({len(projects)})")
    table.add_column("Name")
    table.add_column("Framework")
    table.add_column("Repo")
    table.add_column("Updated")
    
    for p in sorted(projects, key=lambda x: x.get("updatedAt", 0), reverse=True):
        table.add_row(
            p.get("name", "?"),
            p.get("framework", "-"),
            p.get("link", {}).get("repo", "-"),
            fmt_time(p.get("updatedAt"))
        )
    
    console.print(table)


def cmd_deployments(limit: int = 10):
    data = api_get("/v6/deployments", {"limit": limit})
    deployments = data.get("deployments", [])
    
    table = Table(title=f"Recent Deployments ({len(deployments)})")
    table.add_column("Status")
    table.add_column("Project")
    table.add_column("URL")
    table.add_column("Created")
    
    for d in deployments:
        state = d.get("state", "?")
        icon = {"READY": "✅", "BUILDING": "🔄", "ERROR": "❌", "CANCELED": "⏹"}.get(state, "❓")
        table.add_row(
            f"{icon} {state}",
            d.get("name", "?"),
            d.get("url", "-")[:50],
            fmt_time(d.get("createdAt"))
        )
    
    console.print(table)


def cmd_status(project_name: str):
    # Find project
    data = api_get("/v9/projects", {"limit": 100})
    project = next((p for p in data.get("projects", []) if p.get("name") == project_name), None)
    
    if not project:
        console.print(f"[red]Project '{project_name}' not found[/red]")
        return
    
    console.print(f"[bold]{project.get('name')}[/bold]")
    console.print(f"  Framework: {project.get('framework', '-')}")
    console.print(f"  Repo: {project.get('link', {}).get('repo', '-')}")
    console.print(f"  Updated: {fmt_time(project.get('updatedAt'))}")
    
    # Get recent deployments for this project
    deps = api_get("/v6/deployments", {"projectId": project.get("id"), "limit": 5})
    
    console.print("\n[bold]Recent Deployments:[/bold]")
    for d in deps.get("deployments", []):
        state = d.get("state", "?")
        icon = {"READY": "✅", "BUILDING": "🔄", "ERROR": "❌"}.get(state, "❓")
        console.print(f"  {icon} {state} - {fmt_time(d.get('createdAt'))} - https://{d.get('url', '')}")


def cmd_domains():
    data = api_get("/v5/domains")
    domains = data.get("domains", [])
    
    table = Table(title=f"Domains ({len(domains)})")
    table.add_column("Domain")
    table.add_column("Verified")
    table.add_column("Created")
    
    for d in domains:
        verified = "✅" if d.get("verified") else "❌"
        table.add_row(d.get("name", "?"), verified, fmt_time(d.get("createdAt")))
    
    console.print(table)


def cmd_env(project_name: str):
    # Find project ID
    data = api_get("/v9/projects", {"limit": 100})
    project = next((p for p in data.get("projects", []) if p.get("name") == project_name), None)
    
    if not project:
        console.print(f"[red]Project '{project_name}' not found[/red]")
        return
    
    env_data = api_get(f"/v9/projects/{project.get('id')}/env")
    envs = env_data.get("envs", [])
    
    table = Table(title=f"Environment Variables for {project_name}")
    table.add_column("Key")
    table.add_column("Target")
    table.add_column("Type")
    
    for e in envs:
        targets = ", ".join(e.get("target", []))
        table.add_row(e.get("key", "?"), targets, e.get("type", "-"))
    
    console.print(table)


def cmd_logs(deployment_id: str):
    data = api_get(f"/v2/deployments/{deployment_id}/events")
    
    for event in data:
        ts = fmt_time(event.get("created"))
        text = event.get("text", "")
        console.print(f"[dim]{ts}[/dim] {text}")


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)
    
    cmd = sys.argv[1]
    
    if cmd == "projects":
        cmd_projects()
    elif cmd == "deployments":
        limit = int(sys.argv[2]) if len(sys.argv) > 2 else 10
        cmd_deployments(limit)
    elif cmd == "status" and len(sys.argv) > 2:
        cmd_status(sys.argv[2])
    elif cmd == "domains":
        cmd_domains()
    elif cmd == "env" and len(sys.argv) > 2:
        cmd_env(sys.argv[2])
    elif cmd == "logs" and len(sys.argv) > 2:
        cmd_logs(sys.argv[2])
    else:
        print(__doc__)
