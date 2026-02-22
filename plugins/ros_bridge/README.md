# ROS Bridge (plugin)

Minimal ROS2 bridge for OpenClaw-Guardian. Subscribes to a JSON state topic and publishes JSON commands. Designed to live entirely under `plugins/ros_bridge/` with no core changes.

## Topics
- **Subscribe**: `/device/state` (`std_msgs/String`) — JSON state payload (see `protocol_definition.json`).
- **Publish**: `/device/command` (`std_msgs/String`) — JSON command dict.

## Files
- `protocol_definition.json` — minimal state schema hints (required + optional keys).
- `state_preprocessor.py` — validation + downsampling (default 10 Hz) + optional summary.
- `latency_profiler.py` — optional rolling latency stats (disabled by default).
- `plugin.py` — ROS2 bridge entry points.

## Public API
```python
from plugins.ros_bridge import plugin as ros_bridge

ros_bridge.start_bridge({
    "state_callback": lambda state: print("state", state),
    # Optional overrides:
    # "node_name": "openclaw_ros_bridge",
    # "namespace": "",
    # "state_topic": "/device/state",
    # "command_topic": "/device/command",
    # "qos_depth": 10,
    # "state_max_rate_hz": 10.0,
})

ros_bridge.send_command({"action": "ping"})
ros_bridge.stop_bridge()
```

## Configuration
- **Node**: `node_name`, `namespace`
- **Topics**: `state_topic`, `command_topic`
- **QoS**: `qos_depth`
- **State preprocessing**: `state_max_rate_hz` (default 10), `state_include_summary` / `include_state_summary`
- **Callback**: `state_callback` (or `on_state`) — invoked with processed dict

## Profiling (optional, off by default)
Enable via config or env:
```python
ros_bridge.start_bridge({
    "profiling": {"enabled": True, "sample_size": 200, "log_interval_s": 5.0}
})
```
Or set one of:
- `OPENCLAW_ROS_BRIDGE_PROFILE=1`
- `OPENCLAW_ROS_BRIDGE_PROFILING=1`

When enabled, the profiler logs low-frequency `rx->pre`, `pre->pub`, and `rx->pub` latency stats.

## Notes / Limitations
- Requires `rclpy` and ROS2 runtime.
- `start_bridge` returns `False` if ROS is unavailable or initialization fails.
- JSON serialization uses `ensure_ascii=True` and rejects NaNs.
