from __future__ import annotations

import json
from dataclasses import dataclass
from math import sqrt
from typing import Iterable

try:
    from sentence_transformers import SentenceTransformer  # type: ignore
except Exception:  # pragma: no cover - optional dependency
    SentenceTransformer = None


@dataclass(slots=True)
class EmbeddingBackend:
    model_name: str | None = None
    _model: object | None = None

    @classmethod
    def load(cls, model_name: str | None = None) -> "EmbeddingBackend":
        if SentenceTransformer is None or not model_name:
            return cls(model_name=None, _model=None)
        return cls(model_name=model_name, _model=SentenceTransformer(model_name))

    @property
    def available(self) -> bool:
        return self._model is not None

    def encode(self, texts: Iterable[str]) -> list[list[float]] | None:
        if self._model is None:
            return None
        vectors = self._model.encode(list(texts), normalize_embeddings=True)
        return json.loads(json.dumps(vectors.tolist()))


def cosine_similarity(left: list[float], right: list[float]) -> float:
    if len(left) != len(right) or not left:
        return 0.0
    dot = sum(a * b for a, b in zip(left, right))
    left_norm = sqrt(sum(a * a for a in left))
    right_norm = sqrt(sum(b * b for b in right))
    if left_norm == 0.0 or right_norm == 0.0:
        return 0.0
    return dot / (left_norm * right_norm)
