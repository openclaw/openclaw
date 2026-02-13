"""CLI main entry point."""

import sys

from openclaw_py.cli.app import create_app


def main() -> None:
    """Main entry point for the CLI."""
    app = create_app()
    app()


if __name__ == "__main__":
    main()
