# 🦞 CiwardClaw

<p align="center">
  <strong>一个社区维护、功能增强的 OpenClaw 魔改版。</strong>
</p>

## 🌟 为什么选择 CiwardClaw？

这是一个由社区独立维护的 [OpenClaw](https://github.com/openclaw/openclaw) 分支，旨在解决上游更新缓慢的问题，并引入了多项关键的稳定性、兼容性和可用性提升。

### 核心特性与改进（从新到旧排列）

- ♊ **Gemini CLI 集成**: 改用 Gemini CLI 的请求方式，有效避免短时间的 API 请求限额（Rate Limit）问题。
- 🔄 **Codex 多账号轮换自动降级**: 增加了对多个 Codex 账号配置的健壮支持，实现无缝轮换和自动 Fallback。
- ⚡ **Steer Mode (接管模式) 消息直接注入**: 在各通道引入了 Steer Mode 新功能，允许你在 Agent 运行时直接插入指令进行接管，而无需排队等待。
- 🛡️ **Gateway 重启恢复 (Restart Recovery)**: 实现了无痛的服务重启，重启后可无缝恢复进行中的 Agent 任务——再也不会丢失会话上下文。
- 🌐 **更健壮的浏览器自动化 (Browser Automation)**: 增强了目标查找恢复能力，并严格对齐了路由超时预算，消除了很多误导性的浏览器调用失败错误。

## 📖 官方文档与上游说明

由于 CiwardClaw 是在 OpenClaw 的基础上构建的，其核心的安装和使用方式保持不变。有关安装指南、官方文档以及 OpenClaw 的通用功能，请参阅上游的原始仓库：

👉 **[OpenClaw 官方 README](README_UPSTREAM.md)**  
👉 **[OpenClaw 官方文档](https://docs.openclaw.ai)**

[🌐 English Version (README.md)](README.md)

## 🤝 贡献者

- **[@Ciward](https://github.com/Ciward)** - CiwardClaw 魔改版的核心开发者与维护者。
