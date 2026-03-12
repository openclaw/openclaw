# 架构重构计划

## 目标

使用 WebSocket 连接 ID (`device_id`) 作为唯一标识贯穿整个数据流，确保多设备完全隔离。

## 核心原则

- 每个数据包都携带 `device_id`
- 从音频输入到 TTS 输出全程追踪设备 ID
- 消除全局状态（如 `active_device_id`）
- 每个设备独立处理，互不干扰

## 数据流

```
WebSocket (device_id)
  → AudioBridge.write_audio(device_id, audio)
  → VoiceAssistant.recording_thread 获取 (device_id, audio)
  → ASR.submit(device_id, audio, callback)
  → ASR callback 返回 (device_id, text)
  → VoiceAssistant.task_queue.put((device_id, question, generation))
  → VoiceAssistant.execution_thread 处理 (device_id, question)
  → OpenClaw 查询
  → TTSHandler.submit_tts(device_id, answer, generation)
  → TTSHandler 生成 TTS
  → AudioBridge.send_tts_audio(device_id, audio)
  → WebSocketServer 路由到对应 WebSocket 连接
```

## 已完成

- [x] 创建 `tts_handler.py` - 独立的 TTS 处理类，支持多设备
- [x] 重构 `audio_bridge.py` - 所有方法携带 device_id

## 待完成

- [ ] 重构 `voice_assistant_remote.py`
  - [ ] 所有队列元素包含 device_id
  - [ ] 录音线程处理 (device_id, audio)
  - [ ] 执行线程处理 (device_id, question)
  - [ ] 每个设备独立的 generation 追踪
- [ ] 重构 `websocket_audio_server.py`
  - [ ] 使用新的回调签名 (device_id, data)
  - [ ] 路由 TTS 和信号到正确的 WebSocket 连接
- [ ] 更新 `main.py`
  - [ ] 连接新架构
  - [ ] 初始化 TTSHandler
- [ ] 测试多设备隔离

## 关键改动

### AudioBridge

```python
# 旧: write_audio(data, device_id=None)
# 新: write_audio(device_id, data)

# 旧: get_audio_packet() -> bytes
# 新: get_audio_packet() -> (device_id, data)

# 旧: send_signal(signal_type)
# 新: send_signal(device_id, signal_type)

# 旧: send_tts_audio(audio)
# 新: send_tts_audio(device_id, audio)
```

### VoiceAssistant

```python
# 旧: task_queue.put(question)
# 新: task_queue.put((device_id, question, generation))

# 旧: speak_queue.put((text, generation))
# 新: 使用 TTSHandler.submit_tts(device_id, text, generation)

# 旧: 全局 self.generation
# 新: 每个设备独立的 generation (在 TTSHandler 中)
```

### WebSocketServer

```python
# 旧: _on_tts_audio(audio_chunk)
# 新: _on_tts_audio(device_id, audio_chunk)

# 旧: _on_signal(signal_type)
# 新: _on_signal(device_id, signal_type)
```
