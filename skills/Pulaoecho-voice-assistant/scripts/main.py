#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
主启动脚本
启动WebSocket服务器和voice_assistant，通过AudioBridge连接
"""

import asyncio
import json
import logging
import os
import signal
import ssl
import sys
import threading

from audio_bridge import AudioBridge
from voice_assistant_remote import VoiceAssistantRemote
from websocket_audio_server import WebSocketAudioServer

# ─── 加载配置文件 ────────────────────────────────────────────────────────────────
_CONFIG_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "config.json")

def _load_config(path: str) -> dict:
    """加载 config.json，找不到时返回空 dict（使用各组件默认值）"""
    path = os.path.abspath(path)
    if not os.path.exists(path):
        print(f"[Main] config.json not found at {path}, using defaults", flush=True)
        return {}
    with open(path, encoding="utf-8") as f:
        cfg = json.load(f)
    print(f"[Main] Loaded config from {path}", flush=True)
    return cfg

config = _load_config(_CONFIG_PATH)

# ─── 统一日志配置 ────────────────────────────────────────────────────────────────
_log_cfg   = config.get("logging", {})
_log_level = getattr(logging, _log_cfg.get("level", "INFO").upper(), logging.INFO)
_raw_path  = _log_cfg.get("file", "~/.openclaw/logs/pulaoecho-voice-assistant.log")
_log_path  = os.path.expanduser(_raw_path)
os.makedirs(os.path.dirname(_log_path), exist_ok=True)

_fmt = logging.Formatter(
    fmt="%(asctime)s.%(msecs)03d [%(name)-7s] [%(levelname)-5s] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S"
)
_file_handler = logging.FileHandler(_log_path, encoding="utf-8")
_file_handler.setFormatter(_fmt)
_stream_handler = logging.StreamHandler(sys.stdout)
_stream_handler.setFormatter(_fmt)

root_logger = logging.getLogger()
root_logger.setLevel(logging.DEBUG)          # 全局 DEBUG，handler 级别控制输出
_file_handler.setLevel(_log_level)
_stream_handler.setLevel(_log_level)
root_logger.addHandler(_file_handler)
root_logger.addHandler(_stream_handler)

# 抑制 websockets / urllib3 内部 DEBUG 噪音
logging.getLogger("websockets").setLevel(logging.WARNING)
logging.getLogger("urllib3").setLevel(logging.WARNING)

logger = logging.getLogger("Main")
# ────────────────────────────────────────────────────────────────────────────────

# 全局变量
bridge = None
server = None
assistant = None
stop_event = threading.Event()


def signal_handler(sig, frame):
    """处理Ctrl+C信号"""
    logger.info("[Main] Shutting down...")
    stop_event.set()
    if assistant:
        assistant.stop_flag.set()
    if bridge:
        bridge.stop_send_thread()
    sys.exit(0)


def run_voice_assistant(bridge: AudioBridge):
    """在独立线程中运行voice_assistant"""
    global assistant
    assistant = VoiceAssistantRemote(bridge, config)

    threads = [
        threading.Thread(target=assistant.recording_thread, daemon=True, name="Recording"),
        threading.Thread(target=assistant.execution_thread, daemon=True, name="Execution"),
        threading.Thread(target=assistant.tts_thread, daemon=True, name="TTS")
    ]
    for t in threads:
        t.start()
    logger.info("[Main] Voice assistant threads started")

    while not stop_event.is_set():
        stop_event.wait(1)


async def main():
    """主函数"""
    global bridge, server

    _srv = config.get("server", {})
    host = _srv.get("host", "0.0.0.0")
    port = _srv.get("port", 18181)

    # TLS/SSL 配置
    ssl_context = None
    _tls = _srv.get("tls", {})
    if _tls.get("enabled", False):
        cert = os.path.expanduser(_tls.get("certFile", ""))
        key  = os.path.expanduser(_tls.get("keyFile", ""))
        if not cert or not key:
            logger.error("[Main] TLS enabled but certFile/keyFile not set in config")
            sys.exit(1)
        if not os.path.exists(cert):
            logger.error(f"[Main] TLS cert not found: {cert}")
            sys.exit(1)
        if not os.path.exists(key):
            logger.error(f"[Main] TLS key not found: {key}")
            sys.exit(1)
        ssl_context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        ssl_context.load_cert_chain(cert, key)
        logger.info(f"[Main] TLS enabled, cert={cert}")

    logger.info("=" * 60)
    logger.info("Pulaoecho Remote Audio Voice Assistant")
    logger.info("=" * 60)
    logger.info(f"[Main] Config: {_CONFIG_PATH}")
    logger.info(f"[Main] Log: {_log_path}")

    signal.signal(signal.SIGINT, signal_handler)
    signal.signal(signal.SIGTERM, signal_handler)

    bridge = AudioBridge()
    logger.info("[Main] AudioBridge created")

    # 从配置文件中读取密码
    password = _srv.get("password", "pulaoecho_secure_password_2026")
    server = WebSocketAudioServer(host=host, port=port, ssl_context=ssl_context, password=password)
    server.set_audio_bridge(bridge)
    logger.info("[Main] WebSocket server created")

    va_thread = threading.Thread(target=run_voice_assistant, args=(bridge,), daemon=True)
    va_thread.start()
    logger.info("[Main] Voice assistant thread started")

    logger.info("[Main] Starting WebSocket server...")
    await server.start()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        logger.info("[Main] Stopped")
