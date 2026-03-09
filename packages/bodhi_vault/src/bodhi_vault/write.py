"""
bodhi_vault.write — Atomic node writes with validation and manifest tracking.

Every write goes through this module. No worker writes JSON directly.

Write sequence:
    1. Validate against schema (fail fast, nothing touches disk)
    2. Compute SHA-256 of content
    3. Inject content_hash into node dict
    4. Write to temp file in the target directory
    5. Atomic rename temp -> target (crash-safe)
    6. Update manifest
"""

import json
import os
import tempfile
from pathlib import Path
from typing import Any

from bodhi_vault.manifest import compute_hash, update_manifest
from bodhi_vault.validate import validate_node


def write_node(
    data: dict[str, Any],
    vault_path: Path,
    schema_path: Path,
) -> str:
    """
    Validate and atomically write a node to the vault.

    Args:
        data: Raw node dict. Must pass schema validation.
        vault_path: Root of the vault (e.g. ./vault).
        schema_path: Path to vault/schema/nodes.json.

    Returns:
        The node's id string.

    Raises:
        ValidationError: If node fails schema validation. Nothing written.
        OSError: If the filesystem write fails.
    """
    # 1. Validate before touching disk
    validate_node(data, schema_path)

    # 2. Compute content hash and inject
    content_hash = compute_hash(data["content"])
    data = {**data, "content_hash": content_hash}

    # 3. Determine target path: vault/nodes/YYYY-MM/<uuid>.json
    year_month = data["created_at"][:7]  # "2026-03" from ISO 8601
    node_dir = vault_path / "nodes" / year_month
    node_dir.mkdir(parents=True, exist_ok=True)
    node_file = node_dir / f"{data['id']}.json"

    # 4. Atomic write: temp file in same directory, then rename
    tmp_fd, tmp_path_str = tempfile.mkstemp(dir=node_dir, suffix=".tmp")
    tmp_path = Path(tmp_path_str)
    try:
        with os.fdopen(tmp_fd, "w", encoding="utf-8") as f:
            f.write(json.dumps(data, indent=2, ensure_ascii=False))
        os.replace(tmp_path, node_file)
    except Exception:
        try:
            tmp_path.unlink()
        except OSError:
            pass
        raise

    # 5. Update manifest
    update_manifest(vault_path, data["id"], node_file, content_hash)

    return data["id"]
