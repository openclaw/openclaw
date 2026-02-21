---
summary: "게이트웨이 인증을 신뢰할 수 있는 리버스 프록시(Pomerium, Caddy, nginx + OAuth)로 위임"
read_when:
  - identity-aware 프록시 뒤에서 OpenClaw 실행
  - OpenClaw 앞에서 Pomerium, Caddy 또는 nginx와 OAuth 설정
  - 리버스 프록시 설정에서 WebSocket 1008 인증 오류 수정
---

# 신뢰할 수 있는 프록시 인증

> ⚠️ **보안 민감 기능.** 이 모드는 인증을 전적으로 리버스 프록시에 위임합니다. 잘못된 구성은 게이트웨이를 무단 접근에 노출시킬 수 있습니다. 사용하기 전에 이 페이지를 주의 깊게 읽어보세요.

## 사용 시기

`trusted-proxy` 인증 모드를 사용하는 경우:

- OpenClaw를 **identity-aware 프록시**(Pomerium, Caddy + OAuth, nginx + oauth2-proxy, Traefik + forward auth) 뒤에서 실행할 때
- 프록시가 모든 인증을 처리하고 헤더를 통해 사용자 ID를 전달할 때
- 게이트웨이에 대한 유일한 경로가 프록시인 Kubernetes 또는 컨테이너 환경일 때
- 브라우저가 WebSocket 페이로드에 토큰을 전달할 수 없어 WebSocket `1008 인증 오류`를 만날 때

## 사용하지 말아야 할 시기

- 프록시가 사용자 인증을 하지 않는 경우(단순 TLS 종단점이나 로드 밸런서)
- 프록시를 우회할 수 있는 게이트웨이 경로가 존재하는 경우(방화벽 구멍, 내부 네트워크 접근)
- 프록시가 전달된 헤더를 올바르게 제거/덮어쓰는지 확신이 없는 경우
- 개인 단일 사용자 액세스만 필요한 경우(더 간단한 설정을 위해 Tailscale Serve + 루프백 고려)

## 작동 방식

1. 리버스 프록시가 사용자를 인증합니다(OAuth, OIDC, SAML, 등).
2. 프록시는 인증된 사용자 ID가 담긴 헤더를 추가합니다(예: `x-forwarded-user: nick@example.com`).
3. OpenClaw는 요청이 **신뢰할 수 있는 프록시 IP**( `gateway.trustedProxies`에 구성된)에서 왔는지 확인합니다.
4. OpenClaw는 구성된 헤더에서 사용자 ID를 추출합니다.
5. 모든 것이 확인되면 요청이 승인됩니다.

## 설정

```json5
{
  gateway: {
    // 동일 호스트 프록시 설정에는 loopback 사용; 원격 프록시 호스트에는 lan/custom 사용
    bind: "loopback",

    // 중요: 여기에는 프록시의 IP만 추가
    trustedProxies: ["10.0.0.1", "172.17.0.1"],

    auth: {
      mode: "trusted-proxy",
      trustedProxy: {
        // 인증된 사용자 ID가 담긴 헤더 (필수)
        userHeader: "x-forwarded-user",

        // 선택 사항: 반드시 있어야 하는 헤더들 (프록시 검증)
        requiredHeaders: ["x-forwarded-proto", "x-forwarded-host"],

        // 선택 사항: 특정 사용자로 제한 (빈 값 = 모두 허용)
        allowUsers: ["nick@example.com", "admin@company.org"],
      },
    },
  },
}
```

`gateway.bind`가 `loopback`인 경우, `gateway.trustedProxies`에 루프백 프록시 주소를 포함하세요 (`127.0.0.1`, `::1`, 또는 동등한 루프백 CIDR).

### 설정 참조

| 필드                                        | 필수   | 설명                                                                   |
| ------------------------------------------- | ------ | ---------------------------------------------------------------------- |
| `gateway.trustedProxies`                    | 예     | 신뢰할 수 있는 프록시 IP 주소 배열. 다른 IP로부터의 요청은 거부됩니다. |
| `gateway.auth.mode`                         | 예     | 반드시 `"trusted-proxy"` 여야 합니다.                                  |
| `gateway.auth.trustedProxy.userHeader`      | 예     | 인증된 사용자 ID가 포함된 헤더 이름                                    |
| `gateway.auth.trustedProxy.requiredHeaders` | 아니요 | 요청이 신뢰될 수 있도록 반드시 있어야 하는 추가 헤더들                 |
| `gateway.auth.trustedProxy.allowUsers`      | 아니요 | 사용자 ID 화이트리스트. 빈 값은 모든 인증된 사용자를 허용함.           |

## 프록시 설정 예시

### Pomerium

Pomerium은 `x-pomerium-claim-email` (또는 다른 클레임 헤더)과 `x-pomerium-jwt-assertion`에 JWT를 전달합니다.

```json5
{
  gateway: {
    bind: "lan",
    trustedProxies: ["10.0.0.1"], // Pomerium의 IP
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

Pomerium 구성 예시:

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

### Caddy with OAuth

`caddy-security` 플러그인을 사용하는 Caddy는 사용자를 인증하고 ID 헤더를 전달할 수 있습니다.

```json5
{
  gateway: {
    bind: "lan",
    trustedProxies: ["127.0.0.1"], // 동일 호스트일 경우 Caddy의 IP
    auth: {
      mode: "trusted-proxy",
      trustedProxy: {
        userHeader: "x-forwarded-user",
      },
    },
  },
}
```

Caddyfile 예시:

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

oauth2-proxy는 `x-auth-request-email`에 사용자를 인증하고 ID를 전달합니다.

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

nginx 구성 예시:

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

### Traefik with Forward Auth

```json5
{
  gateway: {
    bind: "lan",
    trustedProxies: ["172.17.0.1"], // Traefik 컨테이너 IP
    auth: {
      mode: "trusted-proxy",
      trustedProxy: {
        userHeader: "x-forwarded-user",
      },
    },
  },
}
```

## 보안 점검 목록

신뢰할 수 있는 프록시 인증을 활성화하기 전에 확인하세요:

- [ ] **프록시가 유일한 경로**: 게이트웨이 포트는 프록시 외에는 모두 방화벽으로 차단됨
- [ ] **trustedProxies 최소화**: 실제 프록시 IP만, 서브넷 전체는 아님
- [ ] **프록시가 헤더 제거**: 프록시가 클라이언트의 `x-forwarded-*` 헤더를 덮어씀
- [ ] **TLS 종료**: 프록시가 TLS 처리, 사용자는 HTTPS로 연결
- [ ] **allowUsers 설정** (권장): 알려진 사용자로 제한하여 모든 인증된 사용자를 허용하지 않음

## 보안 감사

`openclaw 보안 감사`는 신뢰할 수 있는 프록시 인증을 **중요한** 심각도로 플래그합니다. 이는 보안이 프록시 설정에 위임된다는 상기입니다.

감사 확인 사항:

- `trustedProxies` 설정 누락
- `userHeader` 설정 누락
- 빈 `allowUsers` (모든 인증된 사용자 허용)

## 문제 해결

### "trusted_proxy_untrusted_source"

요청이 `gateway.trustedProxies`의 IP에서 오지 않았습니다. 확인하세요:

- 프록시 IP가 정확한가? (Docker 컨테이너 IP는 변경될 수 있음)
- 프록시 앞에 로드 밸런서가 있는가?
- 실제 IP를 찾으려면 `docker inspect` 또는 `kubectl get pods -o wide` 사용

### "trusted_proxy_user_missing"

사용자 헤더가 비어 있거나 누락되었습니다. 확인하세요:

- 프록시가 ID 헤더를 전달하도록 구성되었는가?
- 헤더 이름이 올바른가? (대소문자 구분은 없지만, 철자는 중요)
- 사용자가 실제로 프록시에서 인증되었는가?

### "trusted*proxy_missing_header*"

필수 헤더가 없었습니다. 확인하세요:

- 해당 특정 헤더에 대한 프록시 구성
- 체인에서 헤더가 어디서 제거되었는지

### "trusted_proxy_user_not_allowed"

사용자가 인증되었지만 `allowUsers`에 포함되지 않았습니다. 사용자를 추가하거나 허용 목록을 제거하세요.

### WebSocket 여전히 실패

프록시가 다음을 지원하는지 확인하세요:

- WebSocket 업그레이드 지원 (`Upgrade: websocket`, `Connection: upgrade`)
- WebSocket 업그레이드 요청 시 ID 헤더를 전달함 (단순한 HTTP가 아님)
- WebSocket 연결에 대한 별도의 인증 경로가 없음

## 토큰 인증에서 마이그레이션

토큰 인증에서 신뢰할 수 있는 프록시로 전환하려면:

1. 프록시가 사용자를 인증하고 헤더를 전달하도록 구성
2. 프록시 설정 독립적으로 테스트(curl과 헤더 사용)
3. 신뢰할 수 있는 프록시 인증으로 OpenClaw 설정 업데이트
4. 게이트웨이 재시작
5. Control UI에서 WebSocket 연결 테스트
6. `openclaw 보안 감사` 수행하고 결과 검토

## 관련 자료

- [보안](/ko-KR/gateway/security) — 전체 보안 가이드
- [구성](/ko-KR/gateway/configuration) — 구성 참조
- [원격 액세스](/ko-KR/gateway/remote) — 다른 원격 액세스 패턴
- [Tailscale](/ko-KR/gateway/tailscale) — tailnet 전용 액세스에 대한 더 간단한 대안
