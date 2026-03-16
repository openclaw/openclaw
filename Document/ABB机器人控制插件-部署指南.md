# ABB机器人控制插件 - 部署和使用指南

## 项目完成情况

### ✓ 已完成的工作

1. **MCP插件开发** (`extensions/abb-robot-control/`)
   - ✓ `index.ts` - 插件入口
   - ✓ `src/abb-controller.ts` - ABB控制器接口（支持PC SDK）
   - ✓ `src/abb-robot-tool.ts` - MCP工具定义
   - ✓ `src/abb-robot-tool-actions.ts` - 动作处理器
   - ✓ `src/robot-config-loader.ts` - 机器人配置加载器
   - ✓ `package.json` - 依赖配置
   - ✓ `openclaw.plugin.json` - 插件元数据

2. **机器人配置** (`extensions/abb-robot-control/robots/`)
   - ✓ `abb-crb-15000.json` - ABB CRB 15000配置
   - ✓ `robot-config.schema.json` - JSON Schema

3. **Skill文件** (`skills/abb-robot-control/`)
   - ✓ `SKILL.md` - 自然语言控制技能定义

4. **文档**
   - ✓ `README.md` - 完整使用文档（中英文）

### 核心功能

#### 1. 连接管理
- 连接到ABB机器人控制器（通过IP地址）
- 自动识别机器人型号（基于DH参数和关节限位）
- 支持多机器人配置

#### 2. 运动控制
- 设置关节位置（带安全限位验证）
- 应用预设位置（home, ready, inspect等）
- 执行运动序列（wave, dance, nod等）
- 回到初始位置

#### 3. RAPID程序
- 自动生成RAPID代码
- 执行RAPID程序
- 加载和启动程序

#### 4. 状态监控
- 获取控制器状态
- 读取当前关节位置
- 电机状态控制

## 部署步骤

### 方法一：使用批处理自动部署（推荐）

```batch
cd D:\OpenClaw\Develop\openclaw
deploy_menu.bat 4
```

这将执行：
1. 编译项目（pnpm install + ui:build + build:docker）
2. 打包并更新deploy目录
3. 重启服务

### 方法二：手动部署

#### 1. 编译项目

```batch
cd D:\OpenClaw\Develop\openclaw
pnpm install --no-frozen-lockfile
pnpm ui:build
pnpm build:docker
```

#### 2. 打包

```batch
pnpm pack --pack-destination D:\OpenClaw\deploy --config.ignore-scripts=true
```

#### 3. 部署

```batch
cd D:\OpenClaw\deploy
# 解压最新的tgz包到openclaw-runtime-next
tar -xf openclaw-2026.3.14.tgz -C openclaw-runtime-next

cd openclaw-runtime-next\package
pnpm install --prod --ignore-scripts
```

#### 4. 复制UI资源

```batch
xcopy D:\OpenClaw\Develop\openclaw\dist\control-ui D:\OpenClaw\deploy\openclaw-runtime-next\package\dist\control-ui /E /I /Y
```

#### 5. 启动服务

```batch
cd D:\OpenClaw\deploy\openclaw-runtime-next\package
node openclaw.mjs gateway --port 18789 --verbose
```

## 启用ABB插件

### 1. 编辑配置文件

编辑 `D:\OpenClaw\deploy\config.json` 或 `~/.openclaw/openclaw.json`：

```json
{
  "plugins": {
    "entries": {
      "abb-robot-control": {
        "enabled": true,
        "config": {
          "controllerHost": "192.168.125.1",
          "controllerPort": 7000,
          "defaultRobot": "abb-crb-15000",
          "autoConnect": false
        }
      }
    }
  }
}
```

### 2. 重启服务

```batch
cd D:\OpenClaw\deploy\openclaw-runtime-next\package
node openclaw.mjs gateway stop
node openclaw.mjs gateway --port 18789 --verbose
```

## 使用示例

### 1. 访问Web界面

打开浏览器访问：`http://127.0.0.1:18789`

### 2. 连接机器人

```
用户: 连接到192.168.125.1的ABB机器人
AI: [使用abb_robot工具连接]
```

### 3. 控制机器人

```
用户: 移动到准备位置
AI: [应用ready预设]

用户: 将关节1设置为45度
AI: [设置关节角度]

用户: 让机器人挥手
AI: [执行wave_sequence]

用户: 查看当前位置
AI: [获取关节状态]
```

## MCP工具：abb_robot

### 可用动作

| 动作 | 说明 | 参数 |
|------|------|------|
| `connect` | 连接控制器 | host, port, robot_id |
| `disconnect` | 断开连接 | - |
| `get_status` | 获取状态 | - |
| `get_joints` | 获取关节位置 | - |
| `set_joints` | 设置关节位置 | joints, speed |
| `set_preset` | 应用预设 | preset, speed |
| `run_sequence` | 执行序列 | sequence |
| `go_home` | 回到初始位置 | - |
| `execute_rapid` | 执行RAPID代码 | rapid_code, module_name |
| `motors_on/off` | 控制电机 | - |
| `list_robots` | 列出机器人配置 | - |
| `list_presets` | 列出预设 | robot_id |
| `list_sequences` | 列出序列 | robot_id |

### 示例调用

```javascript
// 连接
abb_robot action:connect host:192.168.125.1 port:7000

// 移动
abb_robot action:set_joints joints:[0,-30,60,0,30,0] speed:50

// 预设
abb_robot action:set_preset preset:ready speed:75

// 序列
abb_robot action:run_sequence sequence:wave_sequence

// 状态
abb_robot action:get_status
abb_robot action:get_joints
```

## 机器人配置

### ABB CRB 15000 配置

位置：`extensions/abb-robot-control/robots/abb-crb-15000.json`

包含：
- 6个关节的限位和速度
- DH参数
- 预设位置（home, ready, inspect等）
- 运动序列（wave, dance, nod等）

### 添加新机器人

1. 创建配置文件：`robots/<robot-id>.json`
2. 定义关节参数、DH参数、预设和序列
3. 连接时自动识别或手动指定robot_id

## 故障排除

### 问题1：无法连接控制器

**解决方案：**
- 检查IP地址和端口
- 确认网络连接
- 验证防火墙设置
- 确保控制器在AUTO模式

### 问题2：UI无法访问

**解决方案：**
```batch
# 复制UI资源
xcopy D:\OpenClaw\Develop\openclaw\dist\control-ui D:\OpenClaw\deploy\openclaw-runtime-next\package\dist\control-ui /E /I /Y
```

### 问题3：插件未加载

**解决方案：**
- 检查config.json中plugins配置
- 确认插件文件存在
- 重启gateway服务

### 问题4：依赖安装失败

**解决方案：**
```batch
# 配置git使用HTTPS
git config --global url."https://github.com/".insteadOf "git+ssh://git@github.com/"

# 重新安装
pnpm install --no-frozen-lockfile
```

## 技术架构

```
OpenClaw Chat UI (浏览器)
    ↓ HTTP/WebSocket
Gateway (Node.js)
    ↓ MCP Tool
abb_robot Tool
    ↓
ABB Controller Interface
    ↓ (未来：C# Bridge + PC SDK)
Robot Controller (IRC5)
    ↓ TCP/IP
Physical Robot
```

## 开发说明

### 当前实现状态

- ✓ 完整的MCP工具接口
- ✓ 机器人配置管理
- ✓ RAPID代码生成
- ✓ 自动机器人识别
- ✓ 多机器人支持
- ⚠ 模拟控制器响应（用于开发测试）
- ⚠ C# Bridge未实现（需要ABB PC SDK）

### 生产部署需求

1. **安装ABB PC SDK 2025**
   - 位置：`C:\Program Files (x86)\ABB\SDK\PCSDK 2025`

2. **实现C# Bridge**
   - 使用edge-js或类似技术
   - 调用ABB.Robotics.Controllers API
   - 处理实际的控制器通信

3. **测试流程**
   - 先在虚拟控制器测试
   - 再连接实际机器人
   - 验证所有功能

## 文件清单

### 插件文件
```
extensions/abb-robot-control/
├── index.ts                          # 插件入口
├── package.json                      # 依赖配置
├── openclaw.plugin.json              # 插件元数据
├── README.md                         # 文档
├── src/
│   ├── abb-controller.ts             # 控制器接口
│   ├── abb-robot-tool.ts             # MCP工具
│   ├── abb-robot-tool-actions.ts     # 动作处理
│   └── robot-config-loader.ts        # 配置加载
└── robots/
    ├── abb-crb-15000.json            # CRB 15000配置
    └── robot-config.schema.json      # JSON Schema
```

### Skill文件
```
skills/abb-robot-control/
└── SKILL.md                          # 技能定义
```

## 版本信息

- **版本**: 1.0.0
- **日期**: 2026-03-14
- **OpenClaw版本**: 2026.3.13+
- **Node.js**: 18+
- **ABB PC SDK**: 2025+

## 许可证

本插件是OpenClaw项目的一部分。

---

**注意**: 当前版本使用模拟响应进行开发和测试。连接实际ABB机器人需要：
1. 安装ABB PC SDK
2. 实现C# Bridge
3. 配置网络连接到控制器

详细技术文档请参考：
- `extensions/abb-robot-control/README.md`
- `skills/abb-robot-control/SKILL.md`
