---
summary: "将 Gateway 网关认证委托给受信任的反向代理（Pomerium、Caddy、nginx + OAuth）"
read_when:
  - 在身份感知代理后面运行 OpenClaw
  - 在 OpenClaw 前面设置 Pomerium、Caddy 或 nginx + OAuth
  - 修复反向代理设置中的 WebSocket 1008 未授权错误
  - 决定在哪里设置 HSTS 和其他 HTTP 加固头
---

# Trusted Proxy Auth

> ⚠️ **安全敏感功能。** 此模式将认证完全委托给你的反向代理。错误配置可能会使你的 Gateway 网关暴露于未授权访问。启用前请仔细阅读本页。

## 何时使用

在以下情况使用 `trusted-proxy` 认证模式：

- 你在**身份感知代理**（Pomerium、Caddy + OAuth、nginx + oauth2-proxy、Traefik + forward auth）后面运行 OpenClaw
- 你的代理处理所有认证并通过头传递用户身份
- 你在 Kubernetes 或容器环境中，代理是到达 Gateway 网关的唯一路径
- 你遇到 WebSocket `1008 unauthorized` 错误，因为浏览器无法在 WS 负载中传递 token

## 何时不使用

- 如果你的代理不认证用户（仅作为 TLS 终止器或负载均衡器）
- 如果存在任何绕过代理到达 Gateway 网关的路径（防火墙漏洞、内部网络访问）
- 如果你不确定你的代理是否正确剥离/覆写转发头
- 如果你只需要个人单用户访问（考虑使用 Tailscale Serve + loopback 获得更简单的设置）

## 工作原理

1. 你的反向代理认证用户（OAuth、OIDC、SAML 等）
2. 代理添加包含已认证用户身份的头（例如 `x-forwarded-user: nick@example.com`）
3. OpenClaw 检查请求是否来自**受信任的代理 IP**（在 `gateway.trustedProxies` 中配置）
4. OpenClaw 从配置的头中提取用户身份
5. 如果所有检查通过，请求被授权

## 控制台 UI 配对行为

当 `gateway.auth.mode = "trusted-proxy"` 处于活跃状态且请求通过了受信任代理检查时，控制台 UI WebSocket 会话可以在没有设备配对身份的情况下连接。

影响：

- 在此模式下，配对不再是控制台 UI 访问的主要门控。
- 你的反向代理认证策略和 `allowUsers` 成为有效的访问控制。
- 将 Gateway 网关入口锁定为仅限受信任代理 IP（`gateway.trustedProxies` + 防火墙）。

## 配置

```json5
{
  gateway: {
    // 对于同主机代理设置使用 loopback；对于远程代理主机使用 lan/custom
    bind: "loopback",

    // 重要：仅在此处添加你的代理 IP
    trustedProxies: ["10.0.0.1", "172.17.0.1"],

    auth: {
      mode: "trusted-proxy",
      trustedProxy: {
        // 包含已认证用户身份的头（必需）
        userHeader: "x-forwarded-user",

        // 可选：必须存在的头（代理验证）
        requiredHeaders: ["x-forwarded-proto", "x-forwarded-host"],

        // 可选：限制为特定用户（空 = 允许所有）
        allowUsers: ["nick@example.com", "admin@company.org"],
      },
    },
  },
}
```

如果 `gateway.bind` 为 `loopback`，请在 `gateway.trustedProxies` 中包含一个 loopback 代理地址（`127.0.0.1`、`::1` 或等效的 loopback CIDR）。

### 配置参考

| 字段                                        | 必需 | 描述                                                   |
| ------------------------------------------- | ---- | ------------------------------------------------------ |
| `gateway.trustedProxies`                    | 是   | 要信任的代理 IP 地址数组。来自其他 IP 的请求将被拒绝。 |
| `gateway.auth.mode`                         | 是   | 必须为 `"trusted-proxy"`                               |
| `gateway.auth.trustedProxy.userHeader`      | 是   | 包含已认证用户身份的头名称                             |
| `gateway.auth.trustedProxy.requiredHeaders` | 否   | 请求被信任时必须存在的额外头                           |
| `gateway.auth.trustedProxy.allowUsers`      | 否   | 用户身份白名单。空值表示允许所有已认证用户。           |

## TLS 终止和 HSTS

使用一个 TLS 终止点并在该处应用 HSTS。

### 推荐模式：代理 TLS 终止

当你的反向代理处理 `https://control.example.com` 的 HTTPS 时，在代理端为该域名设置 `Strict-Transport-Security`。

- 适合面向互联网的部署。
- 将证书 + HTTP 加固策略集中在一个地方。
- OpenClaw 可以在代理后面保持 loopback HTTP。

示例头值：

```text
Strict-Transport-Security: max-age=31536000; includeSubDomains
```

### Gateway 网关 TLS 终止

如果 OpenClaw 自身直接提供 HTTPS（没有 TLS 终止代理），请设置：

```json5
{
  gateway: {
    tls: { enabled: true },
    http: {
      securityHeaders: {
        strictTransportSecurity: "max-age=31536000; includeSubDomains",
      },
    },
  },
}
```

`strictTransportSecurity` 接受字符串头值，或 `false` 以显式禁用。

### 推出指导

- 在验证流量时先从较短的 max age 开始（例如 `max-age=300`）。
- 确信无误后再增加到长期值（例如 `max-age=31536000`）。
- 仅在所有子域名都已准备好 HTTPS 时才添加 `includeSubDomains`。
- 仅在你有意满足完整域名集的 preload 要求时才使用 preload。
- 仅 loopback 的本地开发不会从 HSTS 中受益。

## 代理设置示例

### Pomerium

Pomerium 在 `x-pomerium-claim-email`（或其他 claim 头）中传递身份，并在 `x-pomerium-jwt-assertion` 中传递 JWT。

```json5
{
  gateway: {
    bind: "lan",
    trustedProxies: ["10.0.0.1"], // Pomerium's IP
    auth: {
      mode: "trusted-proxy",
      trustedProxy: {
        userHeader: "x-pomerium-claim-email",
        requiredHeaders: ["x-pomerium-jwt-assertion"],
      },
    },
  },
}
```

Pomerium 配置片段：

```yaml
routes:
  - from: https://openclaw.example.com
    to: http://openclaw-gateway:18789
    policy:
      - allow:
          or:
            - email:
                is: nick@example.com
    pass_identity_headers: true
```

### Caddy + OAuth

Caddy 配合 `caddy-security` 插件可以认证用户并传递身份头。

```json5
{
  gateway: {
    bind: "lan",
    trustedProxies: ["127.0.0.1"], // Caddy's IP (if on same host)
    auth: {
      mode: "trusted-proxy",
      trustedProxy: {
        userHeader: "x-forwarded-user",
      },
    },
  },
}
```

Caddyfile 片段：

```
openclaw.example.com {
    authenticate with oauth2_provider
    authorize with policy1

    reverse_proxy openclaw:18789 {
        header_up X-Forwarded-User {http.auth.user.email}
    }
}
```

### nginx + oauth2-proxy

oauth2-proxy 认证用户并在 `x-auth-request-email` 中传递身份。

```json5
{
  gateway: {
    bind: "lan",
    trustedProxies: ["10.0.0.1"], // nginx/oauth2-proxy IP
    auth: {
      mode: "trusted-proxy",
      trustedProxy: {
        userHeader: "x-auth-request-email",
      },
    },
  },
}
```

nginx 配置片段：

```nginx
location / {
    auth_request /oauth2/auth;
    auth_request_set $user $upstream_http_x_auth_request_email;

    proxy_pass http://openclaw:18789;
    proxy_set_header X-Auth-Request-Email $user;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
}
```

### Traefik + Forward Auth

```json5
{
  gateway: {
    bind: "lan",
    trustedProxies: ["172.17.0.1"], // Traefik container IP
    auth: {
      mode: "trusted-proxy",
      trustedProxy: {
        userHeader: "x-forwarded-user",
      },
    },
  },
}
```

## 安全检查清单

启用 trusted-proxy 认证前，请验证：

- [ ] **代理是唯一路径**：Gateway 网关端口已通过防火墙隔离，仅允许你的代理访问
- [ ] **trustedProxies 最小化**：仅包含你实际的代理 IP，而非整个子网
- [ ] **代理剥离头**：你的代理覆写（而非追加）来自客户端的 `x-forwarded-*` 头
- [ ] **TLS 终止**：你的代理处理 TLS；用户通过 HTTPS 连接
- [ ] **已设置 allowUsers**（推荐）：限制为已知用户，而非允许任何已认证用户

## 安全审计

`openclaw security audit` 会将 trusted-proxy 认证标记为**严重**级别的发现。这是有意为之——它提醒你正在将安全性委托给你的代理设置。

审计检查以下内容：

- 缺少 `trustedProxies` 配置
- 缺少 `userHeader` 配置
- 空的 `allowUsers`（允许任何已认证用户）

## 故障排除

### "trusted_proxy_untrusted_source"

请求不是来自 `gateway.trustedProxies` 中的 IP。请检查：

- 代理 IP 是否正确？（Docker 容器 IP 可能会变化）
- 你的代理前面是否有负载均衡器？
- 使用 `docker inspect` 或 `kubectl get pods -o wide` 查找实际 IP

### "trusted_proxy_user_missing"

用户头为空或缺失。请检查：

- 你的代理是否配置为传递身份头？
- 头名称是否正确？（不区分大小写，但拼写很重要）
- 用户是否确实在代理端完成了认证？

### "trusted*proxy_missing_header*\*"

必需的头不存在。请检查：

- 你的代理配置中是否包含这些特定的头
- 头是否在链路中的某处被剥离

### "trusted_proxy_user_not_allowed"

用户已认证但不在 `allowUsers` 中。请添加该用户或移除白名单。

### WebSocket 仍然失败

确保你的代理：

- 支持 WebSocket 升级（`Upgrade: websocket`、`Connection: upgrade`）
- 在 WebSocket 升级请求（不仅仅是 HTTP）上传递身份头
- 没有为 WebSocket 连接设置单独的认证路径

## 从 Token 认证迁移

如果你正在从 token 认证迁移到 trusted-proxy：

1. 配置你的代理以认证用户并传递头
2. 独立测试代理设置（使用 curl 带头测试）
3. 更新 OpenClaw 配置为 trusted-proxy 认证
4. 重启 Gateway 网关
5. 从控制台 UI 测试 WebSocket 连接
6. 运行 `openclaw security audit` 并审查发现

## 相关文档

- [安全](/gateway/security) — 完整安全指南
- [配置](/gateway/configuration) — 配置参考
- [远程访问](/gateway/remote) — 其他远程访问模式
- [Tailscale](/gateway/tailscale) — 仅限 tailnet 访问的更简单替代方案
