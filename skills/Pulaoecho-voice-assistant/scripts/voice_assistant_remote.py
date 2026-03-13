#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
远程音频设备语音助手
基于local-voice-assistant，适配AudioBridge架构
"""
import io
import json
import logging
import os
import queue
import re
import sys
import threading
import time
import traceback
import uuid
from typing import List, Optional

sys.stdout.reconfigure(line_buffering=True)
sys.stderr.reconfigure(line_buffering=True)

logger = logging.getLogger('VA')

# 导入音频桥接器
from audio_bridge import AudioBridge

# 导入阿里云语音识别引擎
try:
    from aliyunasrengine import AliyunASREngine
    has_aliyun_asr = True
except ImportError:
    has_aliyun_asr = False
    logger.warning("AliyunASREngine not found.")

# 导入Sherpa-ONNX语音识别引擎
try:
    from sherpaonnxasrengine import SherpaONNXASREngine
    has_sherpa_onnx = True
except ImportError:
    has_sherpa_onnx = False
    logger.warning("SherpaONNXASREngine not found.")

# 尝试导入websocket库
try:
    import websocket
    has_websocket = True
except ImportError:
    has_websocket = False
    logger.warning("websocket-client library not found.")

# 尝试导入VAD库
try:
    import webrtcvad
    has_vad = True
except ImportError:
    has_vad = False
    logger.warning("webrtcvad not found. pip install webrtcvad")

# 尝试导入TTS库
try:
    from gtts import gTTS
    from pydub import AudioSegment
    has_tts = True
except ImportError:
    has_tts = False
    logger.warning("gTTS or pydub not found.")

# 特殊队列消息
INTERRUPT_SIGNAL = "__INTERRUPT__"


class SpeechRecognizer:
    """统一的语音识别接口，支持阿里云ASR和Sherpa-ONNX"""
    
    def __init__(self, api_key: str = None, model: str = None, hotwords: Optional[List[str]] = None, 
                 language: str = "en", asr_engine: str = "aliyun", model_dir: str = None,
                 encoder: str = "encoder.onnx", decoder: str = "decoder.onnx", tokens: str = "tokens.txt"):
        """初始化语音识别器
        
        Args:
            api_key: 阿里云API密钥（仅用于aliyun引擎）
            model: 阿里云模型名称（仅用于aliyun引擎）
            hotwords: 热词列表
            language: 识别语言
            asr_engine: 识别引擎，"aliyun" 或 "sherpa-onnx"
            model_dir: Sherpa-ONNX模型目录（仅用于sherpa-onnx引擎）
            encoder: Sherpa-ONNX encoder文件名
            decoder: Sherpa-ONNX decoder文件名
            tokens: Sherpa-ONNX tokens文件名
        """
        self.asr_engine = asr_engine
        
        if asr_engine == "sherpa-onnx":
            self._engine = SherpaONNXASREngine(model_dir, hotwords, language, encoder, decoder, tokens) if has_sherpa_onnx else None
            if not has_sherpa_onnx:
                logger.error("SherpaONNXASREngine not available")
        else:  # aliyun
            self._engine = AliyunASREngine(api_key, model, hotwords, language) if has_aliyun_asr else None
            if not has_aliyun_asr:
                logger.error("AliyunASREngine not available")

    def submit(self, pcm: bytes, req_id: str, on_result):
        """提交一段 PCM 进行识别。立刻返回，结果异步回调。

        on_result(req_id: str, text: str | None)
          text=None 表示未识别到语音或出错。
        """
        if not has_aliyun_asr or self._engine is None:
            on_result(req_id, None)
            return
        
        # 直接调用阿里云ASR引擎的submit方法（已经是异步的）
        self._engine.submit(pcm, req_id, on_result)

class VoiceAssistantRemote:
    """远程音频设备语音助手"""
    
    def __init__(self, audio_bridge: AudioBridge, config: dict = None):
        # 音频桥接器
        self.audio_bridge = audio_bridge
        cfg = config or {}

        # WebSocket配置 - 从 config 读取，fallback 到硬编码默认值
        _oc = cfg.get("openclaw", {})
        self.ws_url = _oc.get("url", "ws://127.0.0.1:18789")
        self.token = self._load_token(_oc.get("tokenPath", ""))

        # 唤醒词列表
        self.wake_words: list[str] = [
            w.lower() for w in cfg.get("wakeWords", ["hi claw", "hey claw", "hi google", "hey google"])
        ]
        
        # 阿里云ASR配置
        _asr = cfg.get("aliyunASR", {})
        asr_api_key = _asr.get("apiKey", "")
        asr_model = _asr.get("model", "qwen3-asr-flash")
        asr_language = _asr.get("language", "auto")  # auto/en/zh
        
        # Sherpa-ONNX配置
        _sherpa = cfg.get("sherpaONNX", {})
        asr_engine = cfg.get("asrEngine", "aliyun")  # aliyun/sherpa-onnx
        model_dir = _sherpa.get("modelDir", "")
        sherpa_encoder = _sherpa.get("encoder", "encoder.onnx")
        sherpa_decoder = _sherpa.get("decoder", "decoder.onnx")
        sherpa_tokens = _sherpa.get("tokens", "tokens.txt")
        
        # 线程间通信队列
        self.task_queue = queue.Queue()      # 录音线程 → 执行线程
        self.speak_queue = queue.Queue()     # 执行线程 → TTS线程
        
        # 中断控制
        self.generation = 0
        self.generation_lock = threading.Lock()
        self.current_ws = None
        
        # 全局停止
        self.stop_flag = threading.Event()
        
        # 异步语音识别器（支持阿里云ASR和Sherpa-ONNX，传入唤醒词作为热词）
        self._asr = SpeechRecognizer(api_key=asr_api_key, model=asr_model, hotwords=self.wake_words, 
                                    language=asr_language, asr_engine=asr_engine, model_dir=model_dir,
                                    encoder=sherpa_encoder, decoder=sherpa_decoder, tokens=sherpa_tokens)
        # 识别结果回传队列：(req_id, text_or_None)
        self._asr_result_q: queue.Queue = queue.Queue()
        
        # 唤醒状态管理
        self.awakened_time = 0  # 记录进入唤醒状态的时间
        self.AWAKENED_TIMEOUT = 30  # 唤醒状态超时时间（秒）
        
        logger.info(f"[Init] ws_url={self.ws_url}, wake_words={self.wake_words}")
        if asr_engine == "sherpa-onnx":
            logger.info(f"[Init] Sherpa-ONNX: model_dir={model_dir}, language={asr_language}, hotwords={self.wake_words}")
        else:
            logger.info(f"[Init] AliyunASR: model={asr_model}, language={asr_language}, hotwords={self.wake_words}")
        logger.info("[Init] Remote voice assistant initialized")

    @staticmethod
    def _load_token(token_path: str) -> str:
        """从 tokenPath 文件读取 token；失败时抛出异常。"""
        if not token_path:
            raise ValueError("Token path not configured. Please set 'tokenPath' in config.json")
        
        path = os.path.expanduser(token_path)
        try:
            with open(path, encoding="utf-8") as f:
                data = json.load(f)
            # 尝试多个可能的 token 字段位置
            token = (
                data.get("token") or 
                data.get("accessToken") or 
                data.get("apiKey") or
                (data.get("gateway", {}).get("auth", {}).get("token"))  # OpenClaw 新格式
            )
            if token:
                logger.info(f"[Init] Token loaded from {path}: {token[:8]}...")
                return token
            else:
                raise ValueError(f"No token found in {path}. Please check your token file format.")
        except FileNotFoundError:
            raise FileNotFoundError(f"Token file not found: {path}. Please ensure the file exists.")
        except Exception as e:
            raise RuntimeError(f"Failed to read token from {path}: {e}")

    def _increment_generation(self):
        """递增generation，表示新的唤醒"""
        with self.generation_lock:
            self.generation += 1
            return self.generation
    
    def _get_generation(self):
        """获取当前generation"""
        with self.generation_lock:
            return self.generation
    
    # =========================================================================
    # 录音线程 - VAD 切割，异步 ASR
    # =========================================================================
    def recording_thread(self):
        """录音线程：VAD 切割语音片段，提交 SpeechRecognizer 异步识别，永不阻塞。"""
        logger.info("[Recording] Thread started (remote audio mode)")

        if not (has_aliyun_asr or has_sherpa_onnx):
            logger.error("[Recording] No ASR engine available")
            return

        # ── VAD 配置 ──────────────────────────────────────────────────────
        SAMPLE_RATE  = 16000
        FRAME_MS     = 20
        FRAME_BYTES  = SAMPLE_RATE * 2 * FRAME_MS // 1000  # 640 bytes / 20ms frame
        SILENCE_FRAMES_WAITING  = 8   # 8×20ms = 160ms 静音触发识别
        SILENCE_FRAMES_AWAKENED = 6   # 6×20ms = 120ms 静音触发识别（更快）
        MIN_SPEECH_FRAMES = 8         # < 160ms 视为噪声，忽略
        QUEUE_TIMEOUT = 1.5           # 秒，设备无音频视为静音

        vad = webrtcvad.Vad(2) if has_vad else None

        # ── 录音状态 ──────────────────────────────────────────────────────
        rec_state      = "waiting"   # waiting / awakened
        collected_text: list[str] = []

        # ── VAD 状态 ──────────────────────────────────────────────────────
        speech_frames: list[bytes] = []
        speech_frame_count = 0
        silence_frame_count = 0
        in_speech = False
        frame_buf = bytearray()

        # 记录每个 req_id 提交时的状态快照，用于结果回调时匹配
        # {req_id: (snapshot_state, snapshot_collected, device_id)}
        pending: dict[str, tuple] = {}
        pending_lock = threading.Lock()

        def _on_asr_result(req_id: str, text):
            """ASR 识别完成回调（在识别线程中执行）。"""
            with pending_lock:
                snapshot = pending.pop(req_id, None)
            if snapshot is None:
                return  # 已被唤醒打断，丢弃
            snapshot_state, snapshot_collected, snapshot_device_id = snapshot

            if text is None:
                if snapshot_state == "awakened" and snapshot_collected:
                    # 静音后无新内容，提交已有内容
                    question = " ".join(snapshot_collected)
                    logger.info(f"[Recording] Question complete (silence): {question}")
                    self.task_queue.put(question)
                    self._asr_result_q.put(("waiting", []))
                else:
                    logger.debug(f"[ASR] No speech, state unchanged")
                    self._asr_result_q.put((snapshot_state, snapshot_collected))
                return

            text_lower = text.lower()
            if any(w in text_lower for w in self.wake_words):
                # 检查当前状态，如果已经是唤醒状态，跳过重复唤醒
                if snapshot_state == "awakened":
                    logger.debug(f"[Recording] Already awakened, skipping wake word: {text}")
                    self._asr_result_q.put((snapshot_state, snapshot_collected))
                    return
                    
                logger.info(f"[Recording] Wake word detected: {text}")
                
                # 设置活动设备为发送该音频的设备（使用快照中的device_id）
                if snapshot_device_id:
                    self.audio_bridge.set_active_device(snapshot_device_id)
                    logger.info(f"[Recording] Active device set to: {snapshot_device_id}")
                
                current_gen = self._increment_generation()
                # 清空所有 pending 识别（旧的都失效）
                with pending_lock:
                    pending.clear()
                self.audio_bridge.recv_queue.clear()
                self.audio_bridge.send_signal(snapshot_device_id, "wakeup")
                self.task_queue.put(INTERRUPT_SIGNAL)
                self.speak_queue.put(INTERRUPT_SIGNAL)
                
                # 提取唤醒词之后的命令部分
                command = text
                for wake_word in self.wake_words:
                    if wake_word in text_lower:
                        # 找到唤醒词在文本中的位置
                        idx = text_lower.find(wake_word)
                        if idx != -1:
                            # 提取唤醒词之后的部分作为命令
                            command = text[idx + len(wake_word):].strip()
                            break
                
                if command:
                    # 如果有命令部分，直接提交
                    logger.info(f"[Recording] Command extracted: {command}")
                    # 提交命令时带上当前generation，确保不会被后续的唤醒打断
                    self.task_queue.put(command)
                    self._asr_result_q.put(("waiting", []))
                else:
                    # 没有命令部分，进入唤醒状态等待命令
                    # 唤醒状态的时间记录由录音线程主循环处理
                    self._asr_result_q.put(("awakened", []))

            elif snapshot_state == "awakened":
                # 在 awakened 状态收到命令时，也要确保活动设备正确
                if snapshot_device_id:
                    self.audio_bridge.set_active_device(snapshot_device_id)
                    logger.debug(f"[Recording] Active device confirmed: {snapshot_device_id}")
                
                new_collected = snapshot_collected + [text]
                logger.info(f"[Recording] Collected: {text}")
                question = " ".join(new_collected)
                logger.info(f"[Recording] Question complete: {question}")
                self.task_queue.put(question)
                self._asr_result_q.put(("waiting", []))

            else:
                # waiting 状态收到非唤醒词，忽略
                self._asr_result_q.put((snapshot_state, snapshot_collected))

        def _submit(pcm: bytes):
            """提交一段语音给 ASR，记录 pending 状态快照。"""
            req_id = str(uuid.uuid4())
            # 保存当前设备ID快照，确保识别结果返回时使用正确的设备
            current_device_id = self.audio_bridge.last_audio_device_id
            with pending_lock:
                pending[req_id] = (rec_state, list(collected_text), current_device_id)
            self._asr.submit(pcm, req_id, _on_asr_result)
            logger.debug(f"[Recording] ASR submitted req={req_id[:8]} state={rec_state} device={current_device_id}")

        while not self.stop_flag.is_set():
            # ── 消费异步 ASR 结果（非阻塞）────────────────────────────
            while not self._asr_result_q.empty():
                try:
                    rec_state, collected_text = self._asr_result_q.get_nowait()
                    # 如果进入唤醒状态，记录时间
                    if rec_state == "awakened":
                        self.awakened_time = time.time()
                except queue.Empty:
                    break
            
            # ── 唤醒状态超时检查 ─────────────────────────────────────
            if rec_state == "awakened" and self.awakened_time > 0 and time.time() - self.awakened_time > self.AWAKENED_TIMEOUT:
                logger.info("[Recording] Awakened state timeout, returning to waiting")
                rec_state = "waiting"
                collected_text = []
                self.awakened_time = 0  # 重置唤醒时间

            # ── 取一个 80ms 包 ──────────────────────────────────────────
            packet = self.audio_bridge.get_audio_packet(timeout=QUEUE_TIMEOUT)

            if packet is None:
                # 设备无音频：冲刷当前语音片段
                if in_speech and speech_frame_count >= MIN_SPEECH_FRAMES:
                    pcm = b"".join(speech_frames)
                    logger.debug(f"[Recording] Timeout flush {len(pcm)} bytes")
                    _submit(pcm)
                speech_frames = []
                speech_frame_count = 0
                silence_frame_count = 0
                in_speech = False
                continue

            # 解包 (device_id, data) 元组
            device_id, audio_data = packet
            # 更新 last_audio_device_id（兼容层）
            self.audio_bridge.last_audio_device_id = device_id
            
            frame_buf.extend(audio_data)

            # ── 按 20ms 帧逐帧 VAD ─────────────────────────────────────
            while len(frame_buf) >= FRAME_BYTES:
                frame = bytes(frame_buf[:FRAME_BYTES])
                frame_buf = frame_buf[FRAME_BYTES:]

                if vad:
                    try:
                        is_speech = vad.is_speech(frame, SAMPLE_RATE)
                    except Exception:
                        is_speech = True
                else:
                    is_speech = True  # 无 VAD：所有帧视为语音（退化模式）

                if is_speech:
                    if not in_speech:
                        in_speech = True
                        logger.debug("[Recording] Speech start")
                    speech_frames.append(frame)
                    speech_frame_count += 1
                    silence_frame_count = 0
                elif in_speech:
                    speech_frames.append(frame)  # 保留尾部静音帧
                    silence_frame_count += 1

                    silence_limit = (SILENCE_FRAMES_AWAKENED
                                     if rec_state == "awakened"
                                     else SILENCE_FRAMES_WAITING)

                    if silence_frame_count >= silence_limit:
                        if speech_frame_count >= MIN_SPEECH_FRAMES:
                            pcm = b"".join(speech_frames)
                            logger.debug(f"[Recording] Speech end {len(pcm)} bytes ({speech_frame_count} frames)")
                            _submit(pcm)
                        else:
                            logger.debug(f"[Recording] Noise ignored ({speech_frame_count} frames)")
                        speech_frames = []
                        speech_frame_count = 0
                        silence_frame_count = 0
                        in_speech = False

        logger.info("[Recording] Thread stopped")

    # =========================================================================
    # 执行线程 - 查询OpenClaw
    # =========================================================================
    def execution_thread(self):
        """执行线程：接收问题，查询OpenClaw"""
        logger.info("[Execution] Thread started")
        
        while not self.stop_flag.is_set():
            try:
                question = self.task_queue.get(timeout=1.0)
                
                if question == INTERRUPT_SIGNAL:
                    # 中断信号
                    if self.current_ws:
                        try:
                            self.current_ws.close()
                        except:
                            pass
                        self.current_ws = None
                    continue
                
                # 记住当前generation
                my_gen = self._get_generation()
                
                logger.info(f"[Execution] Processing question: {question}")
                
                # 发送process信号（使用活动设备）
                if self.audio_bridge.active_device_id:
                    self.audio_bridge.send_signal(self.audio_bridge.active_device_id, "process")
                
                # 查询OpenClaw
                answer = self._query_openclaw(question, my_gen)
                
                # 检查是否被打断
                if self._get_generation() != my_gen:
                    logger.info("[Execution] Interrupted, discarding result")
                    continue
                
                if answer:
                    logger.info(f"[Execution] Got answer: {answer[:100]}...")
                    
                    # 发送feedback信号（使用活动设备）
                    if self.audio_bridge.active_device_id:
                        self.audio_bridge.send_signal(self.audio_bridge.active_device_id, "feedback")
                    
                    # 发送给TTS线程
                    self.speak_queue.put((answer, my_gen))
                else:
                    logger.warning("[Execution] No answer received")
                    
            except queue.Empty:
                continue
            except Exception as e:
                logger.error(f"[Execution] Error: {e}")
                logger.debug(traceback.format_exc())
        
        logger.info("[Execution] Thread stopped")
    
    def _query_openclaw(self, question: str, my_gen: int) -> str:
        """查询OpenClaw"""
        if not has_websocket:
            return "WebSocket library not available"
        
        logger.info(f"[OpenClaw] Querying with: {question[:60]}...")
        
        try:
            ws = websocket.create_connection(self.ws_url, timeout=5)
            self.current_ws = ws
            
            # 接收challenge
            challenge = json.loads(ws.recv())
            if challenge.get("type") != "event" or challenge.get("event") != "connect.challenge":
                ws.close()
                return "连接失败"
            
            # 发送connect请求
            connect_req = {
                "type": "req",
                "id": str(uuid.uuid4()),
                "method": "connect",
                "params": {
                    "minProtocol": 3,
                    "maxProtocol": 3,
                    "client": {"id": "cli", "version": "1.0.0", "platform": "darwin", "mode": "cli"},
                    "role": "operator",
                    "scopes": ["operator.admin"],
                    "caps": [],
                    "commands": [],
                    "permissions": {},
                    "auth": {"token": self.token}
                }
            }
            ws.send(json.dumps(connect_req))
            
            connect_resp = json.loads(ws.recv())
            if not connect_resp.get("ok"):
                ws.close()
                return "认证失败"
            
            # 发送agent请求
            agent_req_id = str(uuid.uuid4())
            agent_req = {
                "type": "req",
                "id": agent_req_id,
                "method": "agent",
                "params": {
                    "message": question,
                    "idempotencyKey": str(uuid.uuid4()),
                    "sessionKey": f"remote_{int(time.time() * 1000)}"
                }
            }
            ws.send(json.dumps(agent_req))
            
            # 等待响应
            timeout = 60
            start_time = time.time()
            
            while time.time() - start_time < timeout:
                # 检查是否被打断
                if self._get_generation() != my_gen:
                    ws.close()
                    self.current_ws = None
                    return None
                
                try:
                    ws.settimeout(0.5)
                    msg = json.loads(ws.recv())
                    
                    msg_type = msg.get("type")
                    msg_id = msg.get("id")
                    
                    # 记录所有收到的消息类型
                    logger.debug(f"[OpenClaw] Received message: type={msg_type}, id={msg_id[:8] if msg_id else 'None'}")
                    
                    # 跳过心跳消息
                    if msg_type == "heartbeat":
                        logger.debug("[OpenClaw] Received heartbeat, skipping")
                        continue
                    
                    # 只处理匹配的响应
                    if msg_type == "res" and msg_id == agent_req_id:
                        if msg.get("ok"):
                            payload = msg.get("payload", {})
                            status = payload.get("status")
                            
                            logger.debug(f"[OpenClaw] Response status: {status}")
                            
                            if status == "ok" and "result" in payload:
                                result = payload["result"]
                                if "payloads" in result and len(result["payloads"]) > 0:
                                    response = result["payloads"][0].get("text", "")
                                    if response:  # 确保响应不为空
                                        logger.info(f"[OpenClaw] Got answer: {response[:50]}...")
                                        ws.close()
                                        self.current_ws = None
                                        return response
                                    else:
                                        logger.warning("[OpenClaw] Empty response text")
                                else:
                                    logger.warning("[OpenClaw] No payloads in result")
                            elif status == "accepted":
                                logger.debug("[OpenClaw] Request accepted, waiting for result...")
                                continue
                            else:
                                logger.warning(f"[OpenClaw] Unexpected status: {status}")
                        else:
                            error = msg.get("error", {}).get("message", "Unknown error")
                            logger.error(f"[OpenClaw] Error response: {error}")
                            ws.close()
                            self.current_ws = None
                            return f"错误: {error}"
                    else:
                        # 其他消息类型，记录但不处理
                        if msg_type:
                            logger.debug(f"[OpenClaw] Ignoring message: type={msg_type}, id={msg_id}, expected_id={agent_req_id[:8]}")
                            # 如果是 event 类型，记录 event 名称
                            if msg_type == "event":
                                event_name = msg.get("event")
                                logger.debug(f"[OpenClaw] Event: {event_name}")
                            
                except websocket.WebSocketTimeoutException:
                    continue
            
            ws.close()
            self.current_ws = None
            return "请求超时"
            
        except Exception as e:
            logger.error(f"[OpenClaw] Error: {e}")
            self.current_ws = None
            return f"查询失败: {e}"
    
    # =========================================================================
    # TTS线程 - 生成TTS并发送到AudioBridge
    # =========================================================================
    def tts_thread(self):
        """TTS线程：生成TTS音频并发送到AudioBridge"""
        logger.info("[TTS] Thread started")
        
        if not has_tts:
            logger.error("[TTS] TTS libraries not available")
            return
        
        while not self.stop_flag.is_set():
            try:
                item = self.speak_queue.get(timeout=1.0)
                
                if item == INTERRUPT_SIGNAL:
                    # 中断信号 - 清空发送队列
                    logger.info("[TTS] Interrupted, clearing send queue")
                    self.audio_bridge.clear_send_queue()
                    continue
                
                text, my_gen = item
                
                # 检查是否被打断
                if self._get_generation() != my_gen:
                    logger.info("[TTS] Interrupted before TTS")
                    continue
                
                logger.info(f"[TTS] Generating TTS for: {text[:50]}...")
                
                # 分句处理（流式TTS）
                sentences = self._split_sentences(text)
                
                for i, sentence in enumerate(sentences):
                    # 检查是否被打断
                    if self._get_generation() != my_gen:
                        logger.info("[TTS] Interrupted during TTS")
                        self.audio_bridge.clear_send_queue()
                        break
                    
                    logger.info(f"[TTS] Sentence {i+1}/{len(sentences)}: {sentence[:30]}...")
                    
                    # 生成TTS
                    pcm_data = self._generate_tts_pcm(sentence)
                    
                    if pcm_data:
                        self.audio_bridge.queue_tts_audio(pcm_data)
                        logger.info(f"[TTS] Queued {len(pcm_data)} bytes")
                    else:
                        logger.error(f"[TTS] Failed to generate TTS for sentence {i+1}")
                
                # 发送sleep信号 - 只有在非唤醒状态下才发送
                current_gen = self._get_generation()
                if current_gen == my_gen:
                    # 检查当前是否处于唤醒状态（如果有新的唤醒，current_gen会大于my_gen）
                    # 等待发送队列真正清空（最多30秒）
                    wait_start = time.time()
                    while time.time() - wait_start < 30:
                        remaining = self.audio_bridge.send_queue.size()
                        if remaining == 0:
                            break
                        logger.debug(f"[TTS] Waiting for send queue, {remaining} chunks left")
                        time.sleep(0.1)
                    # 额外等待最后一个80ms包传输完成
                    time.sleep(0.15)
                    # 再次检查generation，确保没有新的唤醒
                    if self._get_generation() == current_gen and self.audio_bridge.active_device_id:
                        self.audio_bridge.send_signal(self.audio_bridge.active_device_id, "sleep")
                        logger.info("[TTS] Sent sleep signal")
                    else:
                        logger.debug("[TTS] Skipping sleep signal - new wakeup detected")
                    
            except queue.Empty:
                continue
            except Exception as e:
                logger.error(f"[TTS] Error: {e}")
                logger.debug(traceback.format_exc())
        
        logger.info("[TTS] Thread stopped")
    
    def _split_sentences(self, text: str) -> list:
        """分句，过滤掉空句和纯标点句"""
        # 按中英文句末标点和换行分割
        parts = re.split(r'([。！？!?\n]+)', text)
        result = []
        buf = ""
        for part in parts:
            buf += part
            # 遇到句末标点就提交一个句子
            if re.search(r'[。！？!?\n]', part):
                s = buf.strip()
                buf = ""
                if s:
                    result.append(s)
        if buf.strip():
            result.append(buf.strip())

        # 过滤掉纯空白/纯标点/过短的无效句
        result = [s for s in result if len(re.sub(r'[\s。！？!?.…,，、\n]+', '', s)) >= 2]

        if not result:
            chunk_size = 50
            result = [text[i:i+chunk_size] for i in range(0, len(text), chunk_size)]

        return result
    
    def _generate_tts_pcm(self, text: str) -> bytes:
        """生成TTS PCM音频"""
        # 去除 Markdown 符号和多余空白，保留可读内容
        text = re.sub(r'[*_`#>~]', '', text)          # markdown
        text = re.sub(r'\[([^\]]+)\]\([^)]+\)', r'\1', text)  # [text](url)
        text = re.sub(r'https?://\S+', '', text)       # URL
        text = text.strip()
        # 过滤掉纯标点/emoji/空内容（不可读内容少于2个字符）
        if len(re.sub(r'[\s\W]+', '', text)) < 2:
            logger.debug(f"[TTS] Skipping non-readable sentence: {repr(text)}")
            return None
        try:
            # 自动检测语言：ASCII字符占多数则用英文，否则中文
            ascii_ratio = sum(1 for c in text if ord(c) < 128) / len(text)
            lang = 'en' if ascii_ratio > 0.8 else 'zh-CN'
            logger.debug(f"[TTS] lang={lang} (ascii_ratio={ascii_ratio:.2f}) text={text[:40]}")
            tts = gTTS(text=text, lang=lang)
            mp3_buffer = io.BytesIO()
            tts.write_to_fp(mp3_buffer)
            mp3_buffer.seek(0)
            
            # 使用pydub转换为PCM
            from pydub import AudioSegment
            audio = AudioSegment.from_mp3(mp3_buffer)
            audio = audio.set_frame_rate(16000)
            audio = audio.set_channels(1)
            audio = audio.set_sample_width(2)
            
            pcm_buffer = io.BytesIO()
            audio.export(pcm_buffer, format="raw")
            pcm_data = pcm_buffer.getvalue()
            
            return pcm_data
            
        except Exception as e:
            logger.error(f"[TTS] Error generating TTS: {e}")
            logger.error(traceback.format_exc())
            return None
    
    # =========================================================================
    # 主运行
    # =========================================================================
    def run(self):
        """启动所有线程"""
        logger.info("[Main] Starting voice assistant...")
        
        # 启动三个线程
        threads = [
            threading.Thread(target=self.recording_thread, daemon=True, name="Recording"),
            threading.Thread(target=self.execution_thread, daemon=True, name="Execution"),
            threading.Thread(target=self.tts_thread, daemon=True, name="TTS")
        ]
        
        for t in threads:
            t.start()
        
        logger.info("[Main] All threads started. Press Ctrl+C to stop.")
        
        try:
            while True:
                time.sleep(1)
        except KeyboardInterrupt:
            logger.info("[Main] Stopping...")
            self.stop_flag.set()
            
            for t in threads:
                t.join(timeout=2)
            
            logger.info("[Main] Stopped")
