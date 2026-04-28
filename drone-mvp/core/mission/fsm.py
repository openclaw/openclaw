from enum import Enum, auto


class MissionMode(Enum):
    IDLE = auto()
    TAKEOFF = auto()
    EXPLORE = auto()
    AVOID = auto()
    INVESTIGATE = auto()
    RETURN_HOME = auto()
    LAND = auto()


class MissionStateMachine:
    def __init__(self) -> None:
        self.mode = MissionMode.IDLE

    def start(self) -> None:
        self.mode = MissionMode.TAKEOFF

    def on_takeoff_complete(self) -> None:
        self.mode = MissionMode.EXPLORE

    def on_obstacle_detected(self) -> None:
        self.mode = MissionMode.AVOID

    def on_path_cleared(self) -> None:
        self.mode = MissionMode.EXPLORE

    def on_anomaly_detected(self) -> None:
        self.mode = MissionMode.INVESTIGATE

    def on_investigation_complete(self) -> None:
        self.mode = MissionMode.RETURN_HOME

    def on_home_reached(self) -> None:
        self.mode = MissionMode.LAND

    def on_landed(self) -> None:
        self.mode = MissionMode.IDLE
