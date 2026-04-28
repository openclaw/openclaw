from dataclasses import dataclass


@dataclass
class FlightCommand:
    vx: float = 0.0
    vy: float = 0.0
    vz: float = 0.0
    yaw_rate: float = 0.0


class DroneController:
    def arm(self) -> None:
        pass

    def takeoff(self, target_altitude: float) -> FlightCommand:
        return FlightCommand(vz=1.0)

    def land(self) -> FlightCommand:
        return FlightCommand(vz=-0.5)

    def hover(self) -> FlightCommand:
        return FlightCommand()
