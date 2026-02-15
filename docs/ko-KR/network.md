---
summary: "Network hub: gateway surfaces, pairing, discovery, and security"
read_when:
  - You need the network architecture + security overview
  - You are debugging local vs tailnet access or pairing
  - You want the canonical list of networking docs
title: "Network"
x-i18n:
  source_hash: 6a0d5080db73de4c21d9bf376059f6c4a26ab129c8280ce6b1f54fa9ace48beb
---

# 네트워크 허브

이 허브는 OpenClaw가 연결, 페어링 및 보안을 유지하는 방법에 대한 핵심 문서를 연결합니다.
localhost, LAN 및 tailnet을 통한 장치.

## 핵심 모델

- [게이트웨이 아키텍처](/concepts/architecture)
- [게이트웨이 프로토콜](/gateway/protocol)
- [게이트웨이 런북](/gateway)
- [웹 표면 + 바인딩 모드](/web)

## 페어링 + 아이덴티티

- [페어링 개요(DM + 노드)](/channels/pairing)
- [게이트웨이 소유 노드 페어링](/gateway/pairing)
- [기기 CLI(페어링 + 토큰 순환)](/cli/devices)
- [페어링 CLI(DM 승인)](/cli/pairing)

로컬 신뢰:

- 로컬 연결(루프백 또는 게이트웨이 호스트 자체 tailnet 주소)이 가능합니다.
  동일한 호스트 UX를 원활하게 유지하기 위해 페어링이 자동 승인되었습니다.
- 로컬이 아닌 tailnet/LAN 클라이언트에는 여전히 명시적인 페어링 승인이 필요합니다.

## 발견 + 수송

- [발견 및 수송](/gateway/discovery)
- [봉쥬르 / mDNS](/gateway/bonjour)
- [원격 접속(SSH)](/gateway/remote)
- [꼬리비늘](/gateway/tailscale)

## 노드 + 전송

- [노드 개요](/nodes)
- [브리지 프로토콜(레거시 노드)](/gateway/bridge-protocol)
- [노드 런북: iOS](/platforms/ios)
- [노드 런북: Android](/platforms/android)

## 보안

- [보안 개요](/gateway/security)
- [게이트웨이 구성 참조](/gateway/configuration)
- [문제 해결](/gateway/troubleshooting)
- [의사](/gateway/doctor)
