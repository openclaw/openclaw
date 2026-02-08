---
read_when:
    - 클라우드에서 게이트웨이를 실행하고 싶습니다.
    - VPS/호스팅 가이드에 대한 빠른 지도가 필요합니다.
summary: OpenClaw용 VPS 호스팅 허브(Oracle/Fly/Hetzner/GCP/exe.dev)
title: VPS 호스팅
x-i18n:
    generated_at: "2026-02-08T16:13:54Z"
    model: gtx
    provider: google-translate
    source_hash: 96593a1550b560402b57983a866dde41643efc78eb3fd5eb2f34e174f81bb8b3
    source_path: vps.md
    workflow: 15
---

# VPS 호스팅

이 허브는 지원되는 VPS/호스팅 가이드에 연결되며 클라우드가 어떻게
배포는 높은 수준에서 작동합니다.

## 제공업체 선택

- **철도** (원클릭 + 브라우저 설정): [철도](/install/railway)
- **노스플랭크** (원클릭 + 브라우저 설정): [노스플랭크](/install/northflank)
- **오라클 클라우드(항상 무료)**: [신탁](/platforms/oracle) — $0/월(항상 무료, ARM; 용량/가입이 까다로울 수 있음)
- **Fly.io**: [Fly.io](/install/fly)
- **헤츠너(도커)**: [헤츠너](/install/hetzner)
- **GCP(컴퓨팅 엔진)**: [GCP](/install/gcp)
- **exe.dev** (VM + HTTPS 프록시): [exe.dev](/install/exe-dev)
- **AWS(EC2/Lightsail/프리 티어)**: 역시 잘 작동합니다. 비디오 가이드:
  [https://x.com/techfrenAJ/status/2014934471095812547](https://x.com/techfrenAJ/status/2014934471095812547)

## 클라우드 설정 작동 방식

- 그만큼 **게이트웨이는 VPS에서 실행됩니다.** 상태 + 작업 공간을 소유합니다.
- 노트북/휴대폰에서 다음을 통해 연결합니다. **컨트롤 UI** 또는 **테일스케일/SSH**.
- VPS를 진실의 원천으로 취급하고 **백업** 상태 + 작업 공간.
- 보안 기본값: 게이트웨이를 루프백 상태로 유지하고 SSH 터널 또는 Tailscale Serve를 통해 액세스합니다.
  당신이 바인딩하는 경우 `lan`/`tailnet`, 필요하다 `gateway.auth.token` 또는 `gateway.auth.password`.

원격 액세스: [게이트웨이 원격](/gateway/remote)  
플랫폼 허브: [플랫폼](/platforms)

## VPS로 노드 사용

게이트웨이를 클라우드에 유지하고 페어링할 수 있습니다. **노드** 로컬 장치에서
(맥/iOS/안드로이드/헤드리스). 노드는 로컬 화면/카메라/캔버스를 제공하며 `system.run`
게이트웨이가 클라우드에 머무르는 동안 다양한 기능을 사용할 수 있습니다.

문서: [노드](/nodes), [노드 CLI](/cli/nodes)
