---
summary: "VPS hosting hub for OpenClaw (Oracle/Fly/Hetzner/GCP/exe.dev)"
read_when:
  - You want to run the Gateway in the cloud
  - You need a quick map of VPS/hosting guides
title: "VPS Hosting"
x-i18n:
  source_hash: 96593a1550b560402b57983a866dde41643efc78eb3fd5eb2f34e174f81bb8b3
---

# VPS 호스팅

이 허브는 지원되는 VPS/호스팅 가이드에 연결되며 클라우드가 어떻게
배포는 높은 수준에서 작동합니다.

## 제공업체 선택

- **철도**(원클릭 + 브라우저 설정): [철도](/install/railway)
- **북측면**(원클릭 + 브라우저 설정): [북측면](/install/northflank)
- **Oracle Cloud(항상 무료)**: [Oracle](/platforms/oracle) — $0/월(항상 무료, ARM; 용량/가입이 까다로울 수 있음)
- **Fly.io**: [Fly.io](/install/fly)
- **헤츠너(Docker)**: [헤츠너](/install/hetzner)
- **GCP(컴퓨팅 엔진)**: [GCP](/install/gcp)
- **exe.dev** (VM + HTTPS 프록시): [exe.dev](/install/exe-dev)
- **AWS(EC2/Lightsail/프리 티어)**: 역시 잘 작동합니다. 비디오 가이드:
  [https://x.com/techfrenAJ/status/2014934471095812547](https://x.com/techfrenAJ/status/2014934471095812547)

## 클라우드 설정 작동 방식

- **게이트웨이는 VPS에서 실행**되며 상태 + 작업 공간을 소유합니다.
- **Control UI** 또는 **Tailscale/SSH**를 통해 노트북/휴대폰에서 연결합니다.
- VPS를 진실의 소스로 취급하고 상태 + 작업 공간을 **백업**하세요.
- 보안 기본값: 게이트웨이를 루프백 상태로 유지하고 SSH 터널 또는 Tailscale Serve를 통해 액세스합니다.
  `lan`/`tailnet`에 바인딩하는 경우 `gateway.auth.token` 또는 `gateway.auth.password`가 필요합니다.

원격 접속 : [게이트웨이 원격](/gateway/remote)  
플랫폼 허브: [플랫폼](/platforms)

## VPS로 노드 사용하기

클라우드에 게이트웨이를 유지하고 로컬 장치에서 **노드**를 페어링할 수 있습니다.
(맥/iOS/안드로이드/헤드리스). 노드는 로컬 화면/카메라/캔버스 및 `system.run`를 제공합니다.
게이트웨이가 클라우드에 머무르는 동안 다양한 기능을 사용할 수 있습니다.

문서: [노드](/nodes), [노드 CLI](/cli/nodes)
