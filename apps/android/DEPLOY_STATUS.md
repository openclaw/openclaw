# OpenClaw 语音服务部署状态

**最后更新**: 2026-03-04 07:20

## 服务器信息

- **ub22 IP**: `192.168.0.107`
- **Whisper ASR 端口**: `10801` ✅ 已部署并运行
- **Edge TTS 端口**: `10802` ✅ 已部署并运行
- **CosyVoice TTS 端口**: `10803` ✅ 已部署并运行

## 当前状态

### ✅ 已完成
1. ✅ **Whisper ASR 服务已部署并运行** (http://192.168.0.107:10801)
2. ✅ **Edge TTS 服务已部署并运行** (http://192.168.0.107:10802)
3. ✅ **CosyVoice TTS 服务已部署并运行** (http://192.168.0.107:10803)
4. ✅ Android 集成代码 `RemoteSpeechService.kt` 已编写
5. ✅ Android 默认配置已更新 (使用 192.168.0.107)
6. ✅ Android App 已编译并安装 (版本 2026.2.23-debug)
7. ✅ TalkModeManagerSherpa 已更新支持远程语音服务
8. ✅ 中文语音测试通过
9. ✅ sherpa-onnx 离线模型已安装 (ASR + TTS)
10. ✅ CosyVoice-300M-SFT 模型已下载 (约 5.6GB)

### 服务验证

**Edge TTS 测试**:
```bash
# 合成中文
curl -X POST "http://192.168.0.107:10802/synthesize" \
  -H "Content-Type: application/json" \
  -d '{"text":"悟空，我在用 tts","voice":"zh-CN-XiaoxiaoNeural"}' \
  -o test.mp3

# 结果：生成 19KB 音频文件 ✓
```

**Whisper ASR 测试**:
```bash
# 健康检查
curl http://192.168.0.107:10801/health
# 返回：{"status":"ok"} ✓
```

**CosyVoice TTS 测试**:
```bash
# SFT 推理（零样本语音合成）
curl -X POST "http://192.168.0.107:10803/inference_sft" \
  -H "Content-Type: application/json" \
  -d '{"text":"你好，这是 CosyVoice 测试","speaker":"中文女"}' \
  -o output.wav

# 可用端点：
# - /inference_sft (SFT 推理)
# - /inference_zero_shot (零样本语音克隆)
# - /inference_cross_lingual (跨语言合成)
# - /inference_instruct (指令跟随合成)
# - /inference_instruct2 (指令跟随合成 v2)
```

**完整流程测试**:
```
输入："悟空，我在用 tts"
  ↓ (Edge TTS 合成)
音频：19KB MP3
  ↓ (Whisper ASR 识别)
输出："悟空，我在用 TTS" ✓
```

### 技术选型说明

已评估的 TTS 方案：
| 方案 | 状态 | 优缺点 |
|------|------|--------|
| **Edge TTS** | ✅ 已部署 | + 无需模型下载<br>+ 支持多语言<br>+ 部署简单<br>- 需要联网到 Microsoft |
| **sherpa-onnx** | ✅ 模型已安装 | + 离线运行<br>+ 支持中英文<br>+ 轻量级<br>- 需要 JNI 集成 |
| **CosyVoice** | ✅ 已部署 | + 高质量中文合成<br>+ 支持语音克隆<br>+ 本地部署<br>- 模型大 (5.6GB)<br>- 依赖复杂 |
| Fish Speech | ⚠️ 暂停 | + 本地部署<br>- 模型下载失败 (HuggingFace 403/超时)<br>- 需要授权访问 |

当前使用 **Edge TTS + Whisper ASR** 作为主要方案，sherpa-onnx 作为离线备选方案。

## Android 集成状态

### 语音服务架构

```
TalkModeManagerSherpa
├── sherpa-onnx (离线 ASR/TTS) - 优先
│   ├── SherpaOnnxRecognizer (ASR)
│   └── SherpaOnnxTts (TTS)
├── RemoteSpeechService (远程服务) - 备选
│   ├── Whisper ASR (192.168.0.107:10801)
│   └── Edge TTS (192.168.0.107:10802)
└── System TTS (系统 TTS) - 最后备选
```

### 已集成的文件

| 文件 | 状态 | 说明 |
|------|------|------|
| `voice/RemoteSpeechService.kt` | ✅ 完成 | 远程语音服务客户端 |
| `voice/TalkModeManagerSherpa.kt` | ✅ 完成 | Talk Mode 管理器 |
| `voice/SherpaOnnxManager.kt` | ✅ 完成 | sherpa-onnx 管理器 |
| `voice/SherpaOnnxRecognizer.kt` | ✅ 完成 | sherpa ASR 识别器 |
| `voice/SherpaOnnxTts.kt` | ✅ 完成 | sherpa TTS 合成器 |
| `jniLibs/` | ✅ 已复制 | 原生库 |
| `assets/sherpa-onnx/` | ✅ 已安装 | 模型文件 |

### 配置说明

默认配置使用远程服务 (192.168.0.107)：

```kotlin
val config = RemoteSpeechConfig.default()
// Whisper ASR: http://192.168.0.107:10801
// Edge TTS: http://192.168.0.107:10802
```

## 待办事项

- [ ] 测试 Talk Mode 在真实设备上的表现（使用 Edge TTS + Whisper）
- [ ] 验证 sherpa-onnx JNI 库与 Android 设备的兼容性
- [ ] 为 CosyVoice TTS 更新 Android 集成（可选）
