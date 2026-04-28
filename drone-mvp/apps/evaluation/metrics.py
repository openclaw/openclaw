from dataclasses import dataclass


@dataclass
class MissionMetrics:
    takeoff_success: bool
    waypoint_completion_rate: float
    collision_count: int
    anomaly_detected: bool
    returned_home: bool
