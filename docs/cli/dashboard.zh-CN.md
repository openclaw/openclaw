---
summary: "`openclaw dashboard`的CLI参考（打开控制UI）"
read_when:
  - 您想使用当前令牌打开控制UI
  - 您想打印URL而不启动浏览器
title: "dashboard"
---

# `openclaw dashboard`

使用您当前的认证打开控制UI。

```bash
openclaw dashboard
openclaw dashboard --no-open
```

注意事项：

- `dashboard`在可能时解析配置的`gateway.auth.token` SecretRef。
- 对于SecretRef管理的令牌（已解析或未解析），`dashboard`打印/复制/打开非令牌化的URL，以避免在终端输出、剪贴板历史或浏览器启动参数中暴露外部秘密。
- 如果`gateway.auth.token`由SecretRef管理但在此命令路径中未解析，该命令会打印非令牌化的URL和明确的补救指导，而不是嵌入无效的令牌占位符。