---
read_when:
  - 你想在 OpenClaw 中使用 DG-Lab（郊狼）V3 设备
  - 你需要 DG-Lab 插件的安装与配置说明
summary: DG-Lab 社区插件：通过 WebSocket 控制 DG-Lab（郊狼）V3 设备
title: DG-Lab 插件
x-i18n:
  generated_at: "2026-02-27T23:57:20Z"
  model: claude-opus-4-6
  provider: pi
  source_hash: 7ccb3252ce19ce145d45d2200bd3c512e30c8b8913464baac03622b9cc21fb8f
  source_path: plugins/dg-lab.md
  workflow: 15
---

# DG-Lab 插件（社区）

`openclaw-plugin-dg-lab` 是一个社区维护插件，用于通过 WebSocket 桥接控制
DG-Lab（郊狼）V3 设备。

插件仓库：
`https://github.com/FengYing1314/openclaw-plugin-dg-lab`

## 安装

```bash
openclaw plugins install openclaw-plugin-dg-lab
```

安装后请重启 Gateway。

## 插件 ID

`openclaw-plugin-dg-lab`

## 配置

在 `plugins.entries.openclaw-plugin-dg-lab.config` 下配置：

```json5
{
  plugins: {
    entries: {
      "openclaw-plugin-dg-lab": {
        enabled: true,
        config: {
          serverIp: "203.0.113.10",
          port: 18888,
          limitIntensity: 40,
        },
      },
    },
  },
}
```

字段说明：

- `serverIp`（string）：配对二维码中写入的公网 IP/域名。
- `port`（number，默认 `18888`）：插件 WebSocket 服务端口。
- `limitIntensity`（number，默认 `40`）：软件侧强度软上限（`0` 到 `200`）。

## 聊天命令

- `/dg_qr`：生成 DG-Lab 配对二维码。
- `/dg_emotion on|off`：开启或关闭情感联动模式。
- `/dg_limit <0-200>`：设置软件侧强度软上限。
- `/dg_test <delta>`：发送测试强度变更。
- `/dg_status`：查看连接与强度状态。
- `/dg_pulse ...`：管理波形库。

## Agent 工具

- `dg_shock`：在 A/B 通道发送刺激并选择波形。
- `dg_pulse_list`：列出内置与导入的波形预设。
- `dg_qr_generate`：生成配对二维码图片并返回本地路径。

## 安全说明

该插件控制电刺激硬件，请谨慎使用。

- 从低强度开始。
- 以 DG-Lab App 设备侧硬件上限为准。
- 避开危险部位（胸部/头部/颈部）。
- 使用风险由使用者自行承担。
