"""
bodhi_vault — Vault I/O module for OpenBodhi.

All vault reads and writes flow through this module.
No worker writes JSON to the vault directly.

Public API:
    write_node(data, vault_path, schema_path) -> str
    read.get_node(vault_path, node_id) -> dict | None
    read.query_nodes(vault_path, **filters) -> list[dict]
    read.get_recent_nodes(vault_path, n) -> list[dict]
    validate.validate_node(data, schema_path)
    manifest.verify_manifest(vault_path) -> bool
    enrich.enrich_node(node_id, vault_path, schema_path) -> bool
    siyuan_sync.sync_to_siyuan(node) -> None  (fire-and-forget)
    obsidian_sync.sync_to_obsidian(node) -> None  (fire-and-forget)

Sync behaviour:
    Both syncs are disabled when their env var is unset:
      SIYUAN_API_TOKEN   → enables SiYuan sync
      OBSIDIAN_VAULT_PATH → enables Obsidian sync
    Neither sync ever raises or blocks vault writes.
"""

__version__ = "0.1.0"
