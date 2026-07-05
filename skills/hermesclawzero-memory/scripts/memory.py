import os
import sys
from pathlib import Path

import requests

BASE_URL = (os.getenv("MEM_PUBLIC_URL") or os.getenv("OPENCLAW_URL") or "http://localhost:8000").rstrip("/")
API_KEY = os.getenv("API_KEY") or os.getenv("OPENCLAW_KEY")
SYNC_DIR = os.getenv("MEM_SYNC_DIR") or os.getenv("OPENCLAW_SYNC_DIR") or str(Path.cwd() / "sync")

if not API_KEY:
    raise RuntimeError("API_KEY is required. Set API_KEY (or OPENCLAW_KEY for compatibility).")


def capture(text: str) -> None:
    url = f"{BASE_URL}/capture"
    params = {"key": API_KEY}
    data = {"text": text}
    response = requests.post(url, params=params, json=data, timeout=30)
    response.raise_for_status()
    print(response.json())


def search(query: str, limit: int = 5) -> None:
    url = f"{BASE_URL}/search"
    params = {"query": query, "limit": limit, "key": API_KEY}
    response = requests.get(url, params=params, timeout=30)
    response.raise_for_status()
    print(response.json())


def autosave(content: str, filename: str) -> None:
    if not filename.endswith((".txt", ".md", ".json")):
        filename += ".txt"

    Path(SYNC_DIR).mkdir(parents=True, exist_ok=True)
    filepath = Path(SYNC_DIR) / filename
    filepath.write_text(content, encoding="utf-8")
    print(f"Autosaved to {filepath}")


def main() -> None:
    if len(sys.argv) < 2:
        print("Usage: memory.py [capture|search|autosave] [args...]")
        sys.exit(1)

    cmd = sys.argv[1]
    if cmd == "capture":
        if len(sys.argv) < 3:
            print("Usage: memory.py capture \"text\"")
            sys.exit(1)
        capture(sys.argv[2])
    elif cmd == "search":
        if len(sys.argv) < 3:
            print("Usage: memory.py search \"query\" [limit]")
            sys.exit(1)
        search(sys.argv[2], int(sys.argv[3]) if len(sys.argv) > 3 else 5)
    elif cmd == "autosave":
        if len(sys.argv) < 4:
            print("Usage: memory.py autosave \"content\" filename")
            sys.exit(1)
        autosave(sys.argv[2], sys.argv[3])
    else:
        print(f"Unknown command: {cmd}")
        sys.exit(1)


if __name__ == "__main__":
    main()
