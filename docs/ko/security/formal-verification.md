---
permalink: /security/formal-verification/
summary: OpenClaw의 가장 위험한 경로에 대한 기계 검사 보안 모델입니다.
title: 공식 검증(보안 모델)
x-i18n:
    generated_at: "2026-02-08T16:11:20Z"
    model: gtx
    provider: google-translate
    source_hash: 8dff6ea41a37fb6b870424e4e788015c3f8a6099075eece5dbf909883c045106
    source_path: security/formal-verification.md
    workflow: 15
---

# 공식 검증(보안 모델)

이 페이지는 OpenClaw의 **공식적인 보안 모델** (현재 TLA+/TLC, 필요에 따라 추가).

> 참고: 일부 이전 링크는 이전 프로젝트 이름을 참조할 수 있습니다.

**목표(북쪽 별):** OpenClaw가 이를 시행한다는 기계 검사 주장을 제공합니다.
의도된 보안 정책(권한 부여, 세션 격리, 도구 게이팅 및
잘못된 구성 안전), 명시적인 가정하에.

**이것은 무엇입니까(오늘):** 실행 가능한 공격자 중심의 **보안 회귀 제품군**:

- 각 주장에는 유한 상태 공간에 대해 실행 가능한 모델 검사가 있습니다.
- 많은 주장이 짝을 이루었습니다. **네거티브 모델** 현실적인 버그 클래스에 대한 반례 추적을 생성합니다.

**(아직) 이것이 아닌 것:** "OpenClaw는 모든 측면에서 안전하다"거나 전체 TypeScript 구현이 정확하다는 증거입니다.

## 모델들이 사는 곳

모델은 별도의 저장소에 유지됩니다. [vignesh07/openclaw-공식-모델](https://github.com/vignesh07/openclaw-formal-models).

## 중요한 주의사항

- 이들은 **모델**, 전체 TypeScript 구현이 아닙니다. 모델과 코드 사이의 드리프트가 가능합니다.
- 결과는 TLC가 탐색한 상태 공간에 의해 제한됩니다. "친환경"은 모델링된 가정과 범위를 넘어서는 보안을 의미하지 않습니다.
- 일부 주장은 명시적인 환경 가정(예: 올바른 배포, 올바른 구성 입력)에 의존합니다.

## 결과 재현

현재는 모델 저장소를 로컬로 복제하고 TLC를 실행하여 결과를 재현합니다(아래 참조). 향후 반복에서는 다음을 제공할 수 있습니다.

- 공개 아티팩트(반례 추적, 실행 로그)가 있는 CI 실행 모델
- 소규모의 제한된 검사를 위한 호스팅된 "이 모델 실행" 워크플로

시작하기:

```bash
git clone https://github.com/vignesh07/openclaw-formal-models
cd openclaw-formal-models

# Java 11+ required (TLC runs on the JVM).
# The repo vendors a pinned `tla2tools.jar` (TLA+ tools) and provides `bin/tlc` + Make targets.

make <target>
```

### 게이트웨이 노출 및 개방형 게이트웨이 구성 오류

**주장하다:** 인증 없이 루프백을 넘어 바인딩하면 원격 손상이 가능해지며 노출이 증가합니다. 토큰/비밀번호는 인증되지 않은 공격자를 차단합니다(모델 가정에 따라).

- 녹색 실행:
  - `make gateway-exposure-v2`
  - `make gateway-exposure-v2-protected`
- 빨간색(예상):
  - `make gateway-exposure-v2-negative`

참조: `docs/gateway-exposure-matrix.md` 모델 저장소에 있습니다.

### Nodes.run 파이프라인(위험이 가장 높은 기능)

**주장하다:** `nodes.run` (a) 노드 명령 허용 목록과 선언된 명령 및 (b) 구성 시 실시간 승인이 필요합니다. 승인은 모델에서 재생을 방지하기 위해 토큰화됩니다.

- 녹색 실행:
  - `make nodes-pipeline`
  - `make approvals-token`
- 빨간색(예상):
  - `make nodes-pipeline-negative`
  - `make approvals-token-negative`

### 페어링 스토어(DM 게이팅)

**주장하다:** 페어링 요청은 TTL 및 보류 중인 요청 한도를 준수합니다.

- 녹색 실행:
  - `make pairing`
  - `make pairing-cap`
- 빨간색(예상):
  - `make pairing-negative`
  - `make pairing-cap-negative`

### 수신 게이팅(멘션 + 제어 명령 우회)

**주장하다:** 멘션이 필요한 그룹 상황에서는 승인되지 않은 "제어 명령"이 멘션 게이팅을 우회할 수 없습니다.

- 녹색:
  - `make ingress-gating`
- 빨간색(예상):
  - `make ingress-gating-negative`

### 라우팅/세션 키 격리

**주장하다:** 명시적으로 연결/구성되지 않는 한 서로 다른 피어의 DM은 동일한 세션으로 축소되지 않습니다.

- 녹색:
  - `make routing-isolation`
- 빨간색(예상):
  - `make routing-isolation-negative`

## v1++: 추가 제한된 모델(동시성, 재시도, 추적 정확성)

이는 실제 오류 모드(비원자적 업데이트, 재시도 및 메시지 팬아웃)에 대한 충실도를 강화하는 후속 모델입니다.

### 페어링 저장소 동시성/멱등성

**주장하다:** 페어링 스토어는 시행해야 합니다 `MaxPending` 인터리빙 하에서도 멱등성이 보장됩니다(즉, "확인 후 쓰기"는 원자성/잠김이어야 하며 새로 고침은 중복을 생성해서는 안 됩니다).

의미:

- 동시 요청에서는 다음을 초과할 수 없습니다. `MaxPending` 채널의 경우.
- 동일한 항목에 대한 반복적인 요청/새로 고침 `(channel, sender)` 중복된 실시간 보류 행을 생성해서는 안 됩니다.

- 녹색 실행:
  - `make pairing-race` (원자/잠긴 캡 확인)
  - `make pairing-idempotency`
  - `make pairing-refresh`
  - `make pairing-refresh-race`
- 빨간색(예상):
  - `make pairing-race-negative` (비원자적 시작/커밋 캡 레이스)
  - `make pairing-idempotency-negative`
  - `make pairing-refresh-negative`
  - `make pairing-refresh-race-negative`

### 인그레스 추적 상관관계/멱등성

**주장하다:** 수집은 팬아웃 전체에서 추적 상관 관계를 유지해야 하며 공급자 재시도 시 멱등성을 유지해야 합니다.

의미:

- 하나의 외부 이벤트가 여러 내부 메시지가 되는 경우 모든 부분은 동일한 추적/이벤트 ID를 유지합니다.
- 재시도로 인해 이중 처리가 발생하지 않습니다.
- 공급자 이벤트 ID가 누락된 경우 중복 제거는 고유 이벤트 삭제를 방지하기 위해 안전한 키(예: 추적 ID)로 대체됩니다.

- 녹색:
  - `make ingress-trace`
  - `make ingress-trace2`
  - `make ingress-idempotency`
  - `make ingress-dedupe-fallback`
- 빨간색(예상):
  - `make ingress-trace-negative`
  - `make ingress-trace2-negative`
  - `make ingress-idempotency-negative`
  - `make ingress-dedupe-fallback-negative`

### 라우팅 dmScope 우선 순위 + IdentityLinks

**주장하다:** 라우팅은 기본적으로 DM 세션을 격리된 상태로 유지해야 하며 명시적으로 구성된 경우에만 세션을 축소해야 합니다(채널 우선 순위 + ID 링크).

의미:

- 채널별 dmScope 재정의는 전역 기본값보다 우선해야 합니다.
- IdentityLink는 관련되지 않은 피어 전체가 아닌 명시적으로 연결된 그룹 내에서만 축소되어야 합니다.

- 녹색:
  - `make routing-precedence`
  - `make routing-identitylinks`
- 빨간색(예상):
  - `make routing-precedence-negative`
  - `make routing-identitylinks-negative`
