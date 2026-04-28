from core.control.controller import DroneController
from core.mission.fsm import MissionStateMachine
from core.navigation.avoidance import ObstacleAvoidance
from core.navigation.waypoint import Pose3D, WaypointFollower
from core.perception.detector import AnomalyDetector


class SimRunner:
    def __init__(self) -> None:
        self.controller = DroneController()
        self.mission = MissionStateMachine()
        self.waypoints = [
            Pose3D(0.0, 0.0, 3.0),
            Pose3D(5.0, 0.0, 3.0),
            Pose3D(5.0, 5.0, 3.0),
        ]
        self.waypoint_follower = WaypointFollower()
        self.avoidance = ObstacleAvoidance()
        self.detector = AnomalyDetector()

    def run(self) -> None:
        self.mission.start()
        print(f"Mission started: {self.mission.mode.name}")
        print("This is a scaffold runner. Isaac Sim integration will plug in here.")


if __name__ == "__main__":
    SimRunner().run()
