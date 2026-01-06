#!/usr/bin/env python3
import argparse
import json
import os
import re
import subprocess
import sys
import tempfile
import uuid
from pathlib import Path
from shutil import which

DEFAULT_DISPLAY_NAME = "smartthings-clawdbot"
DEFAULT_APP_NAME = "smartthings-clawdbot"
DEFAULT_DESCRIPTION = "Clawdbot SmartThings integration"
DEFAULT_REDIRECT_URI = "http://127.0.0.1:8789/callback"
DEFAULT_SCOPES = ["r:devices:*", "w:devices:*"]

ENV_KEYS = {
    "SMARTTHINGS_APP_ID": "appId",
    "SMARTTHINGS_CLIENT_ID": "clientId",
    "SMARTTHINGS_CLIENT_SECRET": "clientSecret",
}


def resolve_state_dir() -> Path:
    state_dir = os.environ.get("CLAWDBOT_STATE_DIR")
    if state_dir:
        return Path(state_dir).expanduser()
    return Path.home() / ".clawdbot"


def resolve_env_path(state_dir: Path) -> Path:
    return state_dir / ".env"


def resolve_cli() -> list[str]:
    if which("smartthings"):
        return ["smartthings"]
    npx_path = which("npx")
    if npx_path:
        return [npx_path, "-y", "@smartthings/cli"]
    raise RuntimeError("Missing SmartThings CLI. Install node (npx) or smartthings.")


def write_payload(payload: dict) -> Path:
    handle, path = tempfile.mkstemp(prefix="smartthings-app-", suffix=".json")
    with os.fdopen(handle, "w", encoding="utf-8") as file:
        json.dump(payload, file, indent=2)
    return Path(path)


def parse_json_output(output: str) -> dict | list | None:
    text = output.strip()
    if not text:
        return None
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass
    start = min((i for i in (text.find("{"), text.find("[")) if i != -1), default=-1)
    if start == -1:
        return None
    end = max(text.rfind("}"), text.rfind("]"))
    if end == -1 or end <= start:
        return None
    try:
        return json.loads(text[start : end + 1])
    except json.JSONDecodeError:
        return None


def run_create(cli: list[str], payload: dict) -> dict:
    payload_path = write_payload(payload)
    try:
        cmd = [*cli, "apps:create", "--input", str(payload_path), "--json"]
        result = subprocess.run(
            cmd,
            check=False,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
    finally:
        payload_path.unlink(missing_ok=True)

    if result.returncode != 0:
        raise RuntimeError(
            "SmartThings CLI failed.\n"
            f"Command: {' '.join(cmd)}\n"
            f"stdout: {result.stdout.strip()}\n"
            f"stderr: {result.stderr.strip()}"
        )

    data = parse_json_output(result.stdout)
    if data is None:
        raise RuntimeError(
            "SmartThings CLI did not return JSON.\n"
            f"stdout: {result.stdout.strip()}\n"
            f"stderr: {result.stderr.strip()}"
        )
    if not isinstance(data, dict):
        raise RuntimeError(f"Unexpected JSON payload: {data}")
    return data


def extract_oauth_fields(payload: dict) -> dict[str, str]:
    oauth = payload.get("oauth") or {}
    candidates = {
        "clientId": oauth.get("clientId") or oauth.get("client_id") or payload.get("clientId"),
        "clientSecret": oauth.get("clientSecret")
        or oauth.get("client_secret")
        or payload.get("clientSecret"),
        "appId": payload.get("appId") or payload.get("id"),
    }
    missing = [key for key, value in candidates.items() if not value]
    if missing:
        raise RuntimeError(
            "Missing OAuth fields from SmartThings response: " + ", ".join(missing)
        )
    return {
        "SMARTTHINGS_APP_ID": str(candidates["appId"]),
        "SMARTTHINGS_CLIENT_ID": str(candidates["clientId"]),
        "SMARTTHINGS_CLIENT_SECRET": str(candidates["clientSecret"]),
    }


def upsert_env(env_path: Path, updates: dict[str, str]) -> None:
    env_path.parent.mkdir(parents=True, exist_ok=True)
    existing = []
    if env_path.exists():
        existing = env_path.read_text(encoding="utf-8").splitlines()

    updated_lines: list[str] = []
    seen: set[str] = set()
    key_pattern = re.compile(r"^([A-Z0-9_]+)=(.*)$")

    for line in existing:
        match = key_pattern.match(line)
        if match and match.group(1) in updates:
            key = match.group(1)
            updated_lines.append(f"{key}={updates[key]}")
            seen.add(key)
        else:
            updated_lines.append(line)

    for key, value in updates.items():
        if key not in seen:
            updated_lines.append(f"{key}={value}")

    env_path.write_text("\n".join(updated_lines).rstrip() + "\n", encoding="utf-8")
    try:
        os.chmod(env_path, 0o600)
    except PermissionError:
        pass


def build_payload(app_name: str) -> dict:
    return {
        "appName": app_name,
        "displayName": DEFAULT_DISPLAY_NAME,
        "description": DEFAULT_DESCRIPTION,
        "appType": "API_ONLY",
        "oauth": {
            "clientName": DEFAULT_DISPLAY_NAME,
            "scope": DEFAULT_SCOPES,
            "redirectUris": [DEFAULT_REDIRECT_URI],
        },
    }


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Provision a SmartThings OAuth app for Clawdbot."
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="Recreate credentials even if they already exist in the env file.",
    )
    args = parser.parse_args()

    try:
        cli = resolve_cli()
    except RuntimeError as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 1

    state_dir = resolve_state_dir()
    env_path = resolve_env_path(state_dir)
    existing_env = {}
    if env_path.exists():
        for line in env_path.read_text(encoding="utf-8").splitlines():
            if "=" in line and not line.lstrip().startswith("#"):
                key, value = line.split("=", 1)
                existing_env[key.strip()] = value.strip()

    if not args.force and all(
        existing_env.get(key) for key in ENV_KEYS.keys()
    ):
        print("SmartThings credentials already present; skipping setup.")
        print(f"Env file: {env_path}")
        print("Use --force to recreate.")
        return 0

    payload = build_payload(DEFAULT_APP_NAME)
    try:
        data = run_create(cli, payload)
    except RuntimeError as exc:
        err = str(exc)
        if "appName" in err and "already" in err.lower():
            fallback_name = f"{DEFAULT_APP_NAME}-{uuid.uuid4().hex[:8]}"
            payload = build_payload(fallback_name)
            data = run_create(cli, payload)
        else:
            print(f"Error: {exc}", file=sys.stderr)
            return 1

    try:
        updates = extract_oauth_fields(data)
    except RuntimeError as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 1

    upsert_env(env_path, updates)

    print("SmartThings OAuth app created.")
    print(f"Display Name: {DEFAULT_DISPLAY_NAME}")
    print(f"Redirect URI: {DEFAULT_REDIRECT_URI}")
    print(f"App ID: {updates['SMARTTHINGS_APP_ID']}")
    print(f"Saved credentials to: {env_path}")
    print("Next: set SMARTTHINGS_DEVICE_ID (use: smartthings devices --json)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
