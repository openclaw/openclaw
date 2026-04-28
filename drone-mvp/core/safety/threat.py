def compute_threat_score(
    object_risk: float,
    proximity_risk: float,
    zone_violation: float,
    motion_risk: float,
    anomaly_confidence: float,
) -> float:
    return (
        0.35 * object_risk
        + 0.20 * proximity_risk
        + 0.20 * zone_violation
        + 0.15 * motion_risk
        + 0.10 * anomaly_confidence
    )
