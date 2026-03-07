"""Allow running as: python -m packages.db.migrate --db ./openclaw.db"""
from packages.db.migrate import _cli

if __name__ == "__main__":
    _cli()
