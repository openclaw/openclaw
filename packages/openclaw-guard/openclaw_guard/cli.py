#!/usr/bin/env python3
"""openclaw-guard CLI."""
import argparse, sys

def main():
    p = argparse.ArgumentParser(prog="openclaw-guard",
        description="RBAC proxy for OpenClaw gateway")
    sub = p.add_subparsers(dest="cmd")

    sub.add_parser("init", help="Generate default config")

    sp = sub.add_parser("start", help="Start the proxy")
    sp.add_argument("-c", "--config", default="config/guard.yaml")
    sp.add_argument("-p", "--port", type=int)

    au = sub.add_parser("add-user", help="Add a user to config")
    au.add_argument("name")
    au.add_argument("role", help="role name (must match a role defined in guard.yaml)")
    au.add_argument("-c", "--config", default="config/guard.yaml")
    au.add_argument("-t", "--token", help="Specify token (auto-generated if omitted)")

    args = p.parse_args()

    if args.cmd == "init":
        from openclaw_guard.config import init_config
        init_config()
    elif args.cmd == "start":
        from openclaw_guard.proxy import start_proxy
        start_proxy(args.config, args.port)
    elif args.cmd == "add-user":
        from openclaw_guard.config import add_user
        add_user(args.config, args.name, args.role, args.token)
    else:
        p.print_help()

if __name__ == "__main__":
    main()
