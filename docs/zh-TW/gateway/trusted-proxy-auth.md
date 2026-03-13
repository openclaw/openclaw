---
summary: >-
  Delegate gateway authentication to a trusted reverse proxy (Pomerium, Caddy,
  nginx + OAuth)
read_when:
  - Running OpenClaw behind an identity-aware proxy
  - "Setting up Pomerium, Caddy, or nginx with OAuth in front of OpenClaw"
  - Fixing WebSocket 1008 unauthorized errors with reverse proxy setups
  - Deciding where to set HSTS and other HTTP hardening headers
---

# Trusted Proxy Auth

> ⚠️ **安全敏感功能。** 此模式將身份驗證完全委託給您的反向代理。設定錯誤可能會使您的 Gateway 暴露於未經授權的訪問。啟用之前請仔細閱讀此頁面。

## 何時使用

使用 `trusted-proxy` 認證模式時：

- 您在 **身份感知代理**（Pomerium、Caddy + OAuth、nginx + oauth2-proxy、Traefik + forward auth）後執行 OpenClaw
- 您的代理處理所有身份驗證並通過標頭傳遞用戶身份
- 您在 Kubernetes 或容器環境中，代理是通往 Gateway 的唯一路徑
- 您遇到 WebSocket `1008 unauthorized` 錯誤，因為瀏覽器無法在 WS 負載中傳遞 token

## 何時不使用

- 如果您的代理不進行用戶身份驗證（僅是 TLS 終端或負載平衡器）
- 如果有任何通往網關的路徑繞過代理（防火牆漏洞、內部網路訪問）
- 如果您不確定您的代理是否正確移除/覆蓋轉發標頭
- 如果您只需要個人單用戶訪問（考慮使用 Tailscale Serve + 回環以簡化設置）

## 如何運作

1. 您的反向代理會驗證使用者（OAuth、OIDC、SAML 等）。
2. 代理會添加一個包含已驗證使用者身份的標頭（例如，`x-forwarded-user: nick@example.com`）。
3. OpenClaw 會檢查請求是否來自 **受信任的代理 IP**（在 `gateway.trustedProxies` 中設定）。
4. OpenClaw 從設定的標頭中提取使用者身份。
5. 如果一切正常，請求將被授權。

## 控制 UI 配對行為

當 `gateway.auth.mode = "trusted-proxy"` 處於啟用狀態且請求通過 trusted-proxy 檢查時，Control UI WebSocket 會話可以在不進行設備配對身份的情況下連接。

[[BLOCK_1]]

- 配對不再是此模式下控制 UI 存取的主要門檻。
- 您的反向代理身份驗證政策和 `allowUsers` 成為有效的存取控制。
- 只允許受信任的代理 IP 鎖定網關入口 (`gateway.trustedProxies` + 防火牆)。

## Configuration

json5
{
gateway: {
// 對於同主機的代理設置使用 loopback；對於遠端代理主機使用 lan/custom
bind: "loopback",

// CRITICAL: 只有在這裡添加你的代理伺服器的 IP 位址
trustedProxies: ["10.0.0.1", "172.17.0.1"],

auth: {
mode: "trusted-proxy",
trustedProxy: {
// 包含已驗證用戶身份的標頭（必填）
userHeader: "x-forwarded-user",

// 可選：必須存在的標頭（代理驗證）
requiredHeaders: ["x-forwarded-proto", "x-forwarded-host"],

// 可選：限制特定用戶（空 = 允許所有）
allowUsers: ["nick@example.com", "admin@company.org"],
},
},
},
}

如果 `gateway.bind` 是 `loopback`，請在 `gateway.trustedProxies` 中包含一個迴圈回路代理地址 (`127.0.0.1`、`::1` 或等效的迴圈回路 CIDR)。

### 設定參考

| 欄位                                        | 必填 | 描述                                                       |
| ------------------------------------------- | ---- | ---------------------------------------------------------- |
| `gateway.trustedProxies`                    | 是   | 可信的代理 IP 位址陣列。來自其他 IP 的請求將被拒絕。       |
| `gateway.auth.mode`                         | 是   | 必須是 `"trusted-proxy"`                                   |
| `gateway.auth.trustedProxy.userHeader`      | 是   | 包含已驗證使用者身份的標頭名稱                             |
| `gateway.auth.trustedProxy.requiredHeaders` | 否   | 請求必須存在的額外標頭，以便被信任                         |
| `gateway.auth.trustedProxy.allowUsers`      | 否   | 使用者身份的允許清單。若為空則表示允許所有已驗證的使用者。 |

## TLS 終止與 HSTS

使用一個 TLS 終止點並在那裡應用 HSTS。

### 建議模式：代理 TLS 終止

當您的反向代理處理 `https://control.example.com` 的 HTTPS 時，請在該域的代理上設置 `Strict-Transport-Security`。

- 適合面向互聯網的部署。
- 將證書和 HTTP 強化政策集中管理。
- OpenClaw 可以在代理後的回環 HTTP 上執行。

範例標頭值：

```text
Strict-Transport-Security: max-age=31536000; includeSubDomains
```

### Gateway TLS 終止

如果 OpenClaw 本身直接提供 HTTPS（沒有 TLS 終止代理），請設定：

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

`strictTransportSecurity` 接受一個字串標頭值，或 `false` 來明確禁用。

### Rollout guidance

- 首先使用短的最大年齡（例如 `max-age=300`）來驗證流量。
- 只有在信心高的情況下，才增加到長期值（例如 `max-age=31536000`）。
- 只有在每個子域名都準備好 HTTPS 時，才添加 `includeSubDomains`。
- 只有在您有意滿足整個域名集的預加載要求時，才使用預加載。
- 僅限回環的本地開發不受益於 HSTS。

## Proxy 設定範例

### Pomerium

Pomerium 在 `x-pomerium-claim-email`（或其他聲明標頭）中傳遞身份，並在 `x-pomerium-jwt-assertion` 中傳遞 JWT。

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

Pomerium 設定片段：

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

### Caddy 與 OAuth

Caddy 搭配 `caddy-security` 插件可以驗證使用者並傳遞身份標頭。

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

openclaw.example.com {
使用 oauth2_provider 進行身份驗證
使用 policy1 進行授權

reverse_proxy openclaw:18789 {
header_up X-Forwarded-User {http.auth.user.email}
}
}

### nginx + oauth2-proxy

oauth2-proxy 驗證用戶並在 `x-auth-request-email` 中傳遞身份。

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

nginx 設定片段：

nginx
location / {
auth_request /oauth2/auth;
auth_request_set $user $upstream_http_x_auth_request_email;

proxy_pass http://openclaw:18789;
proxy_set_header X-Auth-Request-Email $user;
proxy_http_version 1.1;
proxy_set_header Upgrade $http_upgrade;
proxy_set_header Connection "upgrade";
}

### Traefik 與 Forward Auth

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

## Security Checklist

在啟用 trusted-proxy 認證之前，請確認：

- [ ] **代理是唯一的路徑**：閘道埠被防火牆保護，除了你的代理之外，其他一切都無法訪問
- [ ] **trustedProxies 是最小化的**：僅包含你的實際代理 IP，而不是整個子網
- [ ] **代理會移除標頭**：你的代理會覆蓋（而不是附加）`x-forwarded-*` 用戶端的標頭
- [ ] **TLS 終止**：你的代理處理 TLS；用戶通過 HTTPS 連接
- [ ] **allowUsers 已設置**（建議）：限制為已知用戶，而不是允許任何經過身份驗證的人士

## Security Audit

`openclaw security audit` 將以 **關鍵** 嚴重性標記受信代理的身份驗證。這是故意的 — 這是一個提醒，讓你知道你正在將安全性委託給你的代理設置。

[[BLOCK_1]]  
審核檢查專案包括：  
[[BLOCK_1]]

- 缺少 `trustedProxies` 設定
- 缺少 `userHeader` 設定
- 空的 `allowUsers` （允許任何已驗證的使用者）

## 故障排除

### "trusted_proxy_untrusted_source"

請求並非來自 `gateway.trustedProxies` 中的 IP。檢查：

- 代理 IP 是否正確？（Docker 容器的 IP 可能會改變）
- 你的代理前面是否有負載平衡器？
- 使用 `docker inspect` 或 `kubectl get pods -o wide` 來查找實際的 IP。

### "trusted_proxy_user_missing"

使用者標頭為空或缺失。請檢查：

- 您的代理伺服器是否設定為傳遞身份標頭？
- 標頭名稱是否正確？（不區分大小寫，但拼寫很重要）
- 使用者在代理伺服器上是否實際上已經驗證？

### "trusted*proxy_missing_header*\*"

缺少必要的標頭。請檢查：

- 您針對那些特定標頭的代理設定
- 標頭是否在某個環節被移除

### "trusted_proxy_user_not_allowed"

使用者已通過身份驗證，但不在 `allowUsers` 中。請將他們添加進去或移除允許清單。

### WebSocket 仍然失敗

確保您的代理伺服器：

- 支援 WebSocket 升級 (`Upgrade: websocket`, `Connection: upgrade`)
- 在 WebSocket 升級請求中傳遞身份標頭（不僅僅是 HTTP）
- 對於 WebSocket 連接，沒有單獨的身份驗證路徑

## 從 Token 認證遷移

如果您正在從 token 認證轉移到 trusted-proxy：

1. 設定你的代理以驗證用戶並傳遞標頭
2. 獨立測試代理設置（使用 curl 和標頭）
3. 更新 OpenClaw 設定以包含受信任的代理身份驗證
4. 重新啟動網關
5. 從控制 UI 測試 WebSocket 連接
6. 執行 `openclaw security audit` 並檢查結果

## Related

- [安全性](/gateway/security) — 完整的安全指南
- [設定](/gateway/configuration) — 設定參考
- [遠端存取](/gateway/remote) — 其他遠端存取模式
- [Tailscale](/gateway/tailscale) — 專為 tailnet 專用存取的簡化替代方案
