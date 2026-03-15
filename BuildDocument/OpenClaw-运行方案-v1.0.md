# OpenClaw 运行方案规范记录

## 方案选择：模式一（基础后台服务模式）

通过将 OpenClaw 作为后台服务进程提供网关与大模型接口功能。这是所有方案中最常用和最核心的运行方式。

## 适用目录结构说明

根据我们约定的全局规则，建立以下规范：

- **`BuildTools/`**: 存放临时用来做某件事情，且与项目源代码无关的工具类型的代码。在这里存放了用来执行启动流程的免输入脚本 `start_openclaw.sh`。
- **`BuildDocument/`**: 存放构建项目过程中生成的文档，也就是在维护和运行过程中产生的方案、计划和总结。如果你需要修改这份指引，请创建一个 `v1.1` 的文件。

## 日常运行与服务开机自启（推荐方案）

我们为您制作了基于 macOS 系统级守护进程（launchd）的常驻服务管理套件，存放在 `BuildTools/`：

1. **配置开机自动启动:**
   运行此脚本会将 OpenClaw 注册为开机自启服务，并在后台持续运行（即使关闭终端）：
   ```bash
   cd /Users/ppg/PPClaw/openclaw
   ./BuildTools/setup_autostart.sh
   ```
2. **停止服务:**
   如需停止并取消它的开机自启行为（仅对上面第1步配置的服务生效）：
   ```bash
   ./BuildTools/stop_openclaw.sh
   ```
3. **重启服务:**
   如需重启该系统级服务：
   ```bash
   ./BuildTools/restart_openclaw.sh
   ```

_注意：上述机制的日志输出将被保存在 `$HOME/.openclaw/logs/` 下。_

### 手动单次运行（非开机自启）

您仍可以使用最初创建的手动脚本，但它与上述系统级守护服务冲突（端口可能会占用）：

```bash
cd /Users/ppg/PPClaw/openclaw
./BuildTools/start_openclaw.sh
```

## 维护记录

- **v1.0** (当下时间) - 确立基于 pnpm 的模式一基础服务启动脚本。存放目录按照约定的规范分布。
