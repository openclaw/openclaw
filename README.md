# 🦞 Crayfish-Bot — Moltbot 中文版 / Chinese Fork

[English](#english) | [中文](#中文)

---

## English

**Crayfish-Bot** is a Chinese fork of [Moltbot](https://github.com/moltbot/moltbot), a personal AI assistant that runs on your own devices.

### Features

- ✅ **Domestic Model Support** - MiniMax, Silicon Flow, and other Chinese AI models
- ✅ **Full Chinese Localization** - Docs, UI, and error messages in Chinese
- ✅ **Domestic Service Integration** - Adapted for Chinese API services
- ✅ **Active Upstream Sync** - Regular updates from upstream Moltbot

### Quick Start

```bash
# Clone the repository
git clone https://github.com/BlackBearCC/crayfish-bot.git
cd crayfish-bot

# Install dependencies
pnpm install

# Build
pnpm build

# Run onboarding
pnpm moltbot onboard --install-daemon
```

### Installation

```bash
# Global install
pnpm add -g crayfish-bot

# Start
crayfish-bot onboard --install-daemon
```

### Documentation

- [中文文档 (In Progress)](https://docs.crayfish.cn)
- [Upstream Docs](https://docs.molt.bot)

### Contributing

Issues and PRs welcome!

1. Fork this repository
2. Create your branch (`git checkout -b feature/xxx`)
3. Commit your changes (`git commit -am 'Add new feature'`)
4. Push to the branch (`git push origin feature/xxx`)
5. Open a Pull Request

### Contact

- GitHub Issues: https://github.com/BlackBearCC/crayfish-bot/issues

---

## 中文

**小龙虾 Bot** 是 [Moltbot](https://github.com/moltbot/moltbot) 的中文分支，一个运行在你自己设备上的个人 AI 助手。

### 主要特性

- ✅ **国内模型支持** - 适配 MiniMax、硅基流动等国产模型
- ✅ **汉化完善** - 文档、界面、错误信息全面汉化
- ✅ **国内服务集成** - 适配国内 API 服务
- ✅ **持续同步** - 定期同步上游更新

### 快速开始

```bash
# 克隆本项目
git clone https://github.com/BlackBearCC/crayfish-bot.git
cd crayfish-bot

# 安装依赖
pnpm install

# 构建
pnpm build

# 启动引导
pnpm moltbot onboard --install-daemon
```

### 安装

```bash
# 全局安装
pnpm add -g crayfish-bot

# 启动
crayfish-bot onboard --install-daemon
```

### 文档

- [中文文档 (建设中)](https://docs.crayfish.cn)
- [上游文档](https://docs.molt.bot)

### 参与贡献

欢迎提交 Issue 和 PR！

1. Fork 本项目
2. 创建分支 (`git checkout -b feature/xxx`)
3. 提交更改 (`git commit -am '添加新功能'`)
4. 推送到分支 (`git push origin feature/xxx`)
5. 创建 Pull Request

### 交流群

- GitHub Issues: https://github.com/BlackBearCC/crayfish-bot/issues

---

## 与上游区别 | Differences from Upstream

| 特性 / Feature | 上游 Moltbot | 本项目 Crayfish-Bot |
|---------------|-------------|---------------------|
| 模型 / Models | OpenAI/Anthropic | + MiniMax/国产模型 |
| 文档 / Docs | 英文 | 中文为主 |
| 服务 / Services | 国外为主 | 国内优先 |
| 社区 / Community | Discord | 中文社区 |

---

*本项目基于 [Moltbot](https://github.com/moltbot/moltbot)，遵循 MIT 协议。*
