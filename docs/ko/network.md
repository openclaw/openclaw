---
summary: "네트워크 허브: Gateway(게이트웨이) 표면, 페어링, 디바이스 검색, 보안"
read_when:
  - 네트워크 아키텍처 및 보안 개요가 필요할 때
  - 로컬과 tailnet 접근 또는 페어링 문제를 디버깅할 때
  - 네트워킹 문서의 표준 목록을 확인하고자 할 때
title: "네트워크"
---

# 네트워크 허브

이 허브는 OpenClaw 가 localhost, LAN, tailnet 전반에서 디바이스를 연결하고,
페어링하며, 보안을 적용하는 방식에 대한 핵심 문서를 연결합니다.

## 핵심 모델

- [Gateway 아키텍처](/concepts/architecture)
- [Gateway 프로토콜](/gateway/protocol)
- [Gateway 런북](/gateway)
- [웹 표면 + 바인드 모드](/web)

## 페어링 + 아이덴티티

- [페어링 개요 (다이렉트 메시지 + 노드)](/channels/pairing)
- [Gateway 소유 노드 페어링](/gateway/pairing)
- [Devices CLI (페어링 + 토큰 로테이션)](/cli/devices)
- [Pairing CLI (다이렉트 메시지 승인)](/cli/pairing)

로컬 신뢰:

- 로컬 연결(루프백 또는 Gateway 호스트의 자체 tailnet 주소)은 동일 호스트 UX 를 원활하게 유지하기 위해 페어링이 자동 승인될 수 있습니다.
- 비로컬 tailnet/LAN 클라이언트는 여전히 명시적인 페어링 승인이 필요합니다.

## 디바이스 검색 + 전송

- [디바이스 검색 & 전송](/gateway/discovery)
- [Bonjour / mDNS](/gateway/bonjour)
- [원격 접근 (SSH)](/gateway/remote)
- [Tailscale](/gateway/tailscale)

## 노드 + 전송

- [노드 개요](/nodes)
- [브리지 프로토콜 (레거시 노드)](/gateway/bridge-protocol)
- [노드 런북: iOS](/platforms/ios)
- [노드 런북: Android](/platforms/android)

## 보안

- [보안 개요](/gateway/security)
- [Gateway 설정 참조](/gateway/configuration)
- [문제 해결](/gateway/troubleshooting)
- [Doctor](/gateway/doctor)
