from __future__ import annotations

import hashlib
import json
import math
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable

from memory_store import connect

DEFAULT_COLLECTION = "dali_local_v1_reflections"
DEFAULT_VECTOR_SIZE = 64
DEFAULT_QDRANT_URL = "http://localhost:6333"
DEFAULT_TIMEOUT_SECONDS = 5.0


class SemanticStoreError(RuntimeError):
    """Base class for semantic store integration errors."""


class QdrantUnavailableError(SemanticStoreError):
    """Raised when the Qdrant Python client is not installed."""


class QdrantOperationError(SemanticStoreError):
    """Raised when the configured Qdrant operation fails."""


def default_embed(text: str, vector_size: int = DEFAULT_VECTOR_SIZE) -> list[float]:
    if vector_size <= 0:
        raise ValueError("vector_size must be greater than zero")

    normalized = (text or "").strip()
    norm_bytes = normalized.encode("utf-8")
    vector: list[float] = []

    if not norm_bytes:
        return [0.0] * vector_size

    for idx in range(vector_size):
        digest = hashlib.blake2s(norm_bytes, digest_size=4, person=f"vec-{idx}".encode("utf-8")).digest()
        raw = int.from_bytes(digest[:4], byteorder="big", signed=False)
        vector.append((raw / (2**32 - 1)) * 2 - 1.0)

    norm = math.sqrt(sum(v * v for v in vector))
    if norm == 0.0:
        return vector
    return [v / norm for v in vector]


def _safe_json_loads(value: str | None, default: Any) -> Any:
    if value is None:
        return default
    if isinstance(value, (list, dict, int, float, bool, type(None))):
        return value
    try:
        return json.loads(value)
    except (TypeError, json.JSONDecodeError):
        return default


def _reflection_payload(reflection: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": reflection.get("id"),
        "created_at": reflection.get("created_at"),
        "source_event_id": reflection.get("source_event_id"),
        "reflection_text": reflection.get("reflection_text"),
        "durable_claims": _safe_json_loads(reflection.get("durable_claims_json"), []),
        "uncertainties": _safe_json_loads(reflection.get("uncertainties_json"), []),
        "interdisciplinary_links": _safe_json_loads(
            reflection.get("interdisciplinary_links_json"), []
        ),
        "nca_signal": reflection.get("nca_signal"),
        "creative_fragment": reflection.get("creative_fragment"),
        "memory_candidate_score": reflection.get("memory_candidate_score"),
        "payload": _safe_json_loads(reflection.get("payload_json"), {}),
    }


def build_reflection_points(
    reflections: Iterable[dict[str, Any]],
    vector_size: int = DEFAULT_VECTOR_SIZE,
) -> list[dict[str, Any]]:
    points: list[dict[str, Any]] = []
    for reflection in reflections:
        text = (reflection.get("reflection_text") or "").strip()
        if not text:
            continue
        points.append(
            {
                "id": reflection.get("id"),
                "vector": default_embed(text, vector_size=vector_size),
                "payload": _reflection_payload(reflection),
            }
        )
    return points


def load_reflections_for_index(db_path: str | Path, limit: int | None = None) -> list[dict[str, Any]]:
    query = """
        SELECT id, created_at, source_event_id, reflection_text, durable_claims_json,
               uncertainties_json, interdisciplinary_links_json, nca_signal,
               creative_fragment, memory_candidate_score, payload_json
        FROM reflections
        ORDER BY created_at DESC
    """
    params: tuple[Any, ...] = tuple()
    if limit and limit > 0:
        query += " LIMIT ?"
        params = (limit,)

    with connect(db_path) as conn:
        rows = conn.execute(query, params).fetchall()
    return [dict(row) for row in rows]


@dataclass(frozen=True)
class QdrantSettings:
    url: str = DEFAULT_QDRANT_URL
    collection: str = DEFAULT_COLLECTION
    vector_size: int = DEFAULT_VECTOR_SIZE
    timeout_seconds: float = DEFAULT_TIMEOUT_SECONDS


class QdrantReflectionIndex:
    def __init__(self, settings: QdrantSettings | None = None) -> None:
        self.settings = settings or QdrantSettings()
        self._client = None

    def _get_client(self):
        if self._client is not None:
            return self._client

        try:
            from qdrant_client import QdrantClient
            from qdrant_client.http import models
        except ImportError as exc:  # pragma: no cover - exercised indirectly
            raise QdrantUnavailableError(
                "qdrant_client is required for live vector operations. "
                "Install with: pip install qdrant-client"
            ) from exc

        self._models = models
        self._client = QdrantClient(url=self.settings.url, timeout=self.settings.timeout_seconds)
        return self._client

    def ensure_collection(self, *, reset: bool = False) -> bool:
        client = self._get_client()
        if reset:
            try:
                client.delete_collection(collection_name=self.settings.collection)
            except Exception:
                # Collection may not exist.
                pass

        models = self._models
        collection_name = self.settings.collection

        try:
            exists = client.collection_exists(collection_name=collection_name)
        except AttributeError:
            try:
                client.get_collection(collection_name=collection_name)
                exists = True
            except Exception:
                exists = False

        if not exists:
            client.create_collection(
                collection_name=collection_name,
                vectors_config=models.VectorParams(
                    size=self.settings.vector_size,
                    distance=models.Distance.COSINE,
                ),
            )
            return True
        return False

    def _to_points(self, points: list[dict[str, Any]]) -> list[Any]:
        models = self._models
        converted = []
        for point in points:
            converted.append(
                models.PointStruct(
                    id=point["id"],
                    vector=point["vector"],
                    payload=point["payload"],
                )
            )
        return converted

    def upsert_reflections(
        self,
        points: list[dict[str, Any]],
        *,
        reset_collection: bool = False,
        dry_run: bool = False,
    ) -> dict[str, Any]:
        if not points:
            return {"upserted": 0, "dryRun": dry_run}

        if dry_run:
            return {"upserted": len(points), "dryRun": True}

        self.ensure_collection(reset=reset_collection)
        client = self._get_client()
        try:
            response = client.upsert(
                collection_name=self.settings.collection,
                points=self._to_points(points),
                wait=True,
            )
            status = getattr(response, "status", None)
            return {"upserted": len(points), "status": status}
        except Exception as exc:  # pragma: no cover - external failure path
            raise QdrantOperationError(f"failed to upsert reflections: {exc}") from exc

    def search(self, query_text: str, limit: int = 5) -> list[dict[str, Any]]:
        query_vector = default_embed(query_text, vector_size=self.settings.vector_size)
        client = self._get_client()

        self.ensure_collection(reset=False)
        try:
            if hasattr(client, "query_points"):
                response = client.query_points(
                    collection_name=self.settings.collection,
                    query=query_vector,
                    limit=limit,
                    with_payload=True,
                )
            else:
                response = client.search(
                    collection_name=self.settings.collection,
                    query_vector=query_vector,
                    limit=limit,
                    with_payload=True,
                )
        except Exception as exc:  # pragma: no cover - external failure path
            raise QdrantOperationError(f"failed to search reflections: {exc}") from exc

        payload_rows = getattr(response, "points", response)
        results: list[dict[str, Any]] = []
        for point in payload_rows:
            score = getattr(point, "score", None)
            payload = getattr(point, "payload", None)
            if isinstance(payload, dict):
                row = dict(payload)
                row.setdefault("id", getattr(point, "id", None))
            else:
                row = {"id": getattr(point, "id", None)}
            if score is not None:
                row["score"] = float(score)
            results.append(row)
        return results


def index_reflections_in_qdrant(
    db_path: str | Path,
    *,
    qdrant_url: str,
    collection: str,
    vector_size: int,
    limit: int | None,
    dry_run: bool,
    refresh: bool,
    timeout_seconds: float,
) -> dict[str, Any]:
    reflections = load_reflections_for_index(db_path, limit=limit)
    points = build_reflection_points(reflections, vector_size=vector_size)
    index = QdrantReflectionIndex(
        QdrantSettings(
            url=qdrant_url,
            collection=collection,
            vector_size=vector_size,
            timeout_seconds=timeout_seconds,
        )
    )

    result = index.upsert_reflections(
        points,
        reset_collection=refresh,
        dry_run=dry_run,
    )
    summary = {
        "collection": collection,
        "reflections": len(points),
        "dryRun": dry_run,
    }
    summary.update(result)
    return summary


def search_reflections_in_qdrant(
    query: str,
    *,
    qdrant_url: str,
    collection: str,
    vector_size: int,
    limit: int,
    timeout_seconds: float,
) -> dict[str, Any]:
    index = QdrantReflectionIndex(
        QdrantSettings(
            url=qdrant_url,
            collection=collection,
            vector_size=vector_size,
            timeout_seconds=timeout_seconds,
        )
    )
    hits = index.search(query, limit=limit)
    return {"query": query, "results": hits}
