---
read_when:
  - 在 macOS/iOS/Android 上实现对话模式
  - 更改语音/TTS/打断行为
summary: 对话模式：使用 ElevenLabs TTS 进行连续语音对话
title: 对话模式
x-i18n:
  generated_at: "2026-02-01T21:18:51Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: ecbc3701c9e9502970cf13227fedbc9714d13668d8f4f3988fef2a4d68116a42
  source_path: nodes/talk.md
  workflow: 15
---

# 对话模式

对话模式是一个连续的语音对话循环：

1. 监听语音
2. 将转录文本发送给模型（主会话，chat.send）
3. 等待响应
4. 通过 ElevenLabs 朗读（流式播放）

## 行为（macOS）

- 启用对话模式时显示**常驻悬浮窗**。
- **监听 → 思考 → 朗读**阶段切换。
- **短暂停顿**（静音窗口）后，当前转录文本会被发送。
- 回复会**写入 WebChat**（与打字相同）。
- **语音打断**（默认开启）：如果用户在助手朗读时开始说话，会停止播放并记录打断时间戳用于下一次提示。

## 回复中的语音指令

助手可以在回复前添加**单行 JSON** 来控制语音：

```json
{ "voice": "<voice-id>", "once": true }
```

规则：

- 仅限第一个非空行。
- 未知键会被忽略。
- `once: true` 仅应用于当前回复。
- 不带 `once` 时，该语音将成为对话模式的新默认语音。
- JSON 行在 TTS 播放前会被移除。

支持的键：

- `voice` / `voice_id` / `voiceId`
- `model` / `model_id` / `modelId`
- `speed`、`rate`（WPM）、`stability`、`similarity`、`style`、`speakerBoost`
- `seed`、`normalize`、`lang`、`output_format`、`latency_tier`
- `once`

## 配置（`~/.openclaw/openclaw.json`）

```json5
{
  talk: {
    voiceId: "elevenlabs_voice_id",
    modelId: "eleven_v3",
    outputFormat: "mp3_44100_128",
    apiKey: "elevenlabs_api_key",
    interruptOnSpeech: true,
  },
}
```

默认值：

- `interruptOnSpeech`：true
- `voiceId`：回退到 `ELEVENLABS_VOICE_ID` / `SAG_VOICE_ID`（或在 API 密钥可用时使用第一个 ElevenLabs 语音）
- `modelId`：未设置时默认为 `eleven_v3`
- `apiKey`：回退到 `ELEVENLABS_API_KEY`（或 Gateway网关 shell 配置文件，如可用）
- `outputFormat`：macOS/iOS 默认为 `pcm_44100`，Android 默认为 `pcm_24000`（设置 `mp3_*` 以强制 MP3 流式传输）

## macOS UI

- 菜单栏切换：**Talk**
- 配置标签页：**Talk Mode** 组（语音 ID + 打断开关）
- 悬浮窗：
  - **监听中**：云朵随麦克风音量脉动
  - **思考中**：下沉动画
  - **朗读中**：辐射圆环
  - 点击云朵：停止朗读
  - 点击 X：退出对话模式

## 注意事项

- 需要语音识别 + 麦克风权限。
- 使用 `chat.send` 对会话键 `main` 发送。
- TTS 使用 ElevenLabs 流式 API，配合 `ELEVENLABS_API_KEY`，在 macOS/iOS/Android 上进行增量播放以降低延迟。
- `eleven_v3` 的 `stability` 验证值为 `0.0`、`0.5` 或 `1.0`；其他模型接受 `0..1`。
- `latency_tier` 设置时验证值为 `0..4`。
- Android 支持 `pcm_16000`、`pcm_22050`、`pcm_24000` 和 `pcm_44100` 输出格式，用于低延迟 AudioTrack 流式传输。
