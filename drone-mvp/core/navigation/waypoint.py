from dataclasses import dataclass
from math import sqrt

from core.control.controller import FlightCommand


@dataclass
class Pose3D:
    x: float
    y: float
    z: float


class WaypointFollower:
    def compute_command(self, current: Pose3D, target: Pose3D, max_speed: float = 2.0) -> FlightCommand:
        dx = target.x - current.x
        dy = target.y - current.y
        dz = target.z - current.z
        dist = max(sqrt(dx * dx + dy * dy + dz * dz), 1e-6)
        scale = min(max_speed / dist, 1.0)
        return FlightCommand(vx=dx * scale, vy=dy * scale, vz=dz * scale)

    def reached(self, current: Pose3D, target: Pose3D, tolerance: float = 0.4) -> bool:
        dx = target.x - current.x
        dy = target.y - current.y
        dz = target.z - current.z
        return sqrt(dx * dx + dy * dy + dz * dz) <= tolerance
