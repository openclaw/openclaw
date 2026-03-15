# 方案：执行 `openclaw onboard --install-daemon` 并分步确认 (v1.0)

本方案旨在运行 `openclaw onboard --install-daemon` 命令，并按照用户要求，在每一步关键操作前进行解释并请求确认。

## 用户审核事项

- **守护进程安装**：该命令会将 OpenClaw Gateway 设置为 macOS 的 LaunchAgent，使其在后台自动运行。
- **配置文件修改**：如果当前没有配置令牌，系统会生成一个新的令牌并存入 `config.json`。

## 拟议步骤

### 1. 准备阶段

- [ ] 解释 `--install-daemon` 在 macOS 上的具体行为。
- [ ] 请求运行初始检测（检查是否已安装，准备安装计划）。

### 2. 执行阶段 (分步确认)

- [ ] **步骤 A：身份验证令牌准备**
  - 解释：检查配置文件中是否存在 `gateway.auth.token`，若无则生成。
  - 确认后执行。
- [ ] **步骤 B：构建启动配置**
  - 解释：确定启动路径、端口和环境变量。
  - 确认后显示配置详情。
- [ ] **步骤 C：写入 LaunchAgent 配置文件**
  - 解释：在 `~/Library/LaunchAgents/` 创建 `.plist` 文件。
  - 确认后执行。
- [ ] **步骤 D：启动并载入服务**
  - 解释：使用 `launchctl` 加载新创建的服务。
  - 确认后执行。

### 3. 验证阶段

- [ ] 运行 `launchctl list | grep openclaw` 验证服务状态。
- [ ] 检查日志输出确认服务正常运行。

## 验证计划

### 自动化测试

- 运行 `openclaw gateway status` (如果存在该命令) 或检查 `launchctl` 输出。

### 手动验证

- 用户可以尝试访问 Gateway 端口确认服务在线。
