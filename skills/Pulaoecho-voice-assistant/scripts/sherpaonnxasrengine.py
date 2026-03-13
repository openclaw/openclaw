#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Sherpa-ONNX 语音识别引擎
支持本地离线使用，无需网络连接
"""
import logging
import threading
from typing import Callable, List, Optional

logger = logging.getLogger('SherpaONNXASR')

try:
    import sherpa_onnx
    has_sherpa_onnx = True
except ImportError:
    has_sherpa_onnx = False
    logger.warning("sherpa_onnx library not found. pip install sherpa-onnx")


class SherpaONNXASREngine:
    """Sherpa-ONNX 语音识别引擎
    
    使用本地 ONNX 模型进行实时语音识别
    支持热词提升唤醒率
    并发处理但保证结果按提交顺序返回
    """
    
    def __init__(self, model_dir: str, hotwords: Optional[List[str]] = None, language: str = "en", 
                 encoder: str = "encoder.onnx", decoder: str = "decoder.onnx", 
                 tokens: str = "tokens.txt"):
        """初始化 Sherpa-ONNX 引擎
        
        Args:
            model_dir: ONNX 模型目录路径
            hotwords: 热词列表，用于提升特定词汇的识别率
            language: 识别语言，默认 "en" (英文)
            encoder: encoder 模型文件名
            decoder: decoder 模型文件名
            tokens: tokens 文件名
        """
        self.model_dir = model_dir
        self.hotwords = hotwords or []
        self.language = language
        self.encoder = encoder
        self.decoder = decoder
        self.tokens = tokens
        
        if not has_sherpa_onnx:
            logger.error("sherpa_onnx library is required for SherpaONNX ASR")
            self._recognizer = None
            return
        
        # 配置 Sherpa-ONNX
        try:
            import os
            # 构建模型文件的完整路径
            encoder_path = os.path.join(model_dir, encoder)
            decoder_path = os.path.join(model_dir, decoder)
            tokens_path = os.path.join(model_dir, tokens)
            
            # 使用 from_whisper 类方法创建识别器
            self._recognizer = sherpa_onnx.OfflineRecognizer.from_whisper(
                encoder=encoder_path,
                decoder=decoder_path,
                tokens=tokens_path,
                language=language,
                task="transcribe",
                num_threads=2,
                debug=False,
                provider="cpu"
            )
            logger.info(f"[SherpaONNX] Initialized Whisper model: {encoder}, {decoder}, language={language}, hotwords={hotwords}")
        except Exception as e:
            logger.error(f"[SherpaONNX] Failed to initialize: {e}")
            self._recognizer = None
        
        # 顺序控制：确保结果按提交顺序返回
        self._sequence_counter = 0  # 提交序号计数器
        self._sequence_lock = threading.Lock()  # 保护序号分配
        self._result_buffer = {}  # {seq: (req_id, text)} 缓存乱序到达的结果
        self._next_deliver_seq = 0  # 下一个应该交付的序号
        self._deliver_lock = threading.Lock()  # 保护交付逻辑
        self._pending_callbacks = {}  # {seq: on_result} 保存回调函数
    
    def _create_hotwords_file(self) -> str:
        """创建热词文件
        
        Returns:
            热词文件路径
        """
        import os
        import tempfile
        
        with tempfile.NamedTemporaryFile(mode='w', suffix='.txt', delete=False) as f:
            for word in self.hotwords:
                f.write(f"{word} 1.5\n")
            temp_file = f.name
        
        return temp_file
    
    def submit(self, pcm: bytes, req_id: str, on_result: Callable[[str, Optional[str]], None]):
        """提交一段 PCM 进行识别。立刻返回，结果异步回调。
        
        Args:
            pcm: PCM音频数据 (16kHz, 16bit, mono)
            req_id: 请求ID，用于匹配识别结果
            on_result: 回调函数 on_result(req_id: str, text: str | None)
                      text=None 表示未识别到语音或出错
        
        注意：虽然识别是并发的，但结果会按提交顺序依次回调
        """
        if not has_sherpa_onnx or self._recognizer is None:
            on_result(req_id, None)
            return
        
        # 分配序号
        with self._sequence_lock:
            seq = self._sequence_counter
            self._sequence_counter += 1
            self._pending_callbacks[seq] = on_result
        
        logger.debug(f"[SherpaONNX] Submit seq={seq} req_id={req_id[:8]}")
        
        # 启动识别线程（并发）
        t = threading.Thread(
            target=self._run,
            args=(pcm, req_id, seq),
            daemon=True,
            name=f"SherpaONNX-{req_id[:8]}",
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
            if not self._recognizer:
                logger.error(f"[SherpaONNX:{req_id[:8]}] Recognizer not initialized")
                self._deliver_result(seq, req_id, None)
                return
            
            # 将 PCM bytes 转换为 float32 数组
            import numpy as np
            samples = np.frombuffer(pcm, dtype=np.int16).astype(np.float32) / 32768.0
            
            # 创建离线流
            stream = self._recognizer.create_stream()
            stream.accept_waveform(16000, samples)
            
            # 执行识别
            self._recognizer.decode_stream(stream)
            
            # 获取结果
            result = stream.result
            text = result.text.strip()
            
            if text:
                logger.info(f"[SherpaONNX:{req_id[:8]}] Recognized: {text}")
                self._deliver_result(seq, req_id, text)
            else:
                logger.debug(f"[SherpaONNX:{req_id[:8]}] Empty recognition result")
                self._deliver_result(seq, req_id, None)
                
        except Exception as e:
            logger.error(f"[SherpaONNX:{req_id[:8]}] Unexpected error: {e}")
            import traceback
            logger.debug(traceback.format_exc())
            self._deliver_result(seq, req_id, None)
    
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
            logger.debug(f"[SherpaONNX] Result buffered seq={seq} req_id={req_id[:8]} next_deliver={self._next_deliver_seq}")
            
            # 尝试交付所有连续的结果
            while self._next_deliver_seq in self._result_buffer:
                deliver_seq = self._next_deliver_seq
                deliver_req_id, deliver_text = self._result_buffer.pop(deliver_seq)
                callback = self._pending_callbacks.pop(deliver_seq, None)
                
                if callback:
                    logger.debug(f"[SherpaONNX] Delivering seq={deliver_seq} req_id={deliver_req_id[:8]}")
                    # 在锁外调用回调，避免死锁
                    threading.Thread(
                        target=callback,
                        args=(deliver_req_id, deliver_text),
                        daemon=True,
                        name=f"Deliver-{deliver_req_id[:8]}"
                    ).start()
                else:
                    logger.warning(f"[SherpaONNX] No callback for seq={deliver_seq}")
                
                self._next_deliver_seq += 1
    
    def set_hotwords(self, hotwords: List[str]):
        """更新热词列表
        
        Args:
            hotwords: 新的热词列表
        """
        self.hotwords = hotwords
        logger.info(f"[SherpaONNX] Updated hotwords: {hotwords}")
        
        # 重新初始化识别器以应用新的热词
        if has_sherpa_onnx and self.model_dir:
            try:
                config = sherpa_onnx.RecognizerConfig()
                config.feat_config.sampling_rate = 16000
                config.feat_config.feature_dim = 80
                
                # 设置模型路径
                config.model_config.transducer.encoder_filename = f"{self.model_dir}/encoder.onnx"
                config.model_config.transducer.decoder_filename = f"{self.model_dir}/decoder.onnx"
                config.model_config.transducer.joiner_filename = f"{self.model_dir}/joiner.onnx"
                config.model_config.token_filename = f"{self.model_dir}/tokens.txt"
                
                # 设置热词
                if self.hotwords:
                    config.decoder_config.hotwords_file = self._create_hotwords_file()
                    config.decoder_config.hotwords_score = 1.5  # 热词权重
                
                # 重新初始化识别器
                self._recognizer = sherpa_onnx.Recognizer(config)
                logger.info(f"[SherpaONNX] Re-initialized with new hotwords")
            except Exception as e:
                logger.error(f"[SherpaONNX] Failed to re-initialize: {e}")
