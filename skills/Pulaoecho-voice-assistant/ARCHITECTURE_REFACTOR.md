# 架构重构指南 - 基于 WebSocket ID 的设备隔离

## 目标

使用 WebSocket 连接 ID (`device_id`) 作为唯一标识贯穿整个数据流，实现完全的多设备隔离。

## 核心原则

**每个数据包都携带 `device_id`，从音频输入到 TTS 输出全程追踪**

## 当前架构问题

1. **全局状态依赖**：使用 `active_device_id` 和 `last_audio_device_id` 等全局变量
2. **设备 ID 丢失**：音频包在处理过程中丢失了 `device_id` 信息
3. **不可靠的路由**：依赖 `last_audio_device_id` 这种容易被覆盖的机制
4. **并发冲突**：多设备并发时容易出现路由错误

## 理想架构

```
WebSocket (device_id)
  → AudioBridge.write_audio(device_id, audio)
  → VoiceAssistant.recording_thread 获取 (device_id, audio)
  → ASR.submit(device_id, audio, callback)
  → ASR callback 返回 (device_id, text)
  → VoiceAssistant.task_queue.put((device_id, question, generation))
  → VoiceAssistant.execution_thread 处理 (device_id, question)
  → OpenClaw 查询
  → VoiceAssistant.speak_queue.put((device_id, answer, generation))
  → TTS 生成
  → AudioBridge.send_tts_audio(device_id, audio)
  → WebSocketServer 路由到对应 WebSocket 连接
```

## 已完成的修改

### 1. AudioBridge (`scripts/audio_bridge.py`)

✅ **新架构方法**：

- `write_audio(device_id, data)` - 写入时携带设备 ID
- `get_audio_packet() -> (device_id, data)` - 读取时返回设备 ID
- `send_tts_audio(device_id, audio)` - TTS 发送到指定设备
- `send_signal(device_id, signal_type)` - 信号发送到指定设备

✅ **兼容层**（为旧代码保留）：

- `set_active_device(device_id)`
- `queue_tts_audio(audio)`
- `clear_send_queue()`
- `start_send_thread()` / `stop_send_thread()`

### 2. WebSocketAudioServer (`scripts/websocket_audio_server.py`)

✅ **已更新**：

- `_on_tts_audio(device_id, audio_chunk)` - 接受设备 ID 参数
- `_on_signal(device_id, signal_type)` - 接受设备 ID 参数
- `handle_audio()` - 调用 `write_audio(device_id, data)`

## 待完成的修改

### 3. VoiceAssistantRemote (`scripts/voice_assistant_remote.py`)

#### 3.1 recording_thread

**当前**：

```python
# 全局状态
rec_state = "waiting"
collected_text = []
speech_frames = []

# 获取音频
packet = self.audio_bridge.get_audio_packet()
frame_buf.extend(packet)

# 提交 ASR
_submit(pcm)
```

**目标**：

```python
# 每个设备的独立状态
device_states = {}  # {device_id: {'state': ..., 'collected': ..., 'speech_frames': ...}}

# 获取音频（带设备 ID）
packet = self.audio_bridge.get_audio_packet()
if packet:
    device_id, raw_packet = packet
    dev_state = get_device_state(device_id)
    dev_state['frame_buf'].extend(raw_packet)

# 提交 ASR（带设备 ID）
_submit(device_id, pcm, dev_state['state'], dev_state['collected'])
```

#### 3.2 ASR 回调

**当前**：

```python
def _on_asr_result(req_id, text):
    # 使用快照中的 device_id
    snapshot_state, snapshot_collected, snapshot_device_id = snapshot

    # 提交任务
    self.task_queue.put(question)
    self._asr_result_q.put(("waiting", []))
```

**目标**：

```python
def _on_asr_result(req_id, text):
    snapshot_state, snapshot_collected, snapshot_device_id = snapshot

    # 提交任务（带设备 ID 和 generation）
    self.task_queue.put((snapshot_device_id, question, generation))
    self._asr_result_q.put((snapshot_device_id, "waiting", []))
```

#### 3.3 execution_thread

**当前**：

```python
question = self.task_queue.get()
answer = self._query_openclaw(question)
self.speak_queue.put((answer, generation))
```

**目标**：

```python
device_id, question, generation = self.task_queue.get()
answer = self._query_openclaw(question)
# 发送信号到指定设备
self.audio_bridge.send_signal(device_id, "feedback")
# 提交 TTS（带设备 ID）
self.speak_queue.put((device_id, answer, generation))
```

#### 3.4 tts_thread

**当前**：

```python
text, generation = self.speak_queue.get()
# 生成 TTS
self.audio_bridge.queue_tts_audio(mp3_data)
self.audio_bridge.send_signal("sleep")
```

**目标**：

```python
device_id, text, generation = self.speak_queue.get()
# 设置活动设备（兼容层）
self.audio_bridge.set_active_device(device_id)
# 生成 TTS（通过兼容层发送）
self.audio_bridge.queue_tts_audio(mp3_data)
# 发送信号到指定设备
self.audio_bridge.send_signal(device_id, "sleep")
```

## 实施步骤

### 阶段 1：最小化修改（当前状态）

✅ 使用兼容层让系统能够运行
✅ WebSocket 层已经使用新架构
⚠️ 设备路由仍可能有问题（依赖快照机制）

### 阶段 2：完整重构（推荐）

1. **修改 recording_thread**
   - 实现每个设备的独立状态管理
   - 处理 `(device_id, audio)` 元组
   - 提交 ASR 时携带 `device_id`

2. **修改 ASR 回调**
   - 所有队列操作都包含 `device_id`
   - `task_queue`: `(device_id, question, generation)`
   - `_asr_result_q`: `(device_id, state, collected)`

3. **修改 execution_thread**
   - 处理 `(device_id, question, generation)` 元组
   - 发送信号时指定 `device_id`

4. **修改 tts_thread**
   - 处理 `(device_id, text, generation)` 元组
   - 通过 `device_id` 路由 TTS

5. **移除兼容层**（可选）
   - 移除 `active_device_id` 等全局状态
   - 移除 `send_queue` 和 `send_thread`
   - 直接使用新架构的回调

## 测试验证

### 测试场景

1. **单设备测试**
   - 唤醒 → 提问 → 收到正确回复

2. **双设备并发测试**
   - 设备 A 唤醒 → 设备 B 唤醒 → 各自收到正确回复
   - 设备 A 提问 → 设备 B 发送音频 → 设备 A 收到回复

3. **设备切换测试**
   - 设备 A 唤醒 → 设备 B 唤醒 → 设备 B 收到回复
   - 设备 A 提问中 → 设备 B 唤醒 → 设备 A 的回复被中断

### 验证点

- ✅ TTS 回复发送到正确的设备
- ✅ 信号（wakeup, feedback, sleep）发送到正确的设备
- ✅ 多设备并发时互不干扰
- ✅ 设备切换时正确中断前一个设备的任务

## 注意事项

1. **线程安全**：`device_states` 需要使用锁保护
2. **内存管理**：定期清理长时间未活动的设备状态
3. **错误处理**：设备断开时清理相关状态
4. **日志**：所有日志都应包含 `device_id[:8]` 便于调试

## 当前系统状态

- ✅ 系统可以运行
- ✅ WebSocket 层使用新架构
- ✅ AudioBridge 支持新旧两种架构
- ⚠️ VoiceAssistant 仍使用旧架构（通过兼容层工作）
- ⚠️ 设备路由可能仍有问题

## 下一步建议

**选项 A**：测试当前系统，确认设备路由问题
**选项 B**：按照本文档完成完整的架构重构
**选项 C**：创建新的 `voice_assistant_v2.py` 实现新架构，保留旧版本作为备份
