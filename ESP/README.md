# OpenClaw ESP32-S3 Node

基于 ESP32-S3 的 OpenClaw 多功能物联网节点固件 v3.1.0。

## 功能特性

| 功能 | 说明 | 状态 |
|------|------|------|
| 🔤 麦克风 | I2S 数字麦克风，语音采集 | 🔧 规划中 |
| 📷 摄像头 | OV2640 200万像素，拍照/录像 | ✅ 已实现 |
| 🖥️ 屏幕 | ST7789 2.8" TFT 显示屏 | 🔧 规划中 |
| 🌡️ 温湿度 | DHT22 传感器 | ✅ 已实现 |
| 🧭 姿态 | MPU6050 6轴加速度计/陀螺仪 | 🔧 规划中 |
| 📟 继电器 | 1路继电器控制 | ✅ 已实现 |
| 🔘 按钮 | 功能按钮交互 (短按/长按) | ✅ 已实现 |
| 🔐 认证 | Ed25519签名 + 设备配对 | ✅ 已实现 |
| 💾 存储 | NVS持久化Token + SPIFFS | ✅ 已实现 |
| 🔄 OTA | WiFi远程固件更新 | ✅ 已实现 |

## 快速开始

### 1. 硬件准备

- ESP32-S3-DevKitC-1 开发板 (带PSRAM)
- USB Type-C 数据线

### 2. 配置WiFi和Gateway

编辑 `main.cpp`，修改以下配置：

```cpp
// WiFi 配置
const char* WIFI_SSID = "Your_WiFi_SSID";
const char* WIFI_PASSWORD = "Your_WiFi_Password";

// OpenClaw Gateway 配置
const char* GATEWAY_HOST = "192.168.1.100";  // Gateway IP地址
const int GATEWAY_PORT = 18789;              // Gateway端口
```

### 3. 编译上传

使用 PlatformIO：

```bash
cd ESP
pio run --target upload
pio device monitor
```

或使用 Arduino IDE：

1. 安装 ESP32 开发板支持 (版本 2.0.11+)
2. 开发板选择: ESP32S3 Dev Module
3. 启用 PSRAM: OPI PSRAM
4. 上传并监控串口

### 4. 配对设备

首次启动时，ESP32 会：

1. 生成唯一的设备ID和RSA密钥对
2. 连接到 WiFi
3. 连接到 Gateway WebSocket
4. 发送配对请求

在 OpenClaw Gateway 端审批设备：

```bash
# 查看待配对设备
openclaw nodes list

# 审批设备
openclaw nodes approve <requestId>
```

审批成功后，ESP32 会收到配对 Token 并保存到 NVS，下次启动自动使用。

## 配对流程

```
┌──────────────┐                    ┌──────────────┐
│    ESP32     │                    │   Gateway    │
└──────┬───────┘                    └──────┬───────┘
       │                                   │
       │  1. WebSocket Connect             │
       │──────────────────────────────────>│
       │                                   │
       │  2. connect.challenge (nonce)     │
       │<──────────────────────────────────│
       │                                   │
       │  3. connect request (签名认证)     │
       │──────────────────────────────────>│
       │                                   │
       │  4a. 首次配对: node.pair.resolved  │
       │    (等待用户审批)                  │
       │<──────────────────────────────────│
       │                                   │
       │  4b. 已配对: connect.resolved      │
       │    (直接连接成功)                  │
       │<──────────────────────────────────│
       │                                   │
       │  5. node.invoke.request (命令)    │
       │<──────────────────────────────────│
       │                                   │
       │  6. response (执行结果)           │
       │──────────────────────────────────>│
       │                                   │
```

## 认证机制

### 设备认证载荷 (v3格式)

```
v3|{deviceId}|{clientId}|{clientMode}|{role}|{scopes}|{signedAtMs}|{token}|{nonce}|{platform}|{deviceFamily}
```

### 签名流程

1. 构建 v3 格式的认证载荷字符串
2. 使用 Ed25519 私钥签名
3. 签名结果 Base64 URL 编码

## 按钮交互

| 操作 | 动作 | 功能 |
|------|------|------|
| 短按 (< 3秒) | 释放后触发 | 切换继电器状态 |
| 长按 (>= 3秒) | 释放后触发 | 清除配对信息，重新配对 |

## OTA 固件更新

### HTTP API

设备启动后会开启 OTA 服务器 (默认端口 8266)：

```bash
# 查看设备状态
curl http://<ESP32_IP>:8266/status

# 上传固件更新
curl -X POST -F "image=@firmware.bin" http://<ESP32_IP>:8266/update

# 远程重启
curl -X POST http://<ESP32_IP>:8266/reboot
```

### 通过 Gateway 命令更新

```json
{
  "command": "ota.update",
  "paramsJSON": "{\"url\":\"http://server/firmware.bin\"}"
}
```

## 支持的命令

### sensor.read

读取传感器数据（包含真实DHT22数据）。

**请求示例：**
```json
{
  "command": "sensor.read"
}
```

**响应示例：**
```json
{
  "nodeId": "...",
  "rssi": -45,
  "uptime": 3600,
  "freeHeap": 245760,
  "temperature": 25.5,
  "humidity": 65.0
}
```

### camera.snap

拍照（需要在固件中启用 `USE_CAMERA`）。

**请求示例：**
```json
{
  "command": "camera.snap"
}
```

**响应示例：**
```json
{
  "success": true,
  "format": "jpeg",
  "encoding": "base64",
  "data": "..."
}
```

### relay.set

控制继电器开关。

**请求示例：**
```json
{
  "command": "relay.set",
  "paramsJSON": "{\"state\":true}"
}
```

**响应示例：**
```json
{
  "success": true,
  "state": true
}
```

### ota.update

OTA固件更新。

**请求示例：**
```json
{
  "command": "ota.update",
  "paramsJSON": "{\"url\":\"http://server/firmware.bin\"}"
}
```

### device.info

获取设备信息。

**请求示例：**
```json
{
  "command": "device.info"
}
```

**响应示例：**
```json
{
  "nodeId": "esp32-s3-node001",
  "displayName": "ESP32-S3 Node",
  "version": "2.0.0",
  "platform": "esp32",
  "ip": "192.168.1.105",
  "rssi": -45,
  "uptime": 3600,
  "freeHeap": 245760,
  "paired": true
}
```

### system.notify

发送通知消息。

**请求示例：**
```json
{
  "command": "system.notify",
  "paramsJSON": "{\"message\":\"Hello ESP32!\"}"
}
```

## 硬件连接

### 引脚分配

```
摄像头 OV2640 (ESP32-S3 AI Thinker):
- D0-D7: GPIO 11, 9, 8, 10, 12, 18, 17, 16
- XCLK: GPIO 15
- PCLK: GPIO 13
- VSYNC: GPIO 6
- HREF: GPIO 7
- PWDN: GPIO -1
- RESET: GPIO -1
- SDA: GPIO 4
- SCL: GPIO 5

显示屏 ST7789:
- SCL: GPIO 39
- SDA: GPIO 38
- RST: GPIO 48
- DC: GPIO 40
- CS: GPIO 41
- BLK: GPIO 45

麦克风 INMP441 (I2S):
- WS: GPIO 10
- SCK: GPIO 9
- SD: GPIO 8

MPU6050 (I2C):
- SDA: GPIO 10
- SCL: GPIO 9
- INT: GPIO 3

DHT22 温湿度传感器:
- DATA: GPIO 4
- VCC: 3.3V
- GND: GND

继电器:
- IN1: GPIO 5
- VCC: 5V
- GND: GND

按钮:
- BOOT: GPIO 0 (内置)

状态LED:
- BUILTIN: GPIO 2 (内置)
```

### 启用摄像头

编辑 `main.cpp`，取消注释：

```cpp
#define USE_CAMERA
```

## 故障排除

### 无法连接WiFi

- 检查WiFi SSID和密码是否正确
- 确保2.4GHz频段（ESP32不支持5GHz）
- 检查WiFi信号强度

### 无法连接Gateway

- 确保Gateway正在运行
- 检查Gateway IP和端口配置
- 检查防火墙设置

### 配对失败

- 检查Gateway日志: `openclaw logs`
- 检查设备是否在待审批列表中
- 尝试清除配对信息重新配对

### 清除配对信息

```cpp
// 在setup()中添加：
preferences.begin("openclaw", false);
preferences.clear();
preferences.end();
```

## 开发指南

### 添加新命令

1. 在 `NODE_COMMANDS` 数组中添加命令名
2. 在 `handleInvokeRequest()` 中添加命令处理
3. 实现命令处理函数

示例：

```cpp
const char* NODE_COMMANDS[] = {
    "sensor.read",
    "mycommand"  // 添加新命令
};

void handleInvokeRequest(String id, String command, String paramsJSON) {
    // ...
    else if (command == "mycommand") {
        cmdMyCommand(id, paramsJSON);
    }
}

void cmdMyCommand(String reqId, String paramsJSON) {
    // 实现命令逻辑
    String payload = "{\"result\":\"ok\"}";
    sendResponse(reqId, true, payload);
}
```

### 添加传感器

参考 `cmdSensorRead()` 函数，添加传感器读取逻辑。

## 版本历史

### v3.1.0 (2026-03-05)

- ✅ DHT22 温湿度传感器支持
- ✅ 按钮交互 (短按切换继电器/长按清除配对)
- ✅ 继电器控制命令 (relay.set)
- ✅ OTA 固件更新 (HTTP服务器 + 命令)
- ✅ 摄像头功能框架 (需启用 USE_CAMERA)
- ✅ SPIFFS 文件系统支持
- ✅ 继电器状态持久化

### v3.0.0 (2026-03-04)

- ✅ Ed25519 签名算法
- ✅ 正确的v3认证载荷格式
- ✅ Base64 URL 编码
- ✅ NVS Token持久化
- ✅ 完善的WebSocket帧处理
- ✅ 命令处理框架

### v1.0.0

- 初始版本
- 基础WebSocket连接
- 简单的配对流程

## 许可证

MIT License
