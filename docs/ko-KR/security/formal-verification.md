---
title: 형식 검증 (보안 모델)
summary: OpenClaw의 고위험 경로에 대한 기계 검증 보안 모델.
permalink: /security/formal-verification/
---

# 형식 검증 (보안 모델)

이 페이지는 OpenClaw의 **형식 보안 모델**(현재는 TLA+/TLC, 필요 시 확장)을 추적합니다.

> 참고: 일부 오래된 링크는 이전 프로젝트 이름을 참조할 수 있습니다.

**목표 (북극성):** OpenClaw가 의도한 보안 정책(권한 부여, 세션 격리, 도구 게이트, 잘못된 구성 안전성)을 명시된 가정하에 강제한다는 것에 대한 기계 검증 주장을 제공합니다.

**현재 상태:** 실행 가능한 공격자 주도 **보안 회귀 테스트 모음**:

- 각 주장은 유한 상태 공간에 대한 실행 가능한 모델 검사를 갖추고 있습니다.
- 많은 주장이 현실적인 버그 클래스에 대한 반례 추적을 생성하는 **부정적 모델**을 동반합니다.

**현재 상태가 아닌 것 (아직):** "OpenClaw가 모든 면에서 안전하다"는 증명 또는 전체 TypeScript 구현의 정확성이 아닙니다.

## 모델의 위치

모델은 별도의 저장소에서 관리됩니다: [vignesh07/openclaw-formal-models](https://github.com/vignesh07/openclaw-formal-models).

## 중요한 주의사항

- 이는 **모델**이며, 전체 TypeScript 구현이 아닙니다. 모델과 코드 간의 차이가 있을 수 있습니다.
- 결과는 TLC가 탐색한 상태 공간에 의해 제한됩니다. "녹색"은 모델링된 가정 및 범위를 넘어서는 보안을 의미하지 않습니다.
- 일부 주장은 명시적인 환경적 가정 (예: 올바른 배포, 올바른 구성 입력)에 의존합니다.

## 결과 재현

현재, 결과는 로컬에서 모델 저장소를 클론하고 TLC를 실행하여 재현됩니다(아래 참조). 미래의 반복에서는 다음을 제공할 수 있습니다:

- 공개 아티팩트 (반례 추적, 실행 로그)를 가진 CI 실행 모델
- 작은 범위의 검사를 위한 "이 모델 실행" 워크플로 호스팅

시작하기:

```bash
git clone https://github.com/vignesh07/openclaw-formal-models
cd openclaw-formal-models

# Java 11+ 필요 (TLC는 JVM에서 실행됨).
# 이 저장소는 고정된 `tla2tools.jar` (TLA+ 도구)를 제공하며 `bin/tlc` + Make 타겟을 제공합니다.

make <target>
```

### 게이트웨이 노출 및 게이트웨이 잘못된 구성

**주장:** 권한 없이 루프백 이상으로 바인딩하면 원격 손상이 가능해지며 노출이 증가할 수 있고, 토큰/비밀번호는 인증되지 않은 공격자를 차단합니다 (모델 가정에 따라).

- 녹색 실행:
  - `make gateway-exposure-v2`
  - `make gateway-exposure-v2-protected`
- 빨강 (예상):
  - `make gateway-exposure-v2-negative`

자세한 내용: 모델 저장소의 `docs/gateway-exposure-matrix.md`를 참조하세요.

### Nodes.run 파이프라인 (가장 높은 위험 기능)

**주장:** `nodes.run`은 (a) 노드 명령 허용 목록과 선언된 명령 및 (b) 구성 시 실시간 승인 필요; 승인은 재생을 방지하기 위해 토큰화됩니다 (모델 내에서).

- 녹색 실행:
  - `make nodes-pipeline`
  - `make approvals-token`
- 빨강 (예상):
  - `make nodes-pipeline-negative`
  - `make approvals-token-negative`

### Pairing 저장소 (다이렉트 메시지 차단)

**주장:** 페어링 요청은 TTL 및 대기 요청 캡을 준수합니다.

- 녹색 실행:
  - `make pairing`
  - `make pairing-cap`
- 빨강 (예상):
  - `make pairing-negative`
  - `make pairing-cap-negative`

### 인그레스 차단 (언급 + 제어 명령 우회)

**주장:** 언급이 필요한 그룹 컨텍스트에서, 승인되지 않은 "제어 명령"은 언급 차단을 우회할 수 없습니다.

- 녹색:
  - `make ingress-gating`
- 빨강 (예상):
  - `make ingress-gating-negative`

### 라우팅/세션 키 격리

**주장:** 별개의 피어로부터의 다이렉트 메시지는 명시적으로 링크/구성되지 않은 한 동일한 세션으로 병합되지 않습니다.

- 녹색:
  - `make routing-isolation`
- 빨강 (예상):
  - `make routing-isolation-negative`

## v1++: 추가적으로 제한된 모델 (동시성, 재시도, 추적 정확성)

이들은 현실 세계의 실패 모드 (비원자적 업데이트, 재시도, 메시지 팬아웃)에 대한 정확성을 높이는 후속 모델입니다.

### Pairing 저장소 동시성 / 불변성

**주장:** 페어링 저장소는 `MaxPending` 및 불변성을 상호간의 개입 속에서도 강제해야 합니다 (즉, "검사 후 기록"은 원자적/잠금 방식이어야 하며, 새로 고침은 중복되지 않아야 합니다).

의미:

- 동시 요청 시, 채널에 대해 `MaxPending`을 초과할 수 없습니다.
- 동일한 `(채널, 발신자)`에 대한 반복된 요청/새로 고침은 중복된 대기 중인 행을 생성하지 않아야 합니다.

- 녹색 실행:
  - `make pairing-race` (원자적/잠금 캡 검사)
  - `make pairing-idempotency`
  - `make pairing-refresh`
  - `make pairing-refresh-race`
- 빨강 (예상):
  - `make pairing-race-negative` (비원자적 시작/커밋 캡 경합)
  - `make pairing-idempotency-negative`
  - `make pairing-refresh-negative`
  - `make pairing-refresh-race-negative`

### 인그레스 추적 상관관계 / 불변성

**주장:** 수집은 팬아웃 전반에 걸쳐 추적 상관관계를 유지해야 하며, 프로바이더 재시도에서도 불변성을 가져야 합니다.

의미:

- 하나의 외부 이벤트가 여러 내부 메시지로 변환될 때, 모든 부분은 동일한 추적/이벤트 ID를 유지해야 합니다.
- 재시도는 중복 처리로 이어지지 않아야 합니다.
- 프로바이더 이벤트 ID가 누락된 경우, 중복 제거는 고유 키 (예: 추적 ID)로 폴백하여 개별 이벤트를 삭제하지 않도록 해야 합니다.

- 녹색:
  - `make ingress-trace`
  - `make ingress-trace2`
  - `make ingress-idempotency`
  - `make ingress-dedupe-fallback`
- 빨강 (예상):
  - `make ingress-trace-negative`
  - `make ingress-trace2-negative`
  - `make ingress-idempotency-negative`
  - `make ingress-dedupe-fallback-negative`

### 라우팅 dmScope 우선순위 + identityLinks

**주장:** 라우팅은 기본적으로 다이렉트 메시지 세션을 격리된 상태로 유지해야 하며, 명시적으로 구성된 경우에만 세션을 병합해야 합니다 (채널 우선순위 + 식별 링크).

의미:

- 채널별 dmScope 오버라이드는 전역 기본값보다 우선해야 합니다.
- identityLinks는 명시된 연관된 그룹 내에서만 병합되어야 하며, 관련 없는 피어 사이에서는 병합되어서는 안됩니다.

- 녹색:
  - `make routing-precedence`
  - `make routing-identitylinks`
- 빨강 (예상):
  - `make routing-precedence-negative`
  - `make routing-identitylinks-negative`
