---
read_when:
  - 在 iOS 节点或 macOS 上添加或修改相机捕获功能
  - 扩展智能体可访问的 MEDIA 临时文件工作流
summary: 相机捕获（iOS 节点 + macOS 应用）供智能体使用：照片（jpg）和短视频片段（mp4）
title: 相机捕获
x-i18n:
  generated_at: "2026-02-01T21:17:51Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: b4d5f5ecbab6f70597cf1e1f9cc5f7f54681253bd747442db16cc681203b5813
  source_path: nodes/camera.md
  workflow: 15
---

# 相机捕获（智能体）

OpenClaw 支持智能体工作流中的**相机捕获**：

- **iOS 节点**（通过 Gateway网关配对）：通过 `node.invoke` 捕获**照片**（`jpg`）或**短视频片段**（`mp4`，可选音频）。
- **Android 节点**（通过 Gateway网关配对）：通过 `node.invoke` 捕获**照片**（`jpg`）或**短视频片段**（`mp4`，可选音频）。
- **macOS 应用**（通过 Gateway网关的节点）：通过 `node.invoke` 捕获**照片**（`jpg`）或**短视频片段**（`mp4`，可选音频）。

所有相机访问都受**用户控制的设置**保护。

## iOS 节点

### 用户设置（默认开启）

- iOS 设置标签页 → **相机** → **允许相机**（`camera.enabled`）
  - 默认：**开启**（缺少该键时视为已启用）。
  - 关闭时：`camera.*` 命令返回 `CAMERA_DISABLED`。

### 命令（通过 Gateway网关 `node.invoke`）

- `camera.list`
  - 响应载荷：
    - `devices`：`{ id, name, position, deviceType }` 数组

- `camera.snap`
  - 参数：
    - `facing`：`front|back`（默认：`front`）
    - `maxWidth`：数字（可选；iOS 节点默认 `1600`）
    - `quality`：`0..1`（可选；默认 `0.9`）
    - `format`：当前为 `jpg`
    - `delayMs`：数字（可选；默认 `0`）
    - `deviceId`：字符串（可选；来自 `camera.list`）
  - 响应载荷：
    - `format: "jpg"`
    - `base64: "<...>"`
    - `width`、`height`
  - 载荷保护：照片会被重新压缩，以将 base64 载荷控制在 5 MB 以内。

- `camera.clip`
  - 参数：
    - `facing`：`front|back`（默认：`front`）
    - `durationMs`：数字（默认 `3000`，上限为 `60000`）
    - `includeAudio`：布尔值（默认 `true`）
    - `format`：当前为 `mp4`
    - `deviceId`：字符串（可选；来自 `camera.list`）
  - 响应载荷：
    - `format: "mp4"`
    - `base64: "<...>"`
    - `durationMs`
    - `hasAudio`

### 前台要求

与 `canvas.*` 类似，iOS 节点仅在**前台**允许 `camera.*` 命令。后台调用返回 `NODE_BACKGROUND_UNAVAILABLE`。

### CLI 辅助工具（临时文件 + MEDIA）

获取附件最简单的方式是使用 CLI 辅助工具，它会将解码后的媒体写入临时文件并输出 `MEDIA:<path>`。

示例：

```bash
openclaw nodes camera snap --node <id>               # 默认：前后摄像头都拍摄（2 行 MEDIA 输出）
openclaw nodes camera snap --node <id> --facing front
openclaw nodes camera clip --node <id> --duration 3000
openclaw nodes camera clip --node <id> --no-audio
```

注意事项：

- `nodes camera snap` 默认拍摄**两个**朝向，以便为智能体提供两个视角。
- 输出文件是临时的（位于操作系统临时目录中），除非你自行构建包装器。

## Android 节点

### 用户设置（默认开启）

- Android 设置面板 → **相机** → **允许相机**（`camera.enabled`）
  - 默认：**开启**（缺少该键时视为已启用）。
  - 关闭时：`camera.*` 命令返回 `CAMERA_DISABLED`。

### 权限

- Android 需要运行时权限：
  - `CAMERA`：用于 `camera.snap` 和 `camera.clip`。
  - `RECORD_AUDIO`：用于 `includeAudio=true` 时的 `camera.clip`。

如果缺少权限，应用会在可能时弹出提示；如果被拒绝，`camera.*` 请求将以 `*_PERMISSION_REQUIRED` 错误失败。

### 前台要求

与 `canvas.*` 类似，Android 节点仅在**前台**允许 `camera.*` 命令。后台调用返回 `NODE_BACKGROUND_UNAVAILABLE`。

### 载荷保护

照片会被重新压缩，以将 base64 载荷控制在 5 MB 以内。

## macOS 应用

### 用户设置（默认关闭）

macOS 伴侣应用提供一个复选框：

- **设置 → 通用 → 允许相机**（`openclaw.cameraEnabled`）
  - 默认：**关闭**
  - 关闭时：相机请求返回"Camera disabled by user"。

### CLI 辅助工具（节点调用）

使用主 `openclaw` CLI 在 macOS 节点上调用相机命令。

示例：

```bash
openclaw nodes camera list --node <id>            # 列出相机 ID
openclaw nodes camera snap --node <id>            # 输出 MEDIA:<path>
openclaw nodes camera snap --node <id> --max-width 1280
openclaw nodes camera snap --node <id> --delay-ms 2000
openclaw nodes camera snap --node <id> --device-id <id>
openclaw nodes camera clip --node <id> --duration 10s          # 输出 MEDIA:<path>
openclaw nodes camera clip --node <id> --duration-ms 3000      # 输出 MEDIA:<path>（旧版标志）
openclaw nodes camera clip --node <id> --device-id <id>
openclaw nodes camera clip --node <id> --no-audio
```

注意事项：

- `openclaw nodes camera snap` 默认 `maxWidth=1600`，除非被覆盖。
- 在 macOS 上，`camera.snap` 在预热/曝光稳定后等待 `delayMs`（默认 2000ms）再进行捕获。
- 照片载荷会被重新压缩，以将 base64 控制在 5 MB 以内。

## 安全性 + 实际限制

- 相机和麦克风访问会触发常规的操作系统权限提示（且需要在 Info.plist 中添加用途说明字符串）。
- 视频片段有长度上限（当前 `<= 60s`），以避免过大的节点载荷（base64 开销 + 消息大小限制）。

## macOS 屏幕录制（操作系统级别）

如需*屏幕*录制（非相机），请使用 macOS 伴侣应用：

```bash
openclaw nodes screen record --node <id> --duration 10s --fps 15   # 输出 MEDIA:<path>
```

注意事项：

- 需要 macOS **屏幕录制**权限（TCC）。
