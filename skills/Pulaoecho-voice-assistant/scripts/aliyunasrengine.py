#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
阿里云语音识别引擎
使用 qwen3-asr-flash 模型进行语音识别
支持热词、MP3文件传输
"""
import io
import json
import logging
import threading
import time
from typing import Callable, List, Optional

logger = logging.getLogger('AliyunASR')

try:
    from openai import OpenAI
    has_openai = True
except ImportError:
    has_openai = False
    logger.warning("openai library not found. pip install openai")

try:
    from pydub import AudioSegment
    has_pydub = True
except ImportError:
    has_pydub = False
    logger.warning("pydub not found. pip install pydub")


class AliyunASREngine:
    """阿里云语音识别引擎
    
    使用 qwen3-asr-flash 模型进行实时语音识别
    支持热词提升唤醒率
    并发处理但保证结果按提交顺序返回
    使用 OpenAI 兼容 API
    """
    
    # API配置
    BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1"
    
    def __init__(self, api_key: str, model: str = "qwen3-asr-flash", hotwords: Optional[List[str]] = None, language: str = "en"):
        """初始化阿里云ASR引擎
        
        Args:
            api_key: 阿里云API密钥
            model: 使用的模型名称，默认 qwen3-asr-flash
            hotwords: 热词列表，用于提升特定词汇的识别率
            language: 识别语言，默认 "en" (英文)
        """
        self.api_key = api_key
        self.model = model
        self.hotwords = hotwords or []
        self.language = language
        
        if not has_openai:
            logger.error("openai library is required for Aliyun ASR")
        if not has_pydub:
            logger.error("pydub library is required for audio conversion")
        
        # 创建 OpenAI 客户端
        self._client = OpenAI(
            api_key=api_key,
            base_url=self.BASE_URL
        ) if has_openai else None
        
        # 顺序控制：确保结果按提交顺序返回
        self._sequence_counter = 0  # 提交序号计数器
        self._sequence_lock = threading.Lock()  # 保护序号分配
        self._result_buffer = {}  # {seq: (req_id, text)} 缓存乱序到达的结果
        self._next_deliver_seq = 0  # 下一个应该交付的序号
        self._deliver_lock = threading.Lock()  # 保护交付逻辑
        self._pending_callbacks = {}  # {seq: on_result} 保存回调函数
            
        logger.info(f"[AliyunASR] Initialized with model={model}, language={language}, hotwords={hotwords}")
    
    def submit(self, pcm: bytes, req_id: str, on_result: Callable[[str, Optional[str]], None]):
        """提交一段 PCM 进行识别。立刻返回，结果异步回调。
        
        Args:
            pcm: PCM音频数据 (16kHz, 16bit, mono)
            req_id: 请求ID，用于匹配识别结果
            on_result: 回调函数 on_result(req_id: str, text: str | None)
                      text=None 表示未识别到语音或出错
        
        注意：虽然识别是并发的，但结果会按提交顺序依次回调
        """
        if not has_openai or not has_pydub:
            on_result(req_id, None)
            return
        
        # 分配序号
        with self._sequence_lock:
            seq = self._sequence_counter
            self._sequence_counter += 1
            self._pending_callbacks[seq] = on_result
        
        logger.debug(f"[AliyunASR] Submit seq={seq} req_id={req_id[:8]}")
        
        # 启动识别线程（并发）
        t = threading.Thread(
            target=self._run,
            args=(pcm, req_id, seq),
            daemon=True,
            name=f"AliyunASR-{req_id[:8]}",
        )
        t.start()
    
    def _run(self, pcm: bytes, req_id: str, seq: int):
        """执行识别任务（在独立线程中运行）
        
        Args:
            pcm: PCM音频数据
            req_id: 请求ID
            seq: 序号，用于保证结果顺序
        """
        try:
            # 1. 将 PCM 转换为 MP3
            mp3_data = self._pcm_to_mp3(pcm)
            if not mp3_data:
                logger.error(f"[AliyunASR:{req_id[:8]}] Failed to convert PCM to MP3")
                self._deliver_result(seq, req_id, None)
                return
            
            # 2. 将 MP3 转换为 base64 data URI
            import base64
            audio_base64 = base64.b64encode(mp3_data).decode('utf-8')
            data_uri = f"data:audio/mpeg;base64,{audio_base64}"
            
            # 3. 构建 OpenAI 兼容格式的请求
            messages = [
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "input_audio",
                            "input_audio": {
                                "data": data_uri
                            }
                        }
                    ]
                }
            ]
            
            # 构建 asr_options
            asr_options = {
                "language": self.language,
                "enable_itn": True  # 启用逆文本标准化
            }
            
            # 添加热词
            if self.hotwords:
                asr_options["hotwords"] = ",".join(self.hotwords)
            
            # 4. 调用 OpenAI 兼容 API
            logger.debug(f"[AliyunASR:{req_id[:8]}] Sending request to Aliyun API (OpenAI-compatible)")
            
            completion = self._client.chat.completions.create(
                model=self.model,
                messages=messages,
                stream=False,
                extra_body={
                    "asr_options": asr_options
                }
            )
            
            # 5. 解析响应
            if not completion.choices:
                logger.debug(f"[AliyunASR:{req_id[:8]}] No choices in response")
                self._deliver_result(seq, req_id, None)
                return
            
            choice = completion.choices[0]
            text = choice.message.content
            
            # 提取语言标注
            detected_lang = None
            if hasattr(choice.message, 'annotations') and choice.message.annotations:
                for ann in choice.message.annotations:
                    if isinstance(ann, dict) and ann.get("type") == "audio_info":
                        detected_lang = ann.get("language")
                        break
            
            if text:
                lang_info = f" (lang={detected_lang})" if detected_lang else ""
                logger.info(f"[AliyunASR:{req_id[:8]}] Recognized{lang_info}: {text}")
                self._deliver_result(seq, req_id, text)
            else:
                logger.debug(f"[AliyunASR:{req_id[:8]}] Empty recognition result")
                self._deliver_result(seq, req_id, None)
                
        except Exception as openai_error:
            # OpenAI SDK 的各种异常
            error_msg = str(openai_error)
            if "timeout" in error_msg.lower():
                logger.warning(f"[AliyunASR:{req_id[:8]}] Request timeout: {openai_error}")
            elif "ssl" in error_msg.lower():
                logger.warning(f"[AliyunASR:{req_id[:8]}] SSL error: {openai_error}")
            elif "connection" in error_msg.lower():
                logger.warning(f"[AliyunASR:{req_id[:8]}] Connection error: {openai_error}")
            else:
                logger.warning(f"[AliyunASR:{req_id[:8]}] API error: {openai_error}")
            self._deliver_result(seq, req_id, None)
        except Exception as e:
            logger.error(f"[AliyunASR:{req_id[:8]}] Unexpected error: {e}")
            import traceback
            logger.debug(traceback.format_exc())
            self._deliver_result(seq, req_id, None)
    
    def _pcm_to_mp3(self, pcm: bytes, sample_rate: int = 16000, sample_width: int = 2, channels: int = 1) -> Optional[bytes]:
        """将 PCM 音频转换为 MP3 格式
        
        Args:
            pcm: PCM音频数据
            sample_rate: 采样率，默认16000Hz
            sample_width: 采样宽度（字节），默认2 (16bit)
            channels: 声道数，默认1 (mono)
            
        Returns:
            MP3音频数据，失败返回None
        """
        try:
            # 使用 pydub 转换
            audio = AudioSegment(
                data=pcm,
                sample_width=sample_width,
                frame_rate=sample_rate,
                channels=channels
            )
            
            # 导出为 MP3
            mp3_buffer = io.BytesIO()
            audio.export(mp3_buffer, format="mp3", bitrate="128k")
            mp3_data = mp3_buffer.getvalue()
            
            logger.debug(f"[AliyunASR] Converted PCM ({len(pcm)} bytes) to MP3 ({len(mp3_data)} bytes)")
            return mp3_data
            
        except Exception as e:
            logger.error(f"[AliyunASR] PCM to MP3 conversion failed: {e}")
            import traceback
            logger.debug(traceback.format_exc())
            return None
    
    def _deliver_result(self, seq: int, req_id: str, text: Optional[str]):
        """交付识别结果，保证按序号顺序交付
        
        Args:
            seq: 序号
            req_id: 请求ID
            text: 识别文本（None表示失败）
        """
        with self._deliver_lock:
            # 将结果放入缓冲区
            self._result_buffer[seq] = (req_id, text)
            logger.debug(f"[AliyunASR] Result buffered seq={seq} req_id={req_id[:8]} next_deliver={self._next_deliver_seq}")
            
            # 尝试交付所有连续的结果
            while self._next_deliver_seq in self._result_buffer:
                deliver_seq = self._next_deliver_seq
                deliver_req_id, deliver_text = self._result_buffer.pop(deliver_seq)
                callback = self._pending_callbacks.pop(deliver_seq, None)
                
                if callback:
                    logger.debug(f"[AliyunASR] Delivering seq={deliver_seq} req_id={deliver_req_id[:8]}")
                    # 在锁外调用回调，避免死锁
                    threading.Thread(
                        target=callback,
                        args=(deliver_req_id, deliver_text),
                        daemon=True,
                        name=f"Deliver-{deliver_req_id[:8]}"
                    ).start()
                else:
                    logger.warning(f"[AliyunASR] No callback for seq={deliver_seq}")
                
                self._next_deliver_seq += 1
    
    def set_hotwords(self, hotwords: List[str]):
        """更新热词列表
        
        Args:
            hotwords: 新的热词列表
        """
        self.hotwords = hotwords
        logger.info(f"[AliyunASR] Updated hotwords: {hotwords}")
