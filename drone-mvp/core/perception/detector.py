from dataclasses import dataclass


@dataclass
class Detection:
    label: str
    confidence: float


class AnomalyDetector:
    def detect(self, semantic_labels: list[str]) -> Detection | None:
        for label in semantic_labels:
            if label.startswith("anomaly") or label in {"red_box", "threat_object"}:
                return Detection(label=label, confidence=0.95)
        return None
