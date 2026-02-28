---
summary: 将 Gateway 认证委托给受信任反向代理（Pomerium/Caddy/nginx）
title: Trusted Proxy 认证
sidebarTitle: Trusted Proxy Auth
---

# Trusted Proxy 认证

该页面是英文文档的中文占位版本，完整内容请先参考英文版：[Trusted Proxy Auth](/gateway/trusted-proxy-auth)。

## 中文速览

当 `gateway.auth.mode = "trusted-proxy"` 时，OpenClaw 会把鉴权委托给你的反向代理。

启用前务必确认：

- 只有代理可以访问 Gateway（网络与防火墙已收口）。
- `gateway.trustedProxies` 仅包含真实代理 IP。
- 代理会覆盖并校验身份头，防止伪造 `x-forwarded-*`。
- 建议配置 `allowUsers` 做二次限制。

常见错误：

- `trusted_proxy_untrusted_source`：请求来源 IP 不在 trustedProxies。
- `trusted_proxy_user_missing`：代理未传递用户身份头。
- `trusted_proxy_user_not_allowed`：用户不在 allowUsers 列表。

完整配置字段、TLS/HSTS 建议及 Pomerium/Caddy/nginx/Traefik 示例，请阅读英文原文。
