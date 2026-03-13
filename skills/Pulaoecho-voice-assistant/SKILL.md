---
name: pulaoecho-voice-assistant
description: 远程音频语音助手，支持语音唤醒和TTS响应
metadata:
  {
    "openclaw":
      {
        "emoji": "🗣️",
        "requires": { "bins": ["python3"], "env": [], "config": [] },
        "install":
          [
            {
              "id": "pip",
              "kind": "node",
              "label": "Install Python dependencies",
              "commands": ["pip3 install -r requirements.txt"],
            },
          ],
      },
  }
---

# Pulaoecho Voice Assistant

远程音频语音助手，支持语音唤醒和TTS响应。

## 功能

- 语音唤醒（支持 "hi claw", "hey claw", "hi google", "hey google", "ok google"）
- 语音识别和自然语言处理
- 文本转语音（TTS）响应
- WebSocket音频流传输
- TLS加密连接

## 配置

1. 生成证书：

   ```bash
   cd skills/Pulaoecho-voice-assistant && bash scripts/gen_cert.sh
   ```

2. 安装依赖：

   ```bash
   cd skills/Pulaoecho-voice-assistant && pip3 install -r requirements.txt
   ```

3. 启动服务：
   ```bash
   cd skills/Pulaoecho-voice-assistant && python3 scripts/main.py
   ```

## 使用

设备可以通过WebSocket连接到服务：

- WebSocket URL: `wss://localhost:18181/v1/audio/stream`
- 连接时需要发送包含deviceid的初始化消息
- 后续所有消息都需要包含deviceid字段

## 技术说明

- 服务使用Python实现
- WebSocket服务器处理音频流
- 语音助手核心逻辑处理唤醒词检测和自然语言处理
- 支持单声道和双声道音频数据

## 注意事项

- 服务默认使用自签名证书，客户端需要信任该证书
- 服务运行在18181端口
- 日志文件保存在当前目录的 `pulaoecho-voice-assistant.log`
