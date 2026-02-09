---
summary: "OpenClaw 를 위한 VPS 호스팅 허브 (Oracle/Fly/Hetzner/GCP/exe.dev)"
read_when:
  - 클라우드에서 Gateway(게이트웨이) 를 실행하려는 경우
  - VPS/호스팅 가이드의 빠른 개요가 필요한 경우
title: "VPS 호스팅"
---

# VPS 호스팅

이 허브는 지원되는 VPS/호스팅 가이드로 연결하고 클라우드
배포가 높은 수준에서 어떻게 작동하는지 설명합니다.

## 프로바이더 선택

- **Railway** (원클릭 + 브라우저 설정): [Railway](/install/railway)
- **Northflank** (원클릭 + 브라우저 설정): [Northflank](/install/northflank)
- **Oracle Cloud (Always Free)**: [Oracle](/platforms/oracle) — 월 $0 (Always Free, ARM; 용량/가입이 까다로울 수 있음)
- **Fly.io**: [Fly.io](/install/fly)
- **Hetzner (Docker)**: [Hetzner](/install/hetzner)
- **GCP (Compute Engine)**: [GCP](/install/gcp)
- **exe.dev** (VM + HTTPS 프록시): [exe.dev](/install/exe-dev)
- **AWS (EC2/Lightsail/free tier)**: 역시 잘 동작합니다. 비디오 가이드:
  [https://x.com/techfrenAJ/status/2014934471095812547](https://x.com/techfrenAJ/status/2014934471095812547)

## 클라우드 설정 방식

- **Gateway(게이트웨이) 는 VPS 에서 실행**되며 상태 + 워크스페이스를 소유합니다.
- **Control UI** 또는 **Tailscale/SSH** 를 통해 노트북/휴대폰에서 연결합니다.
- VPS 를 단일 진실 소스로 취급하고 상태 + 워크스페이스를 **백업**하십시오.
- 보안 기본값: Gateway 를 loopback 에 유지하고 SSH 터널 또는 Tailscale Serve 로 접근합니다.
  `lan`/`tailnet` 에 바인딩하는 경우 `gateway.auth.token` 또는 `gateway.auth.password` 을 요구하십시오.

원격 액세스: [Gateway remote](/gateway/remote)  
플랫폼 허브: [Platforms](/platforms)

## VPS 와 함께 노드 사용

Gateway 를 클라우드에 유지하고 로컬 디바이스
(Mac/iOS/Android/headless) 에 **노드**를 페어링할 수 있습니다. 노드는 로컬 화면/카메라/캔버스와 `system.run`
기능을 제공하며 Gateway 는 클라우드에 유지됩니다.

문서: [Nodes](/nodes), [Nodes CLI](/cli/nodes)
