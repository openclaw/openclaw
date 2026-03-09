"""
Integration tests — full vault roundtrip.

These tests simulate how OpenClaw's SKILL.md actually interacts with the vault:
    1. Curator SKILL.md calls: python write_cli.py "<content>" --type Idea --energy 3 --source telegram
    2. Vault validates, hashes, writes atomically, updates manifest
    3. Enricher SKILL.md calls: python enrich_cli.py <node_id>
    4. Related papers are matched and written back
    5. Distiller/Surveyor read via query_nodes()

No mocking. Real filesystem via tmp_path. No Ollama (Phase 1).
"""

import json
import subprocess
import sys
import uuid
from pathlib import Path

import pytest
from bodhi_vault.enrich import enrich_node_concepts, match_concepts
from bodhi_vault.manifest import compute_hash, verify_manifest
from bodhi_vault.read import get_node, get_recent_nodes, query_nodes
from bodhi_vault.write import write_node


# ---------------------------------------------------------------------------
# Full roundtrip: write → read → enrich → verify
# ---------------------------------------------------------------------------

def test_full_roundtrip(vault_path, schema_path, concepts_path):
    node = {
        "id": str(uuid.uuid4()),
        "type": "Idea",
        "content": "spaced repetition might help me surface forgotten insights at the right moment",
        "energy_level": 4,
        "created_at": "2026-03-08T10:00:00+00:00",
        "source": "telegram",
        "tags": ["memory", "recall"],
    }

    # Step 1: Write
    node_id = write_node(node, vault_path, schema_path)
    assert node_id == node["id"]

    # Step 2: Read back
    retrieved = get_node(vault_path, node_id)
    assert retrieved is not None
    assert retrieved["content"] == node["content"]
    assert retrieved["content_hash"] == compute_hash(node["content"])

    # Step 3: Manifest integrity
    assert verify_manifest(vault_path) is True

    # Step 4: Enrich (concept matching)
    result = enrich_node_concepts(node_id, vault_path, schema_path, concepts_path)
    assert result is True

    # Step 5: Read enriched node
    enriched = get_node(vault_path, node_id)
    paper_ids = [p["id"] for p in enriched.get("related_papers", [])]
    assert "spaced-repetition" in paper_ids


def test_manifest_detects_tampering(vault_path, schema_path):
    node = {
        "id": str(uuid.uuid4()),
        "type": "Pattern",
        "content": "I notice flow state happens more after morning walks",
        "energy_level": 3,
        "created_at": "2026-03-08T11:00:00+00:00",
        "source": "telegram",
        "tags": ["flow", "habit"],
    }
    write_node(node, vault_path, schema_path)
    assert verify_manifest(vault_path) is True

    # Tamper with the file directly
    node_file = vault_path / "nodes" / "2026-03" / f"{node['id']}.json"
    data = json.loads(node_file.read_text())
    data["content"] = "TAMPERED"
    node_file.write_text(json.dumps(data))

    assert verify_manifest(vault_path) is False


def test_multi_node_query_and_filter(vault_path, schema_path):
    nodes = [
        {
            "id": str(uuid.uuid4()),
            "type": "Idea",
            "content": f"idea about flow and cognitive load {i}",
            "energy_level": i + 1,
            "created_at": f"2026-03-0{i + 1}T09:00:00+00:00",
            "source": "telegram",
            "tags": ["flow"] if i % 2 == 0 else ["sleep"],
        }
        for i in range(4)
    ]

    for n in nodes:
        write_node(n, vault_path, schema_path)

    all_nodes = query_nodes(vault_path)
    assert len(all_nodes) == 4

    high_energy = query_nodes(vault_path, min_energy=4)
    assert all(n["energy_level"] >= 4 for n in high_energy)

    flow_tagged = query_nodes(vault_path, tag="flow")
    assert all("flow" in n["tags"] for n in flow_tagged)

    recent = get_recent_nodes(vault_path, n=2)
    assert len(recent) == 2
    assert recent[0]["created_at"] >= recent[1]["created_at"]


def test_enrich_idempotency_across_multiple_calls(vault_path, schema_path, concepts_path):
    node = {
        "id": str(uuid.uuid4()),
        "type": "Idea",
        "content": "threshold cascade avalanche — ideas reaching criticality",
        "energy_level": 5,
        "created_at": "2026-03-08T12:00:00+00:00",
        "source": "manual",
        "tags": ["soc"],
    }
    write_node(node, vault_path, schema_path)

    first = enrich_node_concepts(node["id"], vault_path, schema_path, concepts_path)
    second = enrich_node_concepts(node["id"], vault_path, schema_path, concepts_path)
    third = enrich_node_concepts(node["id"], vault_path, schema_path, concepts_path)

    assert first is True
    assert second is False
    assert third is False

    # Manifest still valid after multiple enrichment passes
    assert verify_manifest(vault_path) is True


def test_write_cli_entrypoint(vault_path, schema_path):
    """
    Simulates: SKILL.md calls `python -m bodhi_vault.write_cli "content" --type Idea ...`
    This is the actual OpenClaw interaction pattern.
    Run as installed module (not raw script path) to avoid stdlib shadowing.
    """
    result = subprocess.run(
        [
            sys.executable,
            "-m", "bodhi_vault.write_cli",
            "flow state hits when the challenge matches the skill level",
            "--type", "Idea",
            "--energy", "4",
            "--source", "telegram",
            "--tags", "flow,challenge",
            "--vault", str(vault_path),
            "--schema", str(schema_path),
        ],
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0, result.stderr
    output = json.loads(result.stdout)
    assert "id" in output

    node = get_node(vault_path, output["id"])
    assert node is not None
    assert node["content"] == "flow state hits when the challenge matches the skill level"
