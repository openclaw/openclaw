from __future__ import annotations

"""Self-test for the local plugin registry."""

from typing import List

try:
    from .manager import list_plugins
except ImportError:
    from manager import list_plugins

__all__ = ["run_self_test"]


def run_self_test() -> None:
    """Run a minimal registry test and print the result."""
    plugins = list_plugins()
    if not isinstance(plugins, list):
        raise RuntimeError("list_plugins did not return a list")
    print("REGISTRY TEST PASSED")


def main() -> None:
    """CLI entry point for `python -m plugins.registry.self_test`."""
    run_self_test()


if __name__ == "__main__":
    main()
