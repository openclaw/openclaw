from __future__ import annotations

import json
import logging
import os
import threading
from typing import Any, Callable, Dict, Optional

try:
    from .latency_profiler import LatencyProfiler
    from .state_preprocessor import StatePreprocessor
except ImportError:
    from latency_profiler import LatencyProfiler
    from state_preprocessor import StatePreprocessor

__all__ = ["start_bridge", "stop_bridge", "on_state_json", "send_command"]

try:
    import rclpy
    from rclpy.executors import SingleThreadedExecutor
    from rclpy.qos import QoSProfile
    from std_msgs.msg import String as RosString
except Exception as exc:
    rclpy = None
    SingleThreadedExecutor = None
    QoSProfile = None
    RosString = None
    _RCLPY_IMPORT_ERROR: Optional[BaseException] = exc
else:
    _RCLPY_IMPORT_ERROR = None

_LOGGER = logging.getLogger(__name__)
_PROFILE_ENV_VARS = ("OPENCLAW_ROS_BRIDGE_PROFILE", "OPENCLAW_ROS_BRIDGE_PROFILING")

StateCallback = Callable[[Dict[str, Any]], None]


def _coerce_str(value: Any, default: str) -> str:
    if isinstance(value, str):
        trimmed = value.strip()
        if trimmed:
            return trimmed
    return default


def _coerce_int(value: Any, default: int) -> int:
    try:
        val = int(value)
    except (TypeError, ValueError):
        return default
    if val <= 0:
        return default
    return val


def _is_truthy(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return value != 0
    if isinstance(value, str):
        return value.strip().lower() in {"1", "true", "t", "yes", "y", "on", "enabled"}
    return False


def _env_truthy() -> bool:
    for name in _PROFILE_ENV_VARS:
        if _is_truthy(os.getenv(name)):
            return True
    return False


def _resolve_profiler(config: Dict[str, Any], logger: logging.Logger) -> LatencyProfiler:
    prof_cfg = config.get("profiling")
    cfg_enabled: Optional[Any] = None
    sample_size: Optional[Any] = None
    log_interval_s: Optional[Any] = None

    if isinstance(prof_cfg, dict):
        cfg_enabled = prof_cfg.get("enabled")
        sample_size = prof_cfg.get("sample_size")
        log_interval_s = prof_cfg.get("log_interval_s")
    elif prof_cfg is not None:
        cfg_enabled = prof_cfg

    if cfg_enabled is None:
        cfg_enabled = config.get("enable_profiling")

    enabled = _is_truthy(cfg_enabled) or _env_truthy()

    if sample_size is None:
        sample_size = config.get("profiling_sample_size")
    if log_interval_s is None:
        log_interval_s = config.get("profiling_log_interval_s")

    return LatencyProfiler(
        enabled=enabled,
        sample_size=sample_size if sample_size is not None else 0,
        log_interval_s=log_interval_s if log_interval_s is not None else 0.0,
        logger=logger,
    )


class _RosBridge:
    def __init__(self, config: Dict[str, Any]) -> None:
        self._config = dict(config)
        logger = self._config.get("logger")
        self._logger = logger if isinstance(logger, logging.Logger) else _LOGGER

        state_cb = self._config.get("state_callback") or self._config.get("on_state")
        if state_cb is not None and not callable(state_cb):
            self._logger.warning("state_callback is not callable; ignoring")
            state_cb = None
        self._state_callback: Optional[StateCallback] = state_cb

        include_summary = bool(
            self._config.get("state_include_summary")
            or self._config.get("include_state_summary")
        )
        self._state_preprocessor = StatePreprocessor(
            max_rate_hz=self._config.get("state_max_rate_hz", 10.0),
            include_summary=include_summary,
        )
        self._profiler = _resolve_profiler(self._config, self._logger)

        self._node_name = _coerce_str(self._config.get("node_name"), "openclaw_ros_bridge")
        self._namespace = _coerce_str(self._config.get("namespace"), "")
        self._state_topic = _coerce_str(self._config.get("state_topic"), "/device/state")
        self._command_topic = _coerce_str(self._config.get("command_topic"), "/device/command")
        self._qos_depth = _coerce_int(self._config.get("qos_depth"), 10)

        self._lock = threading.Lock()
        self._state_lock = threading.Lock()
        self._started = False
        self._owns_rclpy = False

        self._node = None
        self._publisher = None
        self._subscription = None
        self._executor = None
        self._thread = None

    def start(self) -> bool:
        with self._lock:
            if self._started:
                return True

            if rclpy is None:
                if _RCLPY_IMPORT_ERROR is not None:
                    self._logger.error("rclpy import failed: %s", _RCLPY_IMPORT_ERROR)
                else:
                    self._logger.error("rclpy is not available")
                return False

            try:
                if not rclpy.ok():
                    rclpy.init()
                    self._owns_rclpy = True
                else:
                    self._owns_rclpy = False

                node_kwargs: Dict[str, Any] = {}
                if self._namespace:
                    node_kwargs["namespace"] = self._namespace

                self._node = rclpy.create_node(self._node_name, **node_kwargs)
                qos_profile = QoSProfile(depth=self._qos_depth)

                self._publisher = self._node.create_publisher(
                    RosString, self._command_topic, qos_profile
                )
                self._subscription = self._node.create_subscription(
                    RosString, self._state_topic, self._handle_state_message, qos_profile
                )

                self._executor = SingleThreadedExecutor()
                self._executor.add_node(self._node)

                self._thread = threading.Thread(
                    target=self._executor.spin,
                    name="ros-bridge",
                    daemon=True,
                )
                self._thread.start()
                self._started = True
                return True
            except Exception:
                self._logger.exception("Failed to start ROS bridge")
                self._teardown()
                return False

    def stop(self) -> None:
        self._teardown()

    def _teardown(self) -> None:
        with self._lock:
            executor = self._executor
            node = self._node
            thread = self._thread
            owns_rclpy = self._owns_rclpy

            self._executor = None
            self._node = None
            self._publisher = None
            self._subscription = None
            self._thread = None
            self._started = False
            self._owns_rclpy = False

        if executor is not None:
            try:
                executor.shutdown()
            except Exception:
                self._logger.exception("Failed to shutdown ROS executor")

        if thread is not None:
            thread.join(timeout=2.0)

        if node is not None:
            try:
                node.destroy_node()
            except Exception:
                self._logger.exception("Failed to destroy ROS node")

        if owns_rclpy and rclpy is not None:
            try:
                if rclpy.ok():
                    rclpy.shutdown()
            except Exception:
                self._logger.exception("Failed to shutdown rclpy")

    def _handle_state_message(self, msg: RosString) -> None:
        self.on_state_json(msg.data)

    def on_state_json(self, state_json_str: Any) -> Optional[Dict[str, Any]]:
        if not self._started:
            return None

        if isinstance(state_json_str, bytes):
            try:
                state_json_str = state_json_str.decode("utf-8")
            except UnicodeDecodeError:
                return None

        trace_id = self._profiler.mark_rx()
        try:
            with self._state_lock:
                processed = self._state_preprocessor.process(state_json_str)
        except Exception:
            self._logger.exception("State preprocessor failure")
            return None

        self._profiler.mark_preprocess(trace_id)

        if processed is None:
            return None

        if self._state_callback is not None:
            try:
                self._state_callback(processed)
            except Exception:
                self._logger.exception("State callback failed")

        self._profiler.mark_publish(trace_id)
        return processed

    def send_command(self, command_dict: Any) -> bool:
        if not self._started:
            return False
        if not isinstance(command_dict, dict):
            self._logger.warning("command_dict must be a dict")
            return False

        try:
            payload = json.dumps(
                command_dict,
                separators=(",", ":"),
                ensure_ascii=True,
                allow_nan=False,
            )
        except (TypeError, ValueError) as exc:
            self._logger.warning("Failed to serialize command JSON: %s", exc)
            return False

        with self._lock:
            publisher = self._publisher
            if publisher is None:
                return False
            try:
                publisher.publish(RosString(data=payload))
            except Exception:
                self._logger.exception("Failed to publish ROS command")
                return False
        return True


_BRIDGE_LOCK = threading.Lock()
_BRIDGE: Optional[_RosBridge] = None


def start_bridge(config: Optional[Dict[str, Any]] = None) -> bool:
    cfg: Dict[str, Any]
    if config is None:
        cfg = {}
    elif isinstance(config, dict):
        cfg = config
    else:
        _LOGGER.warning("start_bridge expected dict config; got %s", type(config).__name__)
        cfg = {}

    global _BRIDGE
    with _BRIDGE_LOCK:
        if _BRIDGE is not None:
            return True
        bridge = _RosBridge(cfg)
        if not bridge.start():
            return False
        _BRIDGE = bridge
        return True


def stop_bridge() -> bool:
    global _BRIDGE
    with _BRIDGE_LOCK:
        bridge = _BRIDGE
        _BRIDGE = None

    if bridge is None:
        return False
    bridge.stop()
    return True


def on_state_json(state_json_str: Any) -> Optional[Dict[str, Any]]:
    bridge = _BRIDGE
    if bridge is None:
        return None
    return bridge.on_state_json(state_json_str)


def send_command(command_dict: Any) -> bool:
    bridge = _BRIDGE
    if bridge is None:
        _LOGGER.warning("ROS bridge not running; command dropped")
        return False
    return bridge.send_command(command_dict)
