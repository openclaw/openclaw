# OpenClaw PR 提交指南

## 项目信息
- **原始仓库**: https://github.com/openclaw/openclaw
- **你的 fork**: https://github.com/shoa-lin/openclaw
- **当前分支**: feat/web-search-prime
- **当前提交**: bbc5fe80f

## 贡献规则来源
- [CONTRIBUTING.md](https://github.com/openclaw/openclaw/blob/main/CONTRIBUTING.md)
- [GitHub Discussions](https://github.com/openclaw/openclaw/discussions)
- [Discord](https://discord.gg/qkhbAGHRBT)

## 维护者
- [@steipete](https://github.com/steipete) - Benevolent Dictator
- [@thewilloftheshadow](https://github.com/thewilloftheshadow) - Discord + Slack
- [@joshp123](https://github.com/joshp123) - Telegram, API, Nix
- [@cpojer](https://github.com/cpojer) - JS Infra

## 提交前检查清单
- [ ] 本地测试: `pnpm build && pnpm check && pnpm test`
- [ ] PR 聚焦单一功能
- [ ] 描述清楚 what & why

## AI PR 要求
- [ ] 标记为 AI-assisted
- [ ] 说明测试程度 (untested/lightly tested/fully tested)
- [ ] 包含提示词/会话日志
- [ ] 确认理解代码作用

## 当前项目重点
- **稳定性**: 修复连接边界情况 (WhatsApp/Telegram)
- **UX**: 改进向导和错误消息
- **Skills**: 扩展技能库
- **Performance**: 优化 token 使用和压缩逻辑

## API 文档
- [GLM 联网搜索 MCP 文档](https://docs.bigmodel.cn/cn/coding-plan/mcp/search-mcp-server)
