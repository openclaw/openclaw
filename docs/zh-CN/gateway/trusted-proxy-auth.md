---
title: "受信任代理认证"
summary: "将 Gateway 认证委托给受信任的反向代理（Pomerium、Caddy、nginx + OAuth）"
read_when:
  - 在身份感知代理后面运行 OpenClaw
  - 在 OpenClaw 前面设置 Pomerium、Caddy 或带 OAuth 的 nginx
  - 修复反向代理设置下的 WebSocket 1008 未授权错误
  - 决定在哪里设置 HSTS 和其他 HTTP 加固头部
---

# 受信任代理认证

> ⚠️ **安全敏感功能。** 此模式将认证完全委托给您的反向代理。配置错误可能导致您的 Gateway 暴露于未授权访问。在启用之前请仔细阅读此页面。

## 何时使用

在以下情况下使用 `trusted-proxy` 认证模式：

-您在**身份感知代理**（Pomerium、Caddy + OAuth、nginx + oauth2-proxy、Traefik + forward auth）后面运行 OpenClaw
- 您的代理处理所有认证并通过头部传递用户身份
- 您在 Kubernetes 或容器环境中，代理是进入 Gateway 的唯一路径
- 您遇到 WebSocket `1008 unauthorized` 错误，因为浏览器无法在 WS 负载中传递令牌

## 何时不使用

- 如果您的代理不认证用户（仅是 TLS 终止器或负载均衡器）
- 如果存在任何绕过代理进入 Gateway 的路径（防火墙漏洞、内部网络访问）
- 如果您不确定您的代理是否正确剥离/覆盖转发的头部
- 如果您只需要个人单用户访问（考虑 Tailscale Serve + 回环以获得更简单的设置）

## 工作原理

1. 您的反向代理认证用户（OAuth、OIDC、SAML 等）
2. 代理添加一个包含已认证用户身份的头部（例如 `x-forwarded-user: nick@example.com`）
3. OpenClaw 检查请求是否来自**受信任代理 IP**（在 `gateway.trustedProxies` 中配置）
4. OpenClaw 从配置的头部提取用户身份
5. 如果一切检查通过，请求被授权

## Control UI 配对行为

当 `gateway.auth.mode = "trusted-proxy"` 处于活动状态且请求通过
受信任代理检查时，Control UI WebSocket 会话可以在没有设备
配对身份的情况下连接。

影响：

- 在此模式下，配对不再是 Control UI 访问的主要关卡。
- 您的反向代理认证策略和 `allowUsers` 成为有效的访问控制。
- 保持 Gateway 入口仅锁定到受信任代理 IP（`gateway.trustedProxies` + 防火墙）。

## 配置

```json5
{
  gateway: {
    // 对于同主机代理设置使用 loopback；远程代理主机使用 lan/custom
    bind: "loopback",

    // 关键：仅在此处添加您的代理的 IP
    trustedProxies: ["10.0.0.1", "172.17.0.1"],

    auth: {
      mode: "trusted-proxy",
      trustedProxy: {
        // 包含已认证用户身份的头部（必需）
        userHeader: "x-forwarded-user",

        // 可选：必须存在的头部（代理验证）
        requiredHeaders: ["x-forwarded-proto", "x-forwarded-host"],

        // 可选：限制特定用户（空 = 允许所有）
        allowUsers: ["nick@example.com", "admin@company.org"],
      },
    },
  },
}
```

如果 `gateway.bind` 是 `loopback`，请在
`gateway.trustedProxies` 中包含一个回环代理地址（`127.0.0.1`、`::1` 或等效的回环 CIDR）。

### 配置参考

| 字段 | 必需 | 描述 |
| ------------------------------------------- | -------- | --------------------------------------------------------------------------- |
| `gateway.trustedProxies` | 是 | 要信任的代理 IP 数组。来自其他 IP 的请求被拒绝。 |
| `gateway.auth.mode` | 是 | 必须是 `"trusted-proxy"` |
| `gateway.auth.trustedProxy.userHeader` | 是 | 包含已认证用户身份的头部名称 |
| `gateway.auth.trustedProxy.requiredHeaders` | 否 | 请求被信任必须存在的其他头部 |
| `gateway.auth.trustedProxy.allowUsers` | 否 | 用户身份允许列表。空意味着允许所有已认证用户。 |

## TLS 终止和 HSTS

使用一个 TLS 终止点并在那里应用 HSTS。

### 推荐模式：代理 TLS 终止

当您的反向代理为 `https://control.example.com` 处理 HTTPS 时，在代理处为该域设置 `Strict-Transport-Security`。

- 非常适合面向互联网的部署。
- 将证书 + HTTP 加固策略保存在一个地方。
- OpenClaw 可以保持在代理后面的回环 HTTP 上。

示例头部值：

```text
Strict-Transport-Security: max-age=31536000; includeSubDomains
```

### Gateway TLS 终止

如果 OpenClaw 本身直接提供 HTTPS（没有 TLS 终止代理），设置：

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

`strictTransportSecurity` 接受字符串头部值，或 `false` 明确禁用。

### 推广指南

- 首先使用较短的 max age（例如 `max-age=300`）同时验证流量。
- 仅在高度自信后增加为长期值（例如 `max-age=31536000`）。
- 仅在每个子域都准备好 HTTPS 时添加 `includeSubDomains`。
- 仅在您故意满足完整域集的预加载要求时才使用预加载。
- 仅回环的本地开发不会从 HSTS 中受益。

## 代理设置示例

### Pomerium

Pomerium 在 `x-pomerium-claim-email`（或其他声明头部）中传递身份，并在 `x-pomerium-jwt-assertion` 中传递 JWT。

```json5
{
  gateway: {
    bind: "lan",
    trustedProxies: ["10.0.0.1"], // Pomerium 的 IP
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

### 带 OAuth 的 Caddy

带 `caddy-security` 插件的 Caddy 可以认证用户并传递身份头部。

```json5
{
  gateway: {
    bind: "lan",
    trustedProxies: ["127.0.0.1"], // Caddy 的 IP（如果在同一主机上）
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

### Traefik 带 Forward Auth

```json5
{
  gateway: {
    bind: "lan",
    trustedProxies: ["172.17.0.1"], // Traefik 容器 IP
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

在启用受信任代理认证之前，验证：

- [ ] **代理是唯一路径**：Gateway 端口被防火墙保护，只允许您的代理访问
- [ ] **trustedProxies 最小化**：仅包含您实际的代理 IP，而不是整个子网
- [ ] **代理剥离头部**：您的代理覆盖（而不是追加）来自客户端的 `x-forwarded-*` 头部
- [ ] **TLS 终止**：您的代理处理 TLS；用户通过 HTTPS 连接
- [ ] **设置 allowUsers**（推荐）：限制到已知用户而不是允许任何已认证用户

## 安全审计

`openclaw security audit` 将以**严重**级别标记受信任代理认证。这是故意的 — 它提醒您正在将安全委托给您的代理设置。

审计检查：

- 缺少 `trustedProxies` 配置
- 缺少 `userHeader` 配置
- 空 `allowUsers`（允许任何已认证用户）

## 故障排除

### "trusted_proxy_untrusted_source"

请求未来自 `gateway.trustedProxies` 中的 IP。检查：

- 代理 IP 是否正确？（Docker 容器 IP 可能会更改）
- 您的代理前面是否有负载均衡器？
- 使用 `docker inspect` 或 `kubectl get pods -o wide` 查找实际 IP

### "trusted_proxy_user_missing"

用户头部为空或缺失。检查：

- 您的代理是否配置为传递身份头部？
- 头部名称是否正确？（不区分大小写，但拼写很重要）
- 用户在代理处实际是否已认证？

### "trusted*proxy_missing_header*\*"

必需的头部不存在。检查：

- 您的代理配置中是否有那些特定头部
- 头部是否在链中的某处被剥离

### "trusted_proxy_user_not_allowed"

用户已认证但不在 `allowUsers` 中。要么添加他们，要么移除允许列表。

### WebSocket 仍然失败

确保您的代理：

- 支持 WebSocket 升级（`Upgrade: websocket`、`Connection: upgrade`）
- 在 WebSocket 升级请求上传递身份头部（不仅仅是 HTTP）
- WebSocket 连接没有单独的 auth 路径

## 从令牌认证迁移

如果您从令牌认证迁移到受信任代理：

1. 配置您的代理认证用户并传递头部
2. 独立测试代理设置（带头部的 curl）
3. 使用受信任代理认证更新 OpenClaw 配置
4. 重启 Gateway
5. 从 Control UI 测试 WebSocket 连接
6. 运行 `openclaw security audit` 并审查结果

## 相关

- [安全](/gateway/security) — 完整安全指南
- [配置](/gateway/configuration) — 配置参考
- [远程访问](/gateway/remote) — 其他远程访问模式
- [Tailscale](/gateway/tailscale) — 更简单的 tailnet 专用访问替代方案