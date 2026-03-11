#!/usr/bin/env python3
"""
moltassist — CLI for autonomous task execution.

Usage:
    moltassist run <checklist.md> [--model MODEL] [--tier TIER] [--auto-execute]
    moltassist plan <checklist.md> [--model MODEL] [--tier TIER]
    moltassist status <state.json>
    moltassist models
"""
import argparse
import json
import sys
import urllib.request

from .crew import PitCrew
from .runner import LocalRunner, MODELS, OLLAMA_URL


def cmd_run(args):
    """Run a checklist through the pit crew."""
    runner = LocalRunner(
        model=args.model or "",
        tier=args.tier,
        auto_execute=args.auto_execute,
    )
    print(f"MoltAssist v0.1.0")
    print(f"Model: {runner.model}")
    print(f"Auto-execute: {'ON' if args.auto_execute else 'OFF'}")
    print(f"Checklist: {args.checklist}")
    print()

    crew = PitCrew()
    try:
        report = crew.run(source=args.checklist, executor=runner.execute)
    except FileNotFoundError:
        print(f"Error: {args.checklist} not found", file=sys.stderr)
        sys.exit(1)

    print(report)

    # Save state
    out = args.output or args.checklist.replace(".md", "_state.json")
    crew.save(out)
    print(f"\nState saved: {out}")

    # Summary
    s = runner.status()
    print(f"Tasks run: {s['tasks_run']}, Commands executed: {s['total_commands']}")


def cmd_plan(args):
    """Plan tasks without executing."""
    runner = LocalRunner(
        model=args.model or "",
        tier=args.tier,
        auto_execute=False,
    )
    print(f"MoltAssist v0.1.0 — Plan Mode")
    print(f"Model: {runner.model}")
    print()

    crew = PitCrew()
    try:
        crew.load(args.checklist)
    except FileNotFoundError:
        print(f"Error: {args.checklist} not found", file=sys.stderr)
        sys.exit(1)

    crew.triage()
    assignments = crew.assign()

    print(f"Tasks: {len(crew.tasks)} total, {len(assignments)} assigned\n")

    for task, agent in assignments[:20]:
        print(f"  {task.id} [{task.priority.name:8s}] -> {agent.agent_type.value:8s} | {task.description[:55]}")
        plan = runner.plan(task)
        for line in plan.split('\n')[:5]:
            if line.strip():
                print(f"    {line.strip()}")
        print()

    if len(assignments) > 20:
        print(f"  ... +{len(assignments)-20} more tasks")


def cmd_status(args):
    """Show status from a saved state file."""
    try:
        with open(args.state) as f:
            state = json.load(f)
    except FileNotFoundError:
        print(f"Error: {args.state} not found", file=sys.stderr)
        sys.exit(1)

    board = state.get("board", {})
    print(f"Completion: {board.get('completion', '?')}")
    print(f"Total: {board.get('total', '?')}")
    print(f"Done: {board.get('done', '?')}")
    print(f"Failed: {board.get('failed', '?')}")
    print(f"Elapsed: {board.get('elapsed', '?')}s")


def cmd_models(args):
    """List available models from Ollama."""
    print("MoltAssist Model Tiers:")
    for tier, model in MODELS.items():
        print(f"  {tier:8s} -> {model}")

    print(f"\nOllama ({OLLAMA_URL}):")
    try:
        req = urllib.request.Request(f"{OLLAMA_URL}/api/tags")
        with urllib.request.urlopen(req, timeout=5) as resp:
            data = json.loads(resp.read())
            models = data.get("models", [])
            if not models:
                print("  No models installed. Run: ollama pull dolphin-llama3:8b")
            else:
                # Show uncensored/abliterated models first
                uncensored = []
                other = []
                for m in models:
                    name = m["name"]
                    size_gb = m["size"] / 1e9
                    entry = f"  {name:40s} {size_gb:6.1f} GB"
                    if any(k in name.lower() for k in ["dolphin", "uncensored", "hermes", "samantha", "wizard-vicuna"]):
                        uncensored.append(entry)
                    else:
                        other.append(entry)
                if uncensored:
                    print(f"\n  Abliterated ({len(uncensored)}):")
                    for e in uncensored:
                        print(f"  * {e}")
                if other:
                    print(f"\n  Standard ({len(other)}):")
                    for e in other:
                        print(f"    {e}")
    except Exception as e:
        print(f"  Ollama not running: {e}")
        print("  Start with: ollama serve")


def main():
    parser = argparse.ArgumentParser(
        prog="moltassist",
        description="MoltAssist — Autonomous task execution for OpenClaw",
    )
    sub = parser.add_subparsers(dest="command")

    # run
    p_run = sub.add_parser("run", help="Execute a checklist")
    p_run.add_argument("checklist", help="Markdown checklist file")
    p_run.add_argument("--model", default="", help="Ollama model name")
    p_run.add_argument("--tier", default="medium", choices=["heavy", "medium", "light", "tiny"])
    p_run.add_argument("--auto-execute", action="store_true", help="Run shell commands automatically")
    p_run.add_argument("--output", "-o", help="Output state file path")

    # plan
    p_plan = sub.add_parser("plan", help="Plan tasks without executing")
    p_plan.add_argument("checklist", help="Markdown checklist file")
    p_plan.add_argument("--model", default="", help="Ollama model name")
    p_plan.add_argument("--tier", default="medium", choices=["heavy", "medium", "light", "tiny"])

    # status
    p_status = sub.add_parser("status", help="Show status from saved state")
    p_status.add_argument("state", help="State JSON file")

    # models
    sub.add_parser("models", help="List available models")

    args = parser.parse_args()
    if not args.command:
        parser.print_help()
        sys.exit(0)

    {"run": cmd_run, "plan": cmd_plan, "status": cmd_status, "models": cmd_models}[args.command](args)


if __name__ == "__main__":
    main()
