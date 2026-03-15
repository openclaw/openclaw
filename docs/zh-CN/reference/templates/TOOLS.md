---
read_when:
  - 手动引导工作区
summary: TOOLS.md 的工作区模板
x-i18n:
  generated_at: "2026-02-01T21:38:05Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: 3ed08cd537620749c40ab363f5db40a058d8ddab4d0192a1f071edbfcf37a739
  source_path: reference/templates/TOOLS.md
  workflow: 15
---

# TOOLS.md - 本地备注

Skills 定义了工具的*工作方式*。此文件用于记录*你的*具体信息——那些你的环境中独有的内容。

## 应该放什么

例如：

- 摄像头名称和位置
- SSH 主机和别名
- TTS 首选语音
- 音箱/房间名称
- 设备昵称
- 任何与环境相关的内容

## 示例

```markdown
### Cameras

- living-room → 主区域，180° 广角
- front-door → 入口，运动触发

### SSH

- home-server → 192.168.1.100, user: admin

### TTS

- Preferred voice: "Nova"（温暖，略带英式口音）
- Default speaker: Kitchen HomePod
```

## 为什么要分开？

Skills 是共享的。你的配置是你自己的。将它们分开意味着你可以更新 Skills 而不丢失你的备注，也可以分享 Skills 而不泄露你的基础设施信息。

---

添加任何对你有帮助的内容。这是你的速查表。
