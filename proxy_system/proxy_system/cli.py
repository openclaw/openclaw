#!/usr/bin/env python3
"""CLI for Proxy Management System"""

from __future__ import annotations

import argparse
import os
from datetime import datetime
from typing import Optional

from . import Proxy, get_proxy_manager


def handle_add(args: argparse.Namespace) -> None:
    manager = get_proxy_manager()
    proxy_id = f"{args.host}:{args.port}"
    proxy = Proxy(
        id=proxy_id,
        host=args.host,
        port=args.port,
        username=args.username,
        password=args.password,
        protocol=args.protocol,
        country=args.country,
        provider=args.provider,
    )
    manager.add_proxy(proxy)
    print(f"✔ Added proxy: {proxy_id}")


def handle_list(args: argparse.Namespace) -> None:
    manager = get_proxy_manager()
    proxies = list(manager.proxies.values())
    if args.active_only:
        proxies = [p for p in proxies if p.is_active]

    if not proxies:
        print("No proxies found")
        return

    print(f"\n{'ID':<30} {'Host:Port':<25} {'Status':<10} {'Success Rate':<12} {'Last Used':<20}")
    print("=" * 100)

    for proxy in sorted(proxies, key=lambda p: p.last_used or datetime.min, reverse=True):
        status = "ACTIVE" if proxy.is_active else "INACTIVE"
        success_rate = f"{proxy.success_rate:.1%}"
        last_used = proxy.last_used.strftime("%Y-%m-%d %H:%M") if proxy.last_used else "Never"

        print(f"{proxy.id:<30} {proxy.host}:{proxy.port:<25} {status:<10} {success_rate:<12} {last_used:<20}")

    print(f"\nTotal: {len(proxies)} proxies")


def handle_test(args: argparse.Namespace) -> None:
    manager = get_proxy_manager()
    if args.proxy_id:
        success = manager.test_proxy(args.proxy_id, args.url)
        status = "SUCCESS" if success else "FAILED"
        print(f"{status} - Proxy {args.proxy_id}")
    else:
        print(f"Testing all proxies against {args.url}...")
        results = manager.bulk_test_proxies(args.url)
        successful = sum(1 for _, ok in results if ok)
        print(f"\nResults: {successful}/{len(results)} successful")


def handle_import(args: argparse.Namespace) -> None:
    manager = get_proxy_manager()
    if not os.path.exists(args.file):
        print(f"File not found: {args.file}")
        return

    count = manager.import_from_file(args.file, args.format)
    print(f"✔ Imported {count} proxies from {args.file}")


def handle_stats(_: argparse.Namespace) -> None:
    manager = get_proxy_manager()
    stats = manager.get_stats()
    print("\nProxy Statistics:")
    print("=" * 40)
    print(f"Total Proxies: {stats['total_proxies']}")
    print(f"Active Proxies: {stats['active_proxies']}")
    print(f"Inactive Proxies: {stats['inactive_proxies']}")
    print(f"Average Success Rate: {stats['avg_success_rate']:.1%}")
    print(f"Total Requests: {stats['total_requests']}")


def handle_get(args: argparse.Namespace) -> None:
    manager = get_proxy_manager()
    proxy = manager.get_proxy(args.strategy)
    if not proxy:
        print("No active proxies available")
        return

    print(f"\nSelected Proxy ({args.strategy}):")
    print("=" * 40)
    print(f"ID: {proxy.id}")
    print(f"URL: {proxy.url}")
    print(f"Protocol: {proxy.protocol}")
    print(f"Success Rate: {proxy.success_rate:.1%}")
    print(f"Last Used: {proxy.last_used}")

    print("\nFor requests library:")
    print("proxies = {")
    print(f"    'http': '{proxy.url}',")
    print(f"    'https': '{proxy.url}'")
    print("}")


def handle_remove(args: argparse.Namespace) -> None:
    manager = get_proxy_manager()
    manager.remove_proxy(args.proxy_id)
    print(f"✔ Removed proxy: {args.proxy_id}")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Proxy Management System")
    subparsers = parser.add_subparsers(dest="command", required=True)

    # Add proxy command
    add_parser = subparsers.add_parser("add", help="Add a new proxy")
    add_parser.add_argument("host", help="Proxy host")
    add_parser.add_argument("port", type=int, help="Proxy port")
    add_parser.add_argument("--username", help="Proxy username")
    add_parser.add_argument("--password", help="Proxy password")
    add_parser.add_argument("--protocol", default="http", help="Proxy protocol (http, https, socks4, socks5)")
    add_parser.add_argument("--country", help="Proxy country")
    add_parser.add_argument("--provider", help="Proxy provider")
    add_parser.set_defaults(func=handle_add)

    # List proxies command
    list_parser = subparsers.add_parser("list", help="List all proxies")
    list_parser.add_argument("--active-only", action="store_true", help="Show only active proxies")
    list_parser.set_defaults(func=handle_list)

    # Test proxy command
    test_parser = subparsers.add_parser("test", help="Test proxies")
    test_parser.add_argument("proxy_id", nargs="?", help="Proxy ID to test (test all if not specified)")
    test_parser.add_argument("--url", default="https://httpbin.org/ip", help="Test URL")
    test_parser.set_defaults(func=handle_test)

    # Import proxies command
    import_parser = subparsers.add_parser("import", help="Import proxies from file")
    import_parser.add_argument("file", help="File to import from")
    import_parser.add_argument("--format", default="txt", help="File format (txt, json)")
    import_parser.set_defaults(func=handle_import)

    # Stats command
    stats_parser = subparsers.add_parser("stats", help="Show proxy statistics")
    stats_parser.set_defaults(func=handle_stats)

    # Get proxy command
    get_parser = subparsers.add_parser("get", help="Get a proxy for use")
    get_parser.add_argument(
        "--strategy",
        default="round_robin",
        choices=["random", "round_robin", "success_rate"],
        help="Proxy selection strategy",
    )
    get_parser.set_defaults(func=handle_get)

    # Remove proxy command
    remove_parser = subparsers.add_parser("remove", help="Remove a proxy")
    remove_parser.add_argument("proxy_id", help="Proxy ID to remove")
    remove_parser.set_defaults(func=handle_remove)

    return parser


def main(argv: Optional[list[str]] = None) -> None:
    parser = build_parser()
    args = parser.parse_args(argv)
    func = getattr(args, "func", None)
    if func is None:
        parser.print_help()
        return
    func(args)


if __name__ == "__main__":  # pragma: no cover
    main()
