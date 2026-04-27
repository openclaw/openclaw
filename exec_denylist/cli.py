from future import annotations

import argparse
import json
import sys
from pathlib import Path

from exec_denylist.engine import DenylistEngine

DEFAULT_CONFIG = "denylist.yaml"


def find_config(explicit: str | None = None) -> Path:
   if explicit:
       p = Path(explicit)
       if not p.exists():
           print(f"Error: config not found: {p}", file=sys.stderr)
           sys.exit(1)
       return p
   for candidate in [Path(DEFAULT_CONFIG), Path.home() / ".config" / "exec-denylist" / DEFAULT_CONFIG]:
       if candidate.exists():
           return candidate
   print(f"Error: no {DEFAULT_CONFIG} found in current dir or ~/.config/exec-denylist/", file=sys.stderr)
   sys.exit(1)


def cmd_check(args):
   config = find_config(args.config)
   engine = DenylistEngine.from_config(config, strict=args.strict)
   result = engine.evaluate(args.command, dry_run=args.dry_run, allow_high=args.allow_high)
   out = {
       "command": result.command,
       "denied": result.denied,
       "dry_run": result.dry_run,
       "matched_rules": [r.id for r in result.matched_rules],
       "max_severity": result.max_severity,
       "reason": result.reason,
   }
   print(json.dumps(out, indent=2))
   sys.exit(1 if result.denied else 0)


def cmd_validate(args):
   config = find_config(args.config)
   try:
       engine = DenylistEngine.from_config(config, strict=args.strict)
       print(f"Valid: {len(engine.rules)} rules loaded from {config}")
   except Exception as e:
       print(f"Invalid config: {e}", file=sys.stderr)
       sys.exit(1)


def cmd_list_rules(args):
   config = find_config(args.config)
   engine = DenylistEngine.from_config(config)
   for r in engine.rules:
       print(f"  [{r.severity:8s}] {r.id}: {r.description}")


def main():
   parser = argparse.ArgumentParser(prog="exec-denylist", description="Exec approval denylist gatekeeper")
   parser.add_argument("-c", "--config", help="Path to denylist.yaml")
   parser.add_argument("--strict", action="store_true", help="Deny medium-severity matches too")
   sub = parser.add_subparsers(dest="subcmd", required=True)

   p_check = sub.add_parser("check", help="Evaluate a command against the denylist")
   p_check.add_argument("command", help="Command string to evaluate")
   p_check.add_argument("--dry-run", action="store_true", help="Log but don't block")
   p_check.add_argument("--allow-high", action="store_true", help="Allow high-severity matches")
   p_check.set_defaults(func=cmd_check)

   p_val = sub.add_parser("validate", help="Validate the denylist config")
   p_val.set_defaults(func=cmd_validate)

   p_list = sub.add_parser("list-rules", help="List all configured rules")
   p_list.set_defaults(func=cmd_list_rules)

   args = parser.parse_args()
   args.func(args)


if name == "__main__":
   main()