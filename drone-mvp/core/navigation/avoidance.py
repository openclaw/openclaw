from core.control.controller import FlightCommand


class ObstacleAvoidance:
    def compute_avoidance(self, obstacle_distance_m: float, min_clearance_m: float = 1.0) -> FlightCommand | None:
        if obstacle_distance_m >= min_clearance_m:
            return None
        return FlightCommand(vx=-0.8, vy=0.6, vz=0.2)
