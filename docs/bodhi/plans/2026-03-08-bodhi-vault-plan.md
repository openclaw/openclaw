# bodhi-vault Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build the Python vault module that all Bodhi workers use to read and write thoughts — validated, integrity-checked, enrichable with local AI.

**Architecture:** Python package at `packages/bodhi_vault/`. All vault I/O flows through this module — no worker writes JSON directly. Validation against JSON Schema, SHA-256 manifest for integrity, optional async enrichment via local Mistral Nemo model. TDD throughout.

**Tech Stack:** Python 3.11+, uv (package manager), jsonschema, httpx, pytest, pytest-asyncio

---

## Pre-flight

Before starting, verify Python and uv are installed:
```bash
python --version   # must be 3.11+
uv --version       # if missing: pip install uv
```

If uv is missing on Windows:
```powershell
pip install uv
```

---

### Task 1: Schema updates

**Goal:** Get the JSON schema accurate before writing any code against it.

**Files:**
- Modify: `vault/schema/nodes.json`

**Step 1: Update nodes.json**

Replace the `source` enum and add new optional fields. The final `properties` section should include these additions/changes:

```json
"source": {
  "type": "string",
  "enum": ["telegram", "signal", "whatsapp", "manual", "surveyor", "distiller"],
  "description": "Where this node originated."
},
"content_enriched": {
  "type": "string",
  "minLength": 1,
  "maxLength": 20000,
  "description": "Legible expansion of content by local Mistral Nemo model. Preserves original meaning."
},
"content_hash": {
  "type": "string",
  "pattern": "^sha256:[a-f0-9]{64}$",
  "description": "SHA-256 hash of the content field. Written at creation for integrity checks."
},
"enriched_at": {
  "type": "string",
  "format": "date-time",
  "description": "When enrichment completed."
},
"enrichment_model": {
  "type": "string",
  "description": "Which local model performed enrichment. e.g. mistral-nemo:12b"
},
"related_papers": {
  "type": "array",
  "items": {
    "type": "object",
    "required": ["concept", "citation", "url"],
    "properties": {
      "concept": {"type": "string"},
      "label": {"type": "string"},
      "citation": {"type": "string"},
      "url": {"type": "string", "format": "uri"},
      "scholar": {"type": "string", "format": "uri"}
    }
  },
  "description": "Research papers matched from concepts.json by the Enricher."
}
```

**Step 2: Commit**
```bash
git add vault/schema/nodes.json
git commit -m "feat(schema): add telegram source, enrichment fields, content_hash"
```

---

### Task 2: Project scaffold

**Files:**
- Create: `packages/bodhi_vault/__init__.py`
- Create: `packages/bodhi_vault/pyproject.toml`
- Create: `tests/bodhi_vault/__init__.py`
- Create: `tests/bodhi_vault/conftest.py`

**Step 1: Create directory structure**
```bash
mkdir -p packages/bodhi_vault/data
mkdir -p tests/bodhi_vault
touch packages/bodhi_vault/__init__.py
touch tests/bodhi_vault/__init__.py
```

**Step 2: Create `packages/bodhi_vault/pyproject.toml`**
```toml
[project]
name = "bodhi-vault"
version = "0.1.0"
description = "OpenBodhi vault read/write module"
requires-python = ">=3.11"
dependencies = [
    "jsonschema>=4.23",
    "httpx>=0.27",
    "chromadb>=0.5",
]

[project.optional-dependencies]
dev = [
    "pytest>=8.0",
    "pytest-asyncio>=0.23",
]

[tool.pytest.ini_options]
asyncio_mode = "auto"
testpaths = ["tests"]
```

**Step 3: Create `tests/bodhi_vault/conftest.py`**
```python
import pytest
import tempfile
from pathlib import Path
import shutil


@pytest.fixture
def vault_path(tmp_path):
    """A temporary vault directory, cleaned up after each test."""
    vault = tmp_path / "vault"
    vault.mkdir()
    (vault / "nodes").mkdir()
    (vault / "edges").mkdir()
    (vault / "archive").mkdir()
    return vault


@pytest.fixture
def schema_path():
    """Path to the actual vault schema files in the repo."""
    return Path(__file__).parent.parent.parent.parent / "vault" / "schema"
```

**Step 4: Install dependencies**
```bash
cd packages/bodhi_vault
uv pip install -e ".[dev]"
```

**Step 5: Run tests (expect 0 tests collected, 0 failures)**
```bash
cd ../..  # back to repo root
uv run pytest tests/bodhi_vault/ -v
```
Expected output: `no tests ran`

**Step 6: Commit**
```bash
git add packages/ tests/bodhi_vault/
git commit -m "feat(vault): project scaffold, pyproject.toml, test fixtures"
```

---

### Task 3: Types module

**Files:**
- Create: `packages/bodhi_vault/types.py`
- Create: `tests/bodhi_vault/test_types.py`

**Step 1: Write the failing test**

Create `tests/bodhi_vault/test_types.py`:
```python
from bodhi_vault.types import NodeType, EdgeType, Node, Edge
from datetime import datetime, timezone


def test_node_type_enum_values():
    assert NodeType.IDEA.value == "Idea"
    assert NodeType.PATTERN.value == "Pattern"
    assert NodeType.PRACTICE.value == "Practice"
    assert NodeType.DECISION.value == "Decision"
    assert NodeType.SYNTHESIS.value == "Synthesis"
    assert NodeType.INTEGRATION.value == "Integration"


def test_edge_type_enum_values():
    assert EdgeType.LEADS_TO.value == "LEADS_TO"
    assert EdgeType.SURFACES_FROM.value == "SURFACES_FROM"
    assert EdgeType.CONTRADICTS.value == "CONTRADICTS"


def test_node_minimal_fields():
    node = Node(
        id="123e4567-e89b-12d3-a456-426614174000",
        type=NodeType.IDEA,
        content="rest is not laziness",
        energy_level=4,
        created_at=datetime.now(timezone.utc),
        source="telegram",
        tags=["rest", "recovery"],
    )
    assert node.content == "rest is not laziness"
    assert node.energy_level == 4
    assert node.content_enriched is None  # not set yet


def test_node_to_dict_excludes_none_optional_fields():
    node = Node(
        id="123e4567-e89b-12d3-a456-426614174000",
        type=NodeType.IDEA,
        content="test",
        energy_level=3,
        created_at=datetime.now(timezone.utc),
        source="telegram",
        tags=[],
    )
    d = node.to_dict()
    assert "content_enriched" not in d
    assert "related_papers" not in d
    assert "content" in d
    assert "id" in d
```

**Step 2: Run to verify it fails**
```bash
uv run pytest tests/bodhi_vault/test_types.py -v
```
Expected: `ModuleNotFoundError: No module named 'bodhi_vault.types'`

**Step 3: Create `packages/bodhi_vault/types.py`**
```python
from __future__ import annotations
from dataclasses import dataclass, field, asdict
from datetime import datetime
from enum import Enum
from typing import Optional


class NodeType(Enum):
    IDEA = "Idea"
    PATTERN = "Pattern"
    PRACTICE = "Practice"
    DECISION = "Decision"
    SYNTHESIS = "Synthesis"
    INTEGRATION = "Integration"


class EdgeType(Enum):
    LEADS_TO = "LEADS_TO"
    GENERATES = "GENERATES"
    SURFACES_FROM = "SURFACES_FROM"
    CONTRADICTS = "CONTRADICTS"
    ASSOCIATED_WITH = "ASSOCIATED_WITH"
    INFORMS = "INFORMS"


@dataclass
class Node:
    id: str
    type: NodeType
    content: str
    energy_level: int
    created_at: datetime
    source: str
    tags: list[str]
    # Optional fields
    content_enriched: Optional[str] = None
    content_hash: Optional[str] = None
    enriched_at: Optional[datetime] = None
    enrichment_model: Optional[str] = None
    related_papers: Optional[list[dict]] = None
    updated_at: Optional[datetime] = None
    promoted_from: Optional[str] = None
    cluster_id: Optional[str] = None
    embedding_model: Optional[str] = None
    created_by: Optional[str] = None

    def to_dict(self) -> dict:
        """Serialize to dict, converting enums and datetimes, omitting None values."""
        d = {}
        for k, v in asdict(self).items():
            if v is None:
                continue
            if isinstance(v, Enum):
                d[k] = v.value
            elif isinstance(v, datetime):
                d[k] = v.isoformat()
            else:
                d[k] = v
        # type is stored as NodeType enum, convert
        d["type"] = self.type.value
        if self.created_at:
            d["created_at"] = self.created_at.isoformat()
        if self.updated_at:
            d["updated_at"] = self.updated_at.isoformat()
        if self.enriched_at:
            d["enriched_at"] = self.enriched_at.isoformat()
        return d


@dataclass
class Edge:
    id: str
    type: EdgeType
    from_node: str  # 'from' is a Python keyword
    to_node: str
    created_at: datetime
    created_by: str
    confidence: Optional[float] = None
    note: Optional[str] = None

    def to_dict(self) -> dict:
        d = {
            "id": self.id,
            "type": self.type.value,
            "from": self.from_node,
            "to": self.to_node,
            "created_at": self.created_at.isoformat(),
            "created_by": self.created_by,
        }
        if self.confidence is not None:
            d["confidence"] = self.confidence
        if self.note is not None:
            d["note"] = self.note
        return d
```

**Step 4: Run to verify tests pass**
```bash
uv run pytest tests/bodhi_vault/test_types.py -v
```
Expected: `4 passed`

**Step 5: Commit**
```bash
git add packages/bodhi_vault/types.py tests/bodhi_vault/test_types.py
git commit -m "feat(vault): types module — NodeType, EdgeType, Node, Edge dataclasses"
```

---

### Task 4: Validate module

**Files:**
- Create: `packages/bodhi_vault/validate.py`
- Create: `tests/bodhi_vault/test_validate.py`

**Step 1: Write the failing test**

Create `tests/bodhi_vault/test_validate.py`:
```python
import pytest
from bodhi_vault.validate import validate_node, validate_edge, ValidationError


VALID_NODE = {
    "id": "123e4567-e89b-12d3-a456-426614174000",
    "type": "Idea",
    "content": "rest is not laziness",
    "energy_level": 4,
    "created_at": "2026-03-08T06:00:00+00:00",
    "source": "telegram",
    "tags": ["rest", "recovery"],
}

VALID_EDGE = {
    "id": "223e4567-e89b-12d3-a456-426614174000",
    "type": "LEADS_TO",
    "from": "123e4567-e89b-12d3-a456-426614174000",
    "to": "323e4567-e89b-12d3-a456-426614174000",
    "created_at": "2026-03-08T06:00:00+00:00",
    "created_by": "curator",
}


def test_valid_node_passes(schema_path):
    validate_node(VALID_NODE, schema_path)  # should not raise


def test_valid_edge_passes(schema_path):
    validate_edge(VALID_EDGE, schema_path)  # should not raise


def test_missing_required_field_raises(schema_path):
    bad = {**VALID_NODE}
    del bad["content"]
    with pytest.raises(ValidationError, match="content"):
        validate_node(bad, schema_path)


def test_invalid_type_raises(schema_path):
    bad = {**VALID_NODE, "type": "NotAType"}
    with pytest.raises(ValidationError):
        validate_node(bad, schema_path)


def test_energy_level_out_of_range_raises(schema_path):
    bad = {**VALID_NODE, "energy_level": 6}
    with pytest.raises(ValidationError):
        validate_node(bad, schema_path)


def test_invalid_tag_format_raises(schema_path):
    bad = {**VALID_NODE, "tags": ["Has Capitals"]}
    with pytest.raises(ValidationError):
        validate_node(bad, schema_path)


def test_telegram_source_valid(schema_path):
    node = {**VALID_NODE, "source": "telegram"}
    validate_node(node, schema_path)  # should not raise


def test_unknown_source_raises(schema_path):
    bad = {**VALID_NODE, "source": "twitter"}
    with pytest.raises(ValidationError):
        validate_node(bad, schema_path)
```

**Step 2: Run to verify it fails**
```bash
uv run pytest tests/bodhi_vault/test_validate.py -v
```
Expected: `ModuleNotFoundError: No module named 'bodhi_vault.validate'`

**Step 3: Create `packages/bodhi_vault/validate.py`**
```python
import json
from pathlib import Path
import jsonschema
from jsonschema import validate, ValidationError as JsonSchemaError


class ValidationError(Exception):
    pass


def _load_schema(schema_path: Path, filename: str) -> dict:
    schema_file = schema_path / filename
    if not schema_file.exists():
        raise FileNotFoundError(f"Schema not found: {schema_file}")
    with open(schema_file) as f:
        return json.load(f)


def validate_node(data: dict, schema_path: Path) -> None:
    """Validate a node dict against nodes.json schema. Raises ValidationError if invalid."""
    schema = _load_schema(schema_path, "nodes.json")
    try:
        validate(instance=data, schema=schema)
    except JsonSchemaError as e:
        raise ValidationError(f"Node validation failed: {e.message}") from e


def validate_edge(data: dict, schema_path: Path) -> None:
    """Validate an edge dict against edges.json schema. Raises ValidationError if invalid."""
    schema = _load_schema(schema_path, "edges.json")
    try:
        validate(instance=data, schema=schema)
    except JsonSchemaError as e:
        raise ValidationError(f"Edge validation failed: {e.message}") from e
```

**Step 4: Run to verify tests pass**
```bash
uv run pytest tests/bodhi_vault/test_validate.py -v
```
Expected: `8 passed`

**Step 5: Commit**
```bash
git add packages/bodhi_vault/validate.py tests/bodhi_vault/test_validate.py
git commit -m "feat(vault): validate module with jsonschema, ValidationError"
```

---

### Task 5: Manifest module

**Files:**
- Create: `packages/bodhi_vault/manifest.py`
- Create: `tests/bodhi_vault/test_manifest.py`

**Step 1: Write the failing test**

Create `tests/bodhi_vault/test_manifest.py`:
```python
import json
from pathlib import Path
from bodhi_vault.manifest import update_manifest, verify_manifest, compute_hash


def test_compute_hash_is_deterministic():
    h1 = compute_hash("some content")
    h2 = compute_hash("some content")
    assert h1 == h2
    assert h1.startswith("sha256:")
    assert len(h1) == 71  # "sha256:" + 64 hex chars


def test_compute_hash_differs_for_different_input():
    h1 = compute_hash("content A")
    h2 = compute_hash("content B")
    assert h1 != h2


def test_update_manifest_creates_file(vault_path):
    node_file = vault_path / "nodes" / "2026-03" / "abc.json"
    node_file.parent.mkdir(parents=True, exist_ok=True)
    node_file.write_text('{"content": "test"}')

    update_manifest(vault_path, "abc", node_file, "sha256:" + "a" * 64)

    manifest_file = vault_path / "manifest.json"
    assert manifest_file.exists()
    manifest = json.loads(manifest_file.read_text())
    assert "abc" in manifest
    assert manifest["abc"]["hash"] == "sha256:" + "a" * 64
    assert manifest["abc"]["path"] == str(node_file.relative_to(vault_path))


def test_verify_manifest_passes_when_hashes_match(vault_path):
    import hashlib
    content = '{"content": "test"}'
    node_file = vault_path / "nodes" / "2026-03" / "abc.json"
    node_file.parent.mkdir(parents=True, exist_ok=True)
    node_file.write_text(content)

    real_hash = "sha256:" + hashlib.sha256(content.encode()).hexdigest()
    update_manifest(vault_path, "abc", node_file, real_hash)

    failures = verify_manifest(vault_path)
    assert failures == []


def test_verify_manifest_fails_when_file_modified(vault_path):
    import hashlib
    content = '{"content": "original"}'
    node_file = vault_path / "nodes" / "2026-03" / "abc.json"
    node_file.parent.mkdir(parents=True, exist_ok=True)
    node_file.write_text(content)

    real_hash = "sha256:" + hashlib.sha256(content.encode()).hexdigest()
    update_manifest(vault_path, "abc", node_file, real_hash)

    # Tamper with the file
    node_file.write_text('{"content": "tampered"}')

    failures = verify_manifest(vault_path)
    assert "abc" in failures
```

**Step 2: Run to verify it fails**
```bash
uv run pytest tests/bodhi_vault/test_manifest.py -v
```
Expected: `ModuleNotFoundError: No module named 'bodhi_vault.manifest'`

**Step 3: Create `packages/bodhi_vault/manifest.py`**
```python
import hashlib
import json
from pathlib import Path


def compute_hash(content: str) -> str:
    """Compute SHA-256 of string content. Returns 'sha256:<hex>'."""
    digest = hashlib.sha256(content.encode("utf-8")).hexdigest()
    return f"sha256:{digest}"


def update_manifest(
    vault_path: Path,
    node_id: str,
    file_path: Path,
    content_hash: str,
) -> None:
    """Record a node's hash in manifest.json. Creates manifest if missing."""
    manifest_file = vault_path / "manifest.json"
    if manifest_file.exists():
        manifest = json.loads(manifest_file.read_text())
    else:
        manifest = {}

    manifest[node_id] = {
        "hash": content_hash,
        "path": str(file_path.relative_to(vault_path)),
    }

    manifest_file.write_text(json.dumps(manifest, indent=2))


def verify_manifest(vault_path: Path) -> list[str]:
    """
    Verify every entry in manifest.json.
    Returns list of node IDs whose file hash does not match.
    Empty list means vault is clean.
    """
    manifest_file = vault_path / "manifest.json"
    if not manifest_file.exists():
        return []

    manifest = json.loads(manifest_file.read_text())
    failures = []

    for node_id, entry in manifest.items():
        file_path = vault_path / entry["path"]
        if not file_path.exists():
            failures.append(node_id)
            continue

        actual_hash = compute_hash(file_path.read_text(encoding="utf-8"))
        if actual_hash != entry["hash"]:
            failures.append(node_id)

    return failures
```

**Step 4: Run to verify tests pass**
```bash
uv run pytest tests/bodhi_vault/test_manifest.py -v
```
Expected: `5 passed`

**Step 5: Commit**
```bash
git add packages/bodhi_vault/manifest.py tests/bodhi_vault/test_manifest.py
git commit -m "feat(vault): manifest module — SHA-256 integrity tracking"
```

---

### Task 6: Write module

**Files:**
- Create: `packages/bodhi_vault/write.py`
- Create: `tests/bodhi_vault/test_write.py`

**Step 1: Write the failing test**

Create `tests/bodhi_vault/test_write.py`:
```python
import json
import pytest
from datetime import datetime, timezone
from pathlib import Path
from bodhi_vault.write import write_node, write_edge
from bodhi_vault.validate import ValidationError


SCHEMA_PATH = Path(__file__).parent.parent.parent.parent / "vault" / "schema"


def make_node(**overrides):
    base = {
        "id": "123e4567-e89b-12d3-a456-426614174000",
        "type": "Idea",
        "content": "rest is not laziness",
        "energy_level": 4,
        "created_at": "2026-03-08T06:00:00+00:00",
        "source": "telegram",
        "tags": ["rest"],
    }
    return {**base, **overrides}


def test_write_node_creates_file(vault_path):
    node = make_node()
    node_id = write_node(node, vault_path, SCHEMA_PATH)
    assert node_id == node["id"]

    # File exists in YYYY-MM subdirectory
    node_file = vault_path / "nodes" / "2026-03" / f"{node_id}.json"
    assert node_file.exists()


def test_write_node_file_content_matches(vault_path):
    node = make_node()
    node_id = write_node(node, vault_path, SCHEMA_PATH)
    node_file = vault_path / "nodes" / "2026-03" / f"{node_id}.json"
    written = json.loads(node_file.read_text())
    assert written["content"] == "rest is not laziness"
    assert written["energy_level"] == 4
    assert written["type"] == "Idea"


def test_write_node_adds_content_hash(vault_path):
    node = make_node()
    write_node(node, vault_path, SCHEMA_PATH)
    node_file = vault_path / "nodes" / "2026-03" / f"{node['id']}.json"
    written = json.loads(node_file.read_text())
    assert "content_hash" in written
    assert written["content_hash"].startswith("sha256:")


def test_write_node_updates_manifest(vault_path):
    node = make_node()
    node_id = write_node(node, vault_path, SCHEMA_PATH)
    manifest_file = vault_path / "manifest.json"
    assert manifest_file.exists()
    manifest = json.loads(manifest_file.read_text())
    assert node_id in manifest


def test_write_node_invalid_schema_raises(vault_path):
    node = make_node(energy_level=99)  # out of range
    with pytest.raises(ValidationError):
        write_node(node, vault_path, SCHEMA_PATH)


def test_write_node_invalid_raises_no_file_written(vault_path):
    node = make_node(type="InvalidType")
    with pytest.raises(ValidationError):
        write_node(node, vault_path, SCHEMA_PATH)
    # Directory should not have been created
    node_dir = vault_path / "nodes" / "2026-03"
    assert not node_dir.exists() or not any(node_dir.iterdir())


def test_write_edge_creates_file(vault_path):
    edge = {
        "id": "223e4567-e89b-12d3-a456-426614174000",
        "type": "LEADS_TO",
        "from": "123e4567-e89b-12d3-a456-426614174000",
        "to": "323e4567-e89b-12d3-a456-426614174000",
        "created_at": "2026-03-08T06:00:00+00:00",
        "created_by": "curator",
    }
    edge_id = write_edge(edge, vault_path, SCHEMA_PATH)
    edge_file = vault_path / "edges" / f"{edge_id}.json"
    assert edge_file.exists()
```

**Step 2: Run to verify it fails**
```bash
uv run pytest tests/bodhi_vault/test_write.py -v
```
Expected: `ModuleNotFoundError: No module named 'bodhi_vault.write'`

**Step 3: Create `packages/bodhi_vault/write.py`**
```python
import json
import tempfile
import os
from datetime import datetime, timezone
from pathlib import Path
from .validate import validate_node, validate_edge
from .manifest import compute_hash, update_manifest


def write_node(data: dict, vault_path: Path, schema_path: Path) -> str:
    """
    Validate, hash, and write a node to vault/nodes/YYYY-MM/{id}.json.
    Updates manifest.json.
    Returns node ID.
    Raises ValidationError if data is invalid (no file written).
    """
    # Validate first — before any filesystem operations
    validate_node(data, schema_path)

    # Compute and attach content hash
    content_hash = compute_hash(data["content"])
    data = {**data, "content_hash": content_hash}

    # Determine output directory from created_at
    created_at = data["created_at"]
    year_month = created_at[:7]  # "2026-03"
    node_dir = vault_path / "nodes" / year_month
    node_dir.mkdir(parents=True, exist_ok=True)

    node_file = node_dir / f"{data['id']}.json"
    serialized = json.dumps(data, indent=2, ensure_ascii=False)

    # Atomic write: write to temp file, then rename
    tmp_fd, tmp_path = tempfile.mkstemp(dir=node_dir, suffix=".tmp")
    try:
        with os.fdopen(tmp_fd, "w", encoding="utf-8") as f:
            f.write(serialized)
        os.replace(tmp_path, node_file)
    except Exception:
        os.unlink(tmp_path)
        raise

    # Update integrity manifest
    update_manifest(vault_path, data["id"], node_file, content_hash)

    return data["id"]


def write_edge(data: dict, vault_path: Path, schema_path: Path) -> str:
    """
    Validate and write an edge to vault/edges/{id}.json.
    Returns edge ID.
    """
    validate_edge(data, schema_path)

    edges_dir = vault_path / "edges"
    edges_dir.mkdir(parents=True, exist_ok=True)

    edge_file = edges_dir / f"{data['id']}.json"
    serialized = json.dumps(data, indent=2, ensure_ascii=False)

    tmp_fd, tmp_path = tempfile.mkstemp(dir=edges_dir, suffix=".tmp")
    try:
        with os.fdopen(tmp_fd, "w", encoding="utf-8") as f:
            f.write(serialized)
        os.replace(tmp_path, edge_file)
    except Exception:
        os.unlink(tmp_path)
        raise

    return data["id"]
```

**Step 4: Run to verify tests pass**
```bash
uv run pytest tests/bodhi_vault/test_write.py -v
```
Expected: `7 passed`

**Step 5: Commit**
```bash
git add packages/bodhi_vault/write.py tests/bodhi_vault/test_write.py
git commit -m "feat(vault): write module — atomic node/edge write with validation and manifest"
```

---

### Task 7: Read module

**Files:**
- Create: `packages/bodhi_vault/read.py`
- Create: `tests/bodhi_vault/test_read.py`

**Step 1: Write the failing test**

Create `tests/bodhi_vault/test_read.py`:
```python
import json
import pytest
from pathlib import Path
from bodhi_vault.read import query_nodes, get_node, get_recent_nodes
from bodhi_vault.write import write_node

SCHEMA_PATH = Path(__file__).parent.parent.parent.parent / "vault" / "schema"


def seed_node(vault_path, **overrides):
    base = {
        "id": "123e4567-e89b-12d3-a456-426614174000",
        "type": "Idea",
        "content": "rest is not laziness",
        "energy_level": 4,
        "created_at": "2026-03-08T06:00:00+00:00",
        "source": "telegram",
        "tags": ["rest", "recovery"],
    }
    node = {**base, **overrides}
    write_node(node, vault_path, SCHEMA_PATH)
    return node


def test_get_node_returns_written_node(vault_path):
    seeded = seed_node(vault_path)
    node = get_node(vault_path, seeded["id"])
    assert node["content"] == seeded["content"]
    assert node["energy_level"] == seeded["energy_level"]


def test_get_node_returns_none_for_missing(vault_path):
    result = get_node(vault_path, "nonexistent-id")
    assert result is None


def test_query_nodes_by_type(vault_path):
    seed_node(vault_path, id="aaa-111", type="Idea")
    seed_node(vault_path, id="bbb-222", type="Decision",
              created_at="2026-03-08T07:00:00+00:00")
    ideas = query_nodes(vault_path, type="Idea")
    decisions = query_nodes(vault_path, type="Decision")
    assert any(n["id"] == "aaa-111" for n in ideas)
    assert all(n["type"] == "Idea" for n in ideas)
    assert any(n["id"] == "bbb-222" for n in decisions)


def test_query_nodes_by_tag(vault_path):
    seed_node(vault_path, id="aaa-111", tags=["rest", "recovery"])
    seed_node(vault_path, id="bbb-222", tags=["focus"],
              created_at="2026-03-08T07:00:00+00:00")
    results = query_nodes(vault_path, tag="rest")
    assert any(n["id"] == "aaa-111" for n in results)
    assert not any(n["id"] == "bbb-222" for n in results)


def test_query_nodes_by_energy_min(vault_path):
    seed_node(vault_path, id="aaa-111", energy_level=4)
    seed_node(vault_path, id="bbb-222", energy_level=2,
              created_at="2026-03-08T07:00:00+00:00")
    results = query_nodes(vault_path, energy_min=4)
    assert any(n["id"] == "aaa-111" for n in results)
    assert not any(n["id"] == "bbb-222" for n in results)


def test_get_recent_nodes_last_7_days(vault_path):
    # Node from today — should appear
    seed_node(vault_path, id="today-001", created_at="2026-03-08T06:00:00+00:00")
    # Node from 30 days ago — should not appear
    seed_node(vault_path, id="old-001", created_at="2026-02-06T06:00:00+00:00")
    results = get_recent_nodes(vault_path, days=7, reference_date="2026-03-08")
    ids = [n["id"] for n in results]
    assert "today-001" in ids
    assert "old-001" not in ids
```

**Step 2: Run to verify it fails**
```bash
uv run pytest tests/bodhi_vault/test_read.py -v
```
Expected: `ModuleNotFoundError: No module named 'bodhi_vault.read'`

**Step 3: Create `packages/bodhi_vault/read.py`**
```python
import json
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Optional


def get_node(vault_path: Path, node_id: str) -> Optional[dict]:
    """Find a node by ID. Searches all year-month directories. Returns None if not found."""
    nodes_dir = vault_path / "nodes"
    if not nodes_dir.exists():
        return None
    for month_dir in nodes_dir.iterdir():
        if not month_dir.is_dir():
            continue
        node_file = month_dir / f"{node_id}.json"
        if node_file.exists():
            return json.loads(node_file.read_text(encoding="utf-8"))
    return None


def query_nodes(
    vault_path: Path,
    type: Optional[str] = None,
    tag: Optional[str] = None,
    energy_min: Optional[int] = None,
    days: Optional[int] = None,
    reference_date: Optional[str] = None,
) -> list[dict]:
    """
    Query all nodes matching optional filters.
    Returns list sorted by created_at descending.
    """
    nodes_dir = vault_path / "nodes"
    if not nodes_dir.exists():
        return []

    cutoff = None
    if days is not None:
        ref = datetime.fromisoformat(reference_date) if reference_date else datetime.now(timezone.utc)
        if ref.tzinfo is None:
            ref = ref.replace(tzinfo=timezone.utc)
        cutoff = ref - timedelta(days=days)

    results = []
    for month_dir in nodes_dir.iterdir():
        if not month_dir.is_dir():
            continue
        for node_file in month_dir.glob("*.json"):
            try:
                node = json.loads(node_file.read_text(encoding="utf-8"))
            except (json.JSONDecodeError, OSError):
                continue

            # Apply filters
            if type is not None and node.get("type") != type:
                continue
            if tag is not None and tag not in node.get("tags", []):
                continue
            if energy_min is not None and node.get("energy_level", 0) < energy_min:
                continue
            if cutoff is not None:
                created = datetime.fromisoformat(node["created_at"])
                if created.tzinfo is None:
                    created = created.replace(tzinfo=timezone.utc)
                if created < cutoff:
                    continue

            results.append(node)

    results.sort(key=lambda n: n.get("created_at", ""), reverse=True)
    return results


def get_recent_nodes(
    vault_path: Path,
    days: int = 7,
    reference_date: Optional[str] = None,
) -> list[dict]:
    """Return all nodes from the last N days."""
    return query_nodes(vault_path, days=days, reference_date=reference_date)
```

**Step 4: Run to verify tests pass**
```bash
uv run pytest tests/bodhi_vault/test_read.py -v
```
Expected: `6 passed`

**Step 5: Commit**
```bash
git add packages/bodhi_vault/read.py tests/bodhi_vault/test_read.py
git commit -m "feat(vault): read module — query_nodes, get_node, get_recent_nodes"
```

---

### Task 8: Reference library

**Files:**
- Create: `packages/bodhi_vault/data/concepts.json`

**Step 1: Create `packages/bodhi_vault/data/concepts.json`**

```json
{
  "self-organized-criticality": {
    "label": "Self-Organized Criticality",
    "citation": "Bak, Tang & Wiesenfeld (1987)",
    "url": "https://journals.aps.org/prl/abstract/10.1103/PhysRevLett.59.381",
    "scholar": "https://scholar.google.com/scholar?q=self-organized+criticality+bak+1987",
    "related": ["criticality", "avalanche", "power law", "emergence", "threshold", "cascade", "sandpile"]
  },
  "spaced-repetition": {
    "label": "Spacing Effect",
    "citation": "Ebbinghaus (1885)",
    "url": "https://doi.org/10.1037/10011-000",
    "scholar": "https://scholar.google.com/scholar?q=ebbinghaus+memory+forgetting+curve",
    "related": ["memory", "recall", "learning", "forgetting", "retention", "review", "interval"]
  },
  "flow-state": {
    "label": "Flow: Optimal Experience",
    "citation": "Csikszentmihalyi (1990)",
    "url": "https://www.jstor.org/stable/1322631",
    "scholar": "https://scholar.google.com/scholar?q=csikszentmihalyi+flow+optimal+experience",
    "related": ["focus", "deep work", "engagement", "challenge", "skill", "absorption", "present"]
  },
  "cognitive-load": {
    "label": "Cognitive Load Theory",
    "citation": "Sweller (1988)",
    "url": "https://doi.org/10.1207/s15516709cog1202_2",
    "scholar": "https://scholar.google.com/scholar?q=sweller+cognitive+load+theory",
    "related": ["overload", "working memory", "complexity", "mental effort", "overwhelm", "capacity"]
  },
  "psychological-recovery": {
    "label": "Recovery Experience",
    "citation": "Sonnentag & Fritz (2007)",
    "url": "https://doi.org/10.1037/0021-9010.92.3.677",
    "scholar": "https://scholar.google.com/scholar?q=sonnentag+fritz+recovery+experience+questionnaire",
    "related": ["rest", "recovery", "detachment", "relaxation", "fatigue", "recharge", "downtime", "laziness"]
  },
  "intrinsic-motivation": {
    "label": "Self-Determination Theory",
    "citation": "Deci & Ryan (1985)",
    "url": "https://doi.org/10.1007/978-1-4899-2271-7",
    "scholar": "https://scholar.google.com/scholar?q=deci+ryan+self+determination+theory",
    "related": ["motivation", "autonomy", "purpose", "drive", "agency", "meaning", "passion"]
  },
  "metacognition": {
    "label": "Metacognitive Monitoring",
    "citation": "Flavell (1979)",
    "url": "https://doi.org/10.1037/0003-066X.34.10.906",
    "scholar": "https://scholar.google.com/scholar?q=flavell+metacognition+cognitive+monitoring",
    "related": ["thinking", "self-awareness", "reflection", "self-knowledge", "awareness", "monitoring"]
  },
  "default-mode-network": {
    "label": "Default Mode Network & Creativity",
    "citation": "Beaty et al. (2016)",
    "url": "https://doi.org/10.1073/pnas.1517969113",
    "scholar": "https://scholar.google.com/scholar?q=default+mode+network+creative+cognition+beaty",
    "related": ["daydreaming", "insight", "creativity", "rest", "wandering", "imagination", "aha moment"]
  },
  "behavioral-activation": {
    "label": "Behavioral Activation",
    "citation": "Lewinsohn (1974)",
    "url": "https://scholar.google.com/scholar?q=lewinsohn+behavioral+activation",
    "scholar": "https://scholar.google.com/scholar?q=behavioral+activation+depression+treatment",
    "related": ["action", "engagement", "avoidance", "activation", "mood", "inertia", "starting"]
  },
  "decision-fatigue": {
    "label": "Decision Fatigue & Ego Depletion",
    "citation": "Baumeister et al. (1998)",
    "url": "https://doi.org/10.1037/0022-3514.74.5.1252",
    "scholar": "https://scholar.google.com/scholar?q=baumeister+ego+depletion+decision+fatigue",
    "related": ["decision", "fatigue", "willpower", "choice", "depletion", "overwhelm", "options"]
  },
  "insight-incubation": {
    "label": "Insight and Incubation",
    "citation": "Sio & Ormerod (2009)",
    "url": "https://doi.org/10.1037/a0014017",
    "scholar": "https://scholar.google.com/scholar?q=sio+ormerod+incubation+insight",
    "related": ["insight", "incubation", "breakthrough", "aha", "subconscious", "sleep on it", "sudden clarity"]
  },
  "growth-mindset": {
    "label": "Growth Mindset",
    "citation": "Dweck (2006)",
    "url": "https://scholar.google.com/scholar?q=dweck+mindset+growth+fixed",
    "scholar": "https://scholar.google.com/scholar?q=dweck+mindset+2006",
    "related": ["growth", "fixed mindset", "potential", "failure", "learning", "challenge", "improvement"]
  },
  "sleep-memory": {
    "label": "Sleep and Memory Consolidation",
    "citation": "Walker (2017)",
    "url": "https://scholar.google.com/scholar?q=walker+why+we+sleep+2017",
    "scholar": "https://scholar.google.com/scholar?q=sleep+memory+consolidation+learning",
    "related": ["sleep", "memory", "consolidation", "dreaming", "REM", "rest", "learning", "fatigue"]
  },
  "neuroplasticity": {
    "label": "Neuroplasticity and Learning",
    "citation": "Merzenich et al. (2013)",
    "url": "https://scholar.google.com/scholar?q=merzenich+neuroplasticity+learning",
    "scholar": "https://scholar.google.com/scholar?q=neuroplasticity+learning+brain+change",
    "related": ["brain", "learning", "change", "habit", "rewiring", "practice", "repetition", "adaptation"]
  },
  "hdbscan-clustering": {
    "label": "HDBSCAN: Hierarchical Density Clustering",
    "citation": "McInnes, Healy & Astels (2017)",
    "url": "https://doi.org/10.21105/joss.00205",
    "scholar": "https://scholar.google.com/scholar?q=mcinnes+hdbscan+2017",
    "related": ["clustering", "patterns", "grouping", "density", "noise", "structure", "similarity"]
  }
}
```

**Step 2: Commit**
```bash
git add packages/bodhi_vault/data/concepts.json
git commit -m "feat(vault): research reference library — 15 initial concepts with DOIs"
```

---

### Task 9: Enrich module

This module calls Ollama. Tests use a mock so they run without Ollama installed.

**Files:**
- Create: `packages/bodhi_vault/enrich.py`
- Create: `tests/bodhi_vault/test_enrich.py`

**Step 1: Write the failing test**

Create `tests/bodhi_vault/test_enrich.py`:
```python
import json
import pytest
from pathlib import Path
from unittest.mock import AsyncMock, patch, MagicMock
from bodhi_vault.enrich import enrich_node, match_concepts, load_concepts


SCHEMA_PATH = Path(__file__).parent.parent.parent.parent / "vault" / "schema"


def test_load_concepts_returns_dict():
    concepts = load_concepts()
    assert isinstance(concepts, dict)
    assert "self-organized-criticality" in concepts
    assert "url" in concepts["self-organized-criticality"]


def test_match_concepts_finds_related_terms():
    concepts = load_concepts()
    matched = match_concepts("I keep forgetting to rest, it feels like laziness", concepts)
    keys = [m["concept"] for m in matched]
    assert "psychological-recovery" in keys


def test_match_concepts_returns_empty_for_no_match():
    concepts = load_concepts()
    matched = match_concepts("xyzzy frobnicator quux", concepts)
    assert matched == []


def test_match_concepts_deduplicates():
    concepts = load_concepts()
    # "rest" matches psychological-recovery, "fatigue" also matches it
    matched = match_concepts("rest fatigue recovery", concepts)
    keys = [m["concept"] for m in matched]
    assert len(keys) == len(set(keys))


@pytest.mark.asyncio
async def test_enrich_node_updates_file(vault_path):
    from bodhi_vault.write import write_node
    node = {
        "id": "test-enrich-001",
        "type": "Idea",
        "content": "rest is not laziness, I keep forgetting this",
        "energy_level": 4,
        "created_at": "2026-03-08T06:00:00+00:00",
        "source": "telegram",
        "tags": ["rest"],
    }
    write_node(node, vault_path, SCHEMA_PATH)

    mock_response = {
        "content_enriched": "Rest is not laziness. Psychological recovery research shows deliberate rest is a precondition for sustained output.",
        "concept_keys": ["psychological-recovery"]
    }

    with patch("bodhi_vault.enrich.call_ollama", new_callable=AsyncMock) as mock_ollama:
        mock_ollama.return_value = json.dumps(mock_response)
        await enrich_node("test-enrich-001", vault_path, SCHEMA_PATH)

    # Read back the node
    node_file = vault_path / "nodes" / "2026-03" / "test-enrich-001.json"
    updated = json.loads(node_file.read_text())
    assert updated["content_enriched"] == mock_response["content_enriched"]
    assert len(updated["related_papers"]) == 1
    assert updated["related_papers"][0]["concept"] == "psychological-recovery"
    assert "enriched_at" in updated
    assert updated["enrichment_model"] == "mistral-nemo:12b"


@pytest.mark.asyncio
async def test_enrich_node_skips_already_enriched(vault_path):
    from bodhi_vault.write import write_node
    node = {
        "id": "test-skip-001",
        "type": "Idea",
        "content": "test",
        "energy_level": 3,
        "created_at": "2026-03-08T06:00:00+00:00",
        "source": "telegram",
        "tags": [],
        "content_enriched": "already enriched",
    }
    # Write directly (skip validation for already-enriched field for this test)
    node_dir = vault_path / "nodes" / "2026-03"
    node_dir.mkdir(parents=True, exist_ok=True)
    (node_dir / "test-skip-001.json").write_text(json.dumps(node))

    with patch("bodhi_vault.enrich.call_ollama", new_callable=AsyncMock) as mock_ollama:
        await enrich_node("test-skip-001", vault_path, SCHEMA_PATH)
        mock_ollama.assert_not_called()
```

**Step 2: Run to verify it fails**
```bash
uv run pytest tests/bodhi_vault/test_enrich.py -v
```
Expected: `ModuleNotFoundError: No module named 'bodhi_vault.enrich'`

**Step 3: Create `packages/bodhi_vault/enrich.py`**
```python
import json
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional
import httpx

from .read import get_node


_CONCEPTS_PATH = Path(__file__).parent / "data" / "concepts.json"
_DEFAULT_MODEL = "mistral-nemo:12b"
_DEFAULT_OLLAMA = "http://127.0.0.1:11434"


def load_concepts() -> dict:
    with open(_CONCEPTS_PATH, encoding="utf-8") as f:
        return json.load(f)


def match_concepts(content: str, concepts: dict) -> list[dict]:
    """
    Find which concepts in the library are relevant to the content.
    Matches on 'related' keyword lists. Returns list of paper dicts.
    """
    content_lower = content.lower()
    matched = {}
    for key, entry in concepts.items():
        for term in entry.get("related", []):
            if term.lower() in content_lower:
                if key not in matched:
                    matched[key] = {
                        "concept": key,
                        "label": entry.get("label", key),
                        "citation": entry["citation"],
                        "url": entry["url"],
                        "scholar": entry.get("scholar"),
                    }
                break
    return list(matched.values())


async def call_ollama(
    prompt: str,
    model: str = _DEFAULT_MODEL,
    ollama_host: str = _DEFAULT_OLLAMA,
) -> str:
    """Call Ollama generate API. Returns raw response text."""
    async with httpx.AsyncClient(timeout=60.0) as client:
        response = await client.post(
            f"{ollama_host}/api/generate",
            json={"model": model, "prompt": prompt, "stream": False},
        )
        response.raise_for_status()
        return response.json()["response"]


_ENRICH_PROMPT = """You are reading a raw captured thought. Do two things:

1. If the text is fragmented or unclear, rewrite it as one or two clear sentences preserving the original meaning exactly. If it is already clear, return it unchanged.

2. Identify which of these concept keys apply (choose only those clearly relevant):
{concept_keys}

Return JSON only, no explanation:
{{"content_enriched": "...", "concept_keys": ["key1", "key2"]}}

Raw thought: {content}"""


async def enrich_node(
    node_id: str,
    vault_path: Path,
    schema_path: Path,
    model: str = _DEFAULT_MODEL,
    ollama_host: str = _DEFAULT_OLLAMA,
) -> bool:
    """
    Enrich a vault node with legible expansion and related papers.
    Skips if content_enriched already exists.
    Returns True if enrichment ran, False if skipped or failed.
    """
    node = get_node(vault_path, node_id)
    if node is None:
        return False
    if node.get("content_enriched"):
        return False  # Already enriched — idempotent

    concepts = load_concepts()
    concept_keys_str = ", ".join(concepts.keys())
    prompt = _ENRICH_PROMPT.format(
        concept_keys=concept_keys_str,
        content=node["content"],
    )

    try:
        raw = await call_ollama(prompt, model=model, ollama_host=ollama_host)
        # Extract JSON from response (model may add extra text)
        start = raw.find("{")
        end = raw.rfind("}") + 1
        result = json.loads(raw[start:end])
    except Exception:
        # Ollama unavailable or parse error — skip enrichment silently
        return False

    # Match referenced concept keys to paper entries
    matched_keys = result.get("concept_keys", [])
    related_papers = []
    for key in matched_keys:
        if key in concepts:
            entry = concepts[key]
            paper = {
                "concept": key,
                "label": entry.get("label", key),
                "citation": entry["citation"],
                "url": entry["url"],
            }
            if "scholar" in entry:
                paper["scholar"] = entry["scholar"]
            related_papers.append(paper)

    # Also run keyword matching as a fallback
    keyword_matched = match_concepts(node["content"], concepts)
    existing_keys = {p["concept"] for p in related_papers}
    for paper in keyword_matched:
        if paper["concept"] not in existing_keys:
            related_papers.append(paper)
            existing_keys.add(paper["concept"])

    # Update the node file in place
    node["content_enriched"] = result.get("content_enriched", node["content"])
    node["related_papers"] = related_papers
    node["enriched_at"] = datetime.now(timezone.utc).isoformat()
    node["enrichment_model"] = model

    # Find and overwrite the node file
    nodes_dir = vault_path / "nodes"
    for month_dir in nodes_dir.iterdir():
        if not month_dir.is_dir():
            continue
        node_file = month_dir / f"{node_id}.json"
        if node_file.exists():
            node_file.write_text(json.dumps(node, indent=2, ensure_ascii=False))
            return True

    return False
```

**Step 4: Run to verify tests pass**
```bash
uv run pytest tests/bodhi_vault/test_enrich.py -v
```
Expected: `6 passed`

**Step 5: Commit**
```bash
git add packages/bodhi_vault/enrich.py tests/bodhi_vault/test_enrich.py
git commit -m "feat(vault): enrich module — Mistral Nemo enrichment + concept matching"
```

---

### Task 10: Full test suite + round-trip integration test

**Files:**
- Create: `tests/bodhi_vault/test_integration.py`

**Step 1: Write integration test**

Create `tests/bodhi_vault/test_integration.py`:
```python
"""
Integration test: write a node, verify manifest, read it back, verify content identical.
"""
import json
import pytest
from pathlib import Path
from bodhi_vault.write import write_node
from bodhi_vault.read import get_node, get_recent_nodes, query_nodes
from bodhi_vault.manifest import verify_manifest

SCHEMA_PATH = Path(__file__).parent.parent.parent.parent / "vault" / "schema"


def test_full_write_read_roundtrip(vault_path):
    node = {
        "id": "roundtrip-001",
        "type": "Idea",
        "content": "rest is not laziness, I keep forgetting this",
        "energy_level": 4,
        "created_at": "2026-03-08T06:00:00+00:00",
        "source": "telegram",
        "tags": ["rest", "recovery"],
    }
    write_node(node, vault_path, SCHEMA_PATH)

    read_back = get_node(vault_path, "roundtrip-001")
    assert read_back is not None
    assert read_back["content"] == node["content"]
    assert read_back["energy_level"] == node["energy_level"]
    assert read_back["type"] == node["type"]
    assert read_back["tags"] == node["tags"]


def test_manifest_clean_after_write(vault_path):
    node = {
        "id": "manifest-001",
        "type": "Idea",
        "content": "thoughts on systems thinking",
        "energy_level": 3,
        "created_at": "2026-03-08T06:00:00+00:00",
        "source": "telegram",
        "tags": ["systems"],
    }
    write_node(node, vault_path, SCHEMA_PATH)
    failures = verify_manifest(vault_path)
    assert failures == []


def test_write_multiple_nodes_all_queryable(vault_path):
    nodes = [
        {"id": "multi-001", "type": "Idea", "content": "A",
         "energy_level": 4, "created_at": "2026-03-08T06:00:00+00:00",
         "source": "telegram", "tags": ["alpha"]},
        {"id": "multi-002", "type": "Practice", "content": "B",
         "energy_level": 2, "created_at": "2026-03-08T07:00:00+00:00",
         "source": "telegram", "tags": ["beta"]},
        {"id": "multi-003", "type": "Idea", "content": "C",
         "energy_level": 5, "created_at": "2026-03-08T08:00:00+00:00",
         "source": "telegram", "tags": ["alpha", "gamma"]},
    ]
    for n in nodes:
        write_node(n, vault_path, SCHEMA_PATH)

    all_nodes = query_nodes(vault_path)
    assert len(all_nodes) == 3

    ideas = query_nodes(vault_path, type="Idea")
    assert len(ideas) == 2

    high_energy = query_nodes(vault_path, energy_min=4)
    assert len(high_energy) == 2

    alpha_tagged = query_nodes(vault_path, tag="alpha")
    assert len(alpha_tagged) == 2
```

**Step 2: Run all tests**
```bash
uv run pytest tests/bodhi_vault/ -v
```
Expected: all tests pass

**Step 3: Final commit**
```bash
git add tests/bodhi_vault/test_integration.py
git commit -m "test(vault): integration tests — write/read roundtrip, manifest integrity, multi-node queries"
```

**Step 4: Push**
```bash
git push origin main
```

---

## Verification Checklist

- [ ] `uv run pytest tests/bodhi_vault/ -v` — all tests pass, zero failures
- [ ] `uv run pytest tests/bodhi_vault/ --tb=short -q` — shows clean summary
- [ ] Write a node, read it back — content identical
- [ ] Write invalid node (energy_level=99) — raises ValidationError, no file created
- [ ] Tamper with a vault file — `verify_manifest()` returns that node ID in failures list
- [ ] `match_concepts("rest is not laziness", concepts)` returns `psychological-recovery`

---

## What This Enables

With this module complete, the Curator SKILL.md can instruct Claude to call these scripts directly via OpenClaw's `bash` tool. The vault write path becomes:

```
Telegram message
  > Claude (Curator SKILL.md)
    > bash: python -m bodhi_vault.write_cli <node_json>
    > bash: python -m bodhi_vault.enrich_cli <node_id>  [async]
```

Next task after this: write the CLI entrypoints (`write_cli.py`, `enrich_cli.py`) that the Curator SKILL.md can call via bash.
