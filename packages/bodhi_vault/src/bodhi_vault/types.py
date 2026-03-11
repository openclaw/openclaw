"""
bodhi_vault.types — Core data types for the OpenBodhi vault.

Uses stdlib dataclasses: no Pydantic, no external validation here.
Schema validation happens at the I/O boundary (validate.py).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum
from typing import Any, Optional


class NodeType(str, Enum):
    """Six node types. Determines how workers process the node."""

    IDEA = "Idea"
    PATTERN = "Pattern"
    PRACTICE = "Practice"
    DECISION = "Decision"
    SYNTHESIS = "Synthesis"
    INTEGRATION = "Integration"


class EdgeType(str, Enum):
    """Semantic relationship between two nodes."""

    SUPPORTS = "supports"
    CONTRADICTS = "contradicts"
    PROMOTES = "promotes"
    RELATES = "relates"
    PRECEDES = "precedes"
    SOCIAL_BRIDGE = "social_bridge"  # nodes sharing people or social context across domains


@dataclass
class Node:
    """A single knowledge node. Mirrors vault/schema/nodes.json."""

    id: str
    type: NodeType
    content: str
    energy_level: int
    created_at: datetime
    source: str
    tags: list[str]

    # Enrichment fields — populated by Enricher worker, None until then
    content_enriched: Optional[str] = None
    content_hash: Optional[str] = None
    enriched_at: Optional[datetime] = None
    enrichment_model: Optional[str] = None
    related_papers: Optional[list[dict[str, Any]]] = None

    # Worker-assigned metadata
    updated_at: Optional[datetime] = None
    promoted_from: Optional[str] = None
    cluster_id: Optional[str] = None
    embedding_model: Optional[str] = None
    created_by: Optional[str] = None

    # Multimodal intake fields — set by Curator on capture
    media_type: Optional[str] = None
    media_ref: Optional[str] = None
    domain: Optional[str] = None

    # Social context fields — set by Curator when people are mentioned
    people: Optional[list[str]] = None
    social_context: Optional[str] = None

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "Node":
        """Construct a Node from a raw dict (e.g. parsed from JSON)."""
        type_val = NodeType(data["type"])

        def _dt(val: Optional[str]) -> Optional[datetime]:
            if val is None:
                return None
            return datetime.fromisoformat(val)

        return cls(
            id=data["id"],
            type=type_val,
            content=data["content"],
            energy_level=data["energy_level"],
            created_at=_dt(data["created_at"]),  # type: ignore[arg-type]
            source=data["source"],
            tags=data.get("tags", []),
            content_enriched=data.get("content_enriched"),
            content_hash=data.get("content_hash"),
            enriched_at=_dt(data.get("enriched_at")),
            enrichment_model=data.get("enrichment_model"),
            related_papers=data.get("related_papers"),
            updated_at=_dt(data.get("updated_at")),
            promoted_from=data.get("promoted_from"),
            cluster_id=data.get("cluster_id"),
            embedding_model=data.get("embedding_model"),
            created_by=data.get("created_by"),
            media_type=data.get("media_type"),
            media_ref=data.get("media_ref"),
            domain=data.get("domain"),
            people=data.get("people"),
            social_context=data.get("social_context"),
        )

    def to_dict(self) -> dict[str, Any]:
        """Serialize to a dict suitable for JSON output. Omits None fields."""

        def _iso(val: Optional[datetime]) -> Optional[str]:
            if val is None:
                return None
            return val.isoformat()

        result: dict[str, Any] = {
            "id": self.id,
            "type": self.type.value,
            "content": self.content,
            "energy_level": self.energy_level,
            "created_at": _iso(self.created_at),
            "source": self.source,
            "tags": self.tags,
        }

        optional_fields: list[tuple[str, Any]] = [
            ("content_enriched", self.content_enriched),
            ("content_hash", self.content_hash),
            ("enriched_at", _iso(self.enriched_at)),
            ("enrichment_model", self.enrichment_model),
            ("related_papers", self.related_papers),
            ("updated_at", _iso(self.updated_at)),
            ("promoted_from", self.promoted_from),
            ("cluster_id", self.cluster_id),
            ("embedding_model", self.embedding_model),
            ("created_by", self.created_by),
            ("media_type", self.media_type),
            ("media_ref", self.media_ref),
            ("domain", self.domain),
            ("people", self.people),
            ("social_context", self.social_context),
        ]

        for key, val in optional_fields:
            if val is not None:
                result[key] = val

        return result


@dataclass
class Edge:
    """A directed relationship between two nodes."""

    id: str
    source_id: str
    target_id: str
    type: EdgeType
    created_at: datetime
    weight: float = 1.0
    created_by: Optional[str] = None

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "Edge":
        return cls(
            id=data["id"],
            source_id=data["source_id"],
            target_id=data["target_id"],
            type=EdgeType(data["type"]),
            created_at=datetime.fromisoformat(data["created_at"]),
            weight=data.get("weight", 1.0),
            created_by=data.get("created_by"),
        )

    def to_dict(self) -> dict[str, Any]:
        result: dict[str, Any] = {
            "id": self.id,
            "source_id": self.source_id,
            "target_id": self.target_id,
            "type": self.type.value,
            "created_at": self.created_at.isoformat(),
            "weight": self.weight,
        }
        if self.created_by is not None:
            result["created_by"] = self.created_by
        return result
