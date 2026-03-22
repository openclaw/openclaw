---
summary: "네트워크 허브: Gateway 표면, 페어링, 디스커버리, 보안"
read_when:
  - 네트워크 아키텍처 + 보안 개요가 필요할 때
  - 로컬 vs tailnet 접근 또는 페어링을 디버깅할 때
  - 네트워킹 문서의 정식 목록이 필요할 때
title: "네트워크"
x-i18n:
  source_path: docs/network.md
---

# 네트워크 허브

이 허브는 OpenClaw이 localhost, LAN, tailnet에서 디바이스를 연결, 페어링, 보안하는 방법에 대한 핵심 문서를 연결합니다.

## 핵심 모델

- [Gateway 아키텍처](/concepts/architecture)
- [Gateway 프로토콜](/gateway/protocol)
- [Gateway 운영 가이드](/gateway)
- [웹 표면 + 바인드 모드](/web)

## 페어링 + ID

- [페어링 개요 (DM + 노드)](/channels/pairing)
- [Gateway 소유 노드 페어링](/gateway/pairing)
- [디바이스 CLI (페어링 + 토큰 순환)](/cli/devices)
- [페어링 CLI (DM 승인)](/cli/pairing)

로컬 신뢰:

- 로컬 연결 (루프백 또는 Gateway 호스트 자체의 tailnet 주소)은 동일 호스트 UX를 원활하게 유지하기 위해 페어링 자동 승인이 가능합니다.
- 비로컬 tailnet/LAN 클라이언트는 여전히 명시적 페어링 승인이 필요합니다.

## 디스커버리 + 전송

- [디스커버리 및 전송](/gateway/discovery)
- [Bonjour / mDNS](/gateway/bonjour)
- [원격 접근 (SSH)](/gateway/remote)
- [Tailscale](/gateway/tailscale)

## 노드 + 전송

- [노드 개요](/nodes)
- [브릿지 프로토콜 (레거시 노드)](/gateway/bridge-protocol)
- [노드 운영 가이드: iOS](/platforms/ios)
- [노드 운영 가이드: Android](/platforms/android)

## 보안

- [보안 개요](/gateway/security)
- [Gateway 설정 레퍼런스](/gateway/configuration)
- [문제 해결](/gateway/troubleshooting)
- [Doctor](/gateway/doctor)
