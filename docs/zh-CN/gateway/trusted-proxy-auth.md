---
read_when:
  - 在身份感知反向代理后运行 OpenClaw
  - 在 OpenClaw 前配置 Pomerium、Caddy、nginx（含 OAuth）或 Traefik
  - 处理反向代理场景下的 WebSocket 1008 unauthorized 错误
  - 决定应在哪一层设置 HSTS 与 HTTP 安全响应头
summary: 将 Gateway 认证委托给受信任反向代理（Pomerium、Caddy、nginx + OAuth、Traefik）
title: Trusted Proxy 认证
sidebarTitle: Trusted Proxy Auth
x-i18n:
  generated_at: "2026-03-01T02:08:00Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: 743ad7da60c78b6f0554f1c6ab09a10a5f4771a124d2636d732cab377013a440
  source_path: docs/gateway/trusted-proxy-auth.md
  workflow: 15
---

# Trusted Proxy 认证

> ⚠️ **这是安全敏感功能。** 启用此模式后，Gateway 认证完全依赖你的反向代理。配置错误会直接暴露未授权访问入口。请在完整阅读后再启用。

## 何时使用

在以下情况使用 `trusted-proxy` 认证模式：

- 你将 OpenClaw 部署在**身份感知代理**之后（Pomerium、Caddy + OAuth、nginx + oauth2-proxy、Traefik + forward auth）。
- 认证由代理统一完成，并通过请求头传递用户身份。
- 你在 Kubernetes 或容器环境中部署，且代理是访问 Gateway 的唯一入口。
- 你在浏览器访问控制台时遇到 WebSocket `1008 unauthorized`（常见于 WS 无法携带 token 负载的代理链路）。

## 何时不要使用

- 你的代理不做用户认证（只做 TLS 终止或负载均衡）。
- 存在绕过代理直连 Gateway 的路径（防火墙漏口、内网直通）。
- 你无法确认代理是否会剥离/覆盖客户端传入的 forwarded 头。
- 你只是个人单用户使用（通常 Tailscale Serve + loopback 更简单且更稳）。

## 工作原理

1. 反向代理先完成用户认证（OAuth/OIDC/SAML 等）。
2. 代理把认证后的用户标识写入请求头（例如 `x-forwarded-user: nick@example.com`）。
3. OpenClaw 检查请求来源 IP 是否在 `gateway.trustedProxies` 列表中。
4. OpenClaw 从配置的身份头提取用户标识。
5. 全部校验通过后，请求被授权。

## 配置示例

```json5
{
  gateway: {
    // 同机代理建议 loopback；远端代理建议 lan/custom
    bind: "loopback",

    // 关键：只填写真实代理 IP
    trustedProxies: ["10.0.0.1", "172.17.0.1"],

    auth: {
      mode: "trusted-proxy",
      trustedProxy: {
        // 必填：认证后用户身份头
        userHeader: "x-forwarded-user",

        // 可选：必须出现的校验头（用于确认来自代理）
        requiredHeaders: ["x-forwarded-proto", "x-forwarded-host"],

        // 可选：用户白名单（空数组=允许所有已认证用户）
        allowUsers: ["nick@example.com", "admin@company.org"],
      },
    },
  },
}
```

当 `gateway.bind = "loopback"` 时，确保 `gateway.trustedProxies` 包含 loopback 代理地址（如 `127.0.0.1`、`::1` 或对应 loopback CIDR）。

### 配置项对照

| 字段                                        | 必填 | 说明                                               |
| ------------------------------------------- | ---- | -------------------------------------------------- |
| `gateway.trustedProxies`                    | 是   | 可信代理 IP 列表。来源 IP 不在列表内会被拒绝。     |
| `gateway.auth.mode`                         | 是   | 必须为 `"trusted-proxy"`。                         |
| `gateway.auth.trustedProxy.userHeader`      | 是   | 承载认证后用户身份的请求头名。                     |
| `gateway.auth.trustedProxy.requiredHeaders` | 否   | 额外要求必须存在的请求头。                         |
| `gateway.auth.trustedProxy.allowUsers`      | 否   | 允许的用户身份白名单。空值表示允许所有已认证用户。 |

## TLS 终止与 HSTS

只保留一个 TLS 终止点，并在该层设置 HSTS。

### 推荐：在反向代理层做 TLS 终止

如果外部访问入口是 `https://control.example.com`，建议在代理层设置 `Strict-Transport-Security`：

- 适合公网部署；
- 证书与 HTTP 安全策略集中管理；
- OpenClaw 可在代理后继续使用 loopback HTTP。

示例：

```text
Strict-Transport-Security: max-age=31536000; includeSubDomains
```

### 在 Gateway 自身做 TLS 终止

当 OpenClaw 直接对外提供 HTTPS（无 TLS 终止代理）时，可这样配置：

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

`strictTransportSecurity` 支持字符串值；显式禁用可设为 `false`。

### 发布建议

- 初期先用较短 `max-age`（如 `max-age=300`）观察行为；
- 验证稳定后再提升为长期值（如 `max-age=31536000`）；
- 仅在全部子域都已 HTTPS 化时再加 `includeSubDomains`；
- 仅在确认满足预加载要求时再启用 preload；
- 仅 loopback 的本地开发通常不需要 HSTS。

## 代理配置示例

### Pomerium

Pomerium 可通过 `x-pomerium-claim-email`（或其它 claim 头）传递用户身份，并使用 `x-pomerium-jwt-assertion` 作为断言头。

```json5
{
  gateway: {
    bind: "lan",
    trustedProxies: ["10.0.0.1"], // Pomerium IP
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

Pomerium 路由示例：

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

使用 `caddy-security` 插件时，Caddy 可认证用户并转发身份头。

```json5
{
  gateway: {
    bind: "lan",
    trustedProxies: ["127.0.0.1"], // 同机部署的 Caddy
    auth: {
      mode: "trusted-proxy",
      trustedProxy: {
        userHeader: "x-forwarded-user",
      },
    },
  },
}
```

Caddyfile 示例：

```text
openclaw.example.com {
    authenticate with oauth2_provider
    authorize with policy1

    reverse_proxy openclaw:18789 {
        header_up X-Forwarded-User {http.auth.user.email}
    }
}
```

### nginx + oauth2-proxy

oauth2-proxy 认证后通常用 `x-auth-request-email` 传递用户。

```json5
{
  gateway: {
    bind: "lan",
    trustedProxies: ["10.0.0.1"], // nginx / oauth2-proxy IP
    auth: {
      mode: "trusted-proxy",
      trustedProxy: {
        userHeader: "x-auth-request-email",
      },
    },
  },
}
```

nginx 示例：

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

启用 `trusted-proxy` 前请逐项确认：

- [ ] **代理是唯一入口**：Gateway 端口仅允许代理访问；
- [ ] **trustedProxies 最小化**：只填代理真实 IP，不填整段网段；
- [ ] **代理覆盖头**：代理必须覆盖（而非追加）客户端传入的 `x-forwarded-*`；
- [ ] **TLS 就绪**：用户访问链路是 HTTPS；
- [ ] **建议启用白名单**：优先配置 `gateway.auth.trustedProxy.allowUsers`，避免“任何已认证用户都可访问”。

## 安全审计说明

`openclaw security audit` 会把 trusted-proxy 认证标为 **critical**。这是预期行为：系统会提醒你“认证职责已外包给代理配置”。

审计重点包括：

- 缺失 `gateway.trustedProxies`；
- 缺失 `userHeader`；
- `gateway.auth.trustedProxy.allowUsers` 为空（允许所有已认证用户）。

## 故障排查

### `trusted_proxy_untrusted_source`

请求来源 IP 不在 `gateway.trustedProxies` 中。

排查：

- 代理 IP 是否正确（容器 IP 可能变化）；
- 代理前是否还有 LB/NAT；
- 用 `docker inspect` 或 `kubectl get pods -o wide` 查看实际来源地址。

### `trusted_proxy_user_missing`

身份头缺失或为空。

排查：

- 代理是否配置了身份头转发；
- 头名拼写是否与配置一致；
- 用户是否真的在代理层完成认证。

### `trusted_proxy_missing_header_*`

某个 `requiredHeaders` 要求的头不存在。

排查：

- 代理配置是否设置该头；
- 代理链路中是否有组件剥离了该头。

### `trusted_proxy_user_not_allowed`

用户已认证，但不在白名单中。

处理：把用户加入 `gateway.auth.trustedProxy.allowUsers`，或按策略移除白名单限制。

### WebSocket 仍失败

确认代理同时满足：

- 支持 WebSocket 升级（`Upgrade: websocket`、`Connection: upgrade`）；
- 在 WS 升级请求上也会传递身份头；
- HTTP 与 WS 没有分叉到不同认证路径。

## 从 token 认证迁移

从 token 认证迁移到 trusted-proxy 的建议步骤：

1. 先在代理层完成认证与身份头转发；
2. 独立验证代理行为（包括请求头）；
3. 更新 OpenClaw 配置启用 trusted-proxy；
4. 重启 Gateway；
5. 从控制台验证 WebSocket 连接；
6. 运行 `openclaw security audit` 并逐条处理风险项。

## 相关文档

- [安全性](/gateway/security) — 完整安全模型与审计建议
- [配置](/gateway/configuration) — 网关配置总览
- [远程访问](/gateway/remote) — 其它远程接入模式
- [Tailscale](/gateway/tailscale) — Tailnet 场景下更简单的替代方案
