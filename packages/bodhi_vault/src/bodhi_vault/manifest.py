"""
bodhi_vault.manifest — SHA-256 integrity tracking for vault nodes.

The manifest is a single JSON file at vault_path/manifest.json.
Structure:
    {
        "<node-uuid>": {
            "path": "nodes/2026-03/uuid.json",
            "hash": "<sha256-of-content-field>",
            "updated_at": "<iso8601>"
        },
        ...
    }

The hash is computed from the node's `content` field — the raw thought.
If content changes, the hash changes. That's the tamper signal.
"""

import hashlib
import json
import os
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import yaml


class ManifestError(RuntimeError):
    """Raised when manifest verification finds a tampered or missing node."""


def compute_hash(content: str) -> str:
    """Return SHA-256 hex digest of content string (UTF-8 encoded)."""
    return hashlib.sha256(content.encode("utf-8")).hexdigest()


def update_manifest(
    vault_path: Path,
    node_id: str,
    node_file: Path,
    content_hash: str,
) -> None:
    """
    Add or update a node's entry in the manifest.

    Uses atomic write (temp file + rename) so a crash mid-write
    never corrupts the manifest.

    Args:
        vault_path: Root of the vault (manifest.json lives here).
        node_id: UUID of the node.
        node_file: Absolute path to the node's JSON file.
        content_hash: SHA-256 of the node's content field.
    """
    manifest_file = vault_path / "manifest.json"
    manifest = _load_manifest(manifest_file)

    manifest[node_id] = {
        "path": str(node_file.relative_to(vault_path)),
        "hash": content_hash,
        "updated_at": datetime.now(timezone.utc).isoformat(),
    }

    _save_manifest(manifest_file, manifest)


def _read_node_file(path: Path) -> dict[str, Any] | None:
    """Read a single node file (either .md or .json) and return the node dict."""
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        return None

    if path.suffix == ".md":
        # Markdown with YAML frontmatter
        lines = text.split("\n")
        if not lines or lines[0].strip() != "---":
            return None
        closing_idx = None
        for i in range(1, len(lines)):
            if lines[i].strip() == "---":
                closing_idx = i
                break
        if closing_idx is None:
            return None
        frontmatter_text = "\n".join(lines[1:closing_idx])
        content = "\n".join(lines[closing_idx + 1:])
        try:
            frontmatter = yaml.safe_load(frontmatter_text) or {}
        except yaml.YAMLError:
            return None
        return {**frontmatter, "content": content}
    else:
        # JSON fallback
        try:
            return json.loads(text)
        except json.JSONDecodeError:
            return None


def verify_manifest(vault_path: Path) -> bool:
    """
    Verify all nodes in the manifest match their on-disk content hashes.

    Returns:
        True if all nodes are intact.
        False if any node is missing or has been tampered with.
    """
    manifest_file = vault_path / "manifest.json"
    if not manifest_file.exists():
        return True  # Empty vault is valid

    manifest = _load_manifest(manifest_file)

    for node_id, entry in manifest.items():
        node_file = vault_path / entry["path"]
        if not node_file.exists():
            return False

        data = _read_node_file(node_file)
        if data is None:
            return False

        actual_hash = compute_hash(data.get("content", ""))
        if actual_hash != entry["hash"]:
            return False

    return True


def _load_manifest(manifest_file: Path) -> dict[str, Any]:
    if not manifest_file.exists():
        return {}
    with open(manifest_file, encoding="utf-8") as f:
        return json.load(f)


def _save_manifest(manifest_file: Path, manifest: dict[str, Any]) -> None:
    """Atomic manifest write: temp file in same directory, then rename."""
    parent = manifest_file.parent
    parent.mkdir(parents=True, exist_ok=True)

    tmp_fd, tmp_path = tempfile.mkstemp(dir=parent, suffix=".tmp")
    try:
        with os.fdopen(tmp_fd, "w", encoding="utf-8") as f:
            json.dump(manifest, f, indent=2, ensure_ascii=False)
        os.replace(tmp_path, manifest_file)
    except Exception:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
        raise
