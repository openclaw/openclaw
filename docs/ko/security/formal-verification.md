---
title: 정형 검증(보안 모델)
summary: OpenClaw 의 최고 위험 경로를 위한 머신 검증 보안 모델.
permalink: /security/formal-verification/
x-i18n:
  source_path: security/formal-verification.md
  source_hash: 8dff6ea41a37fb6b
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:26:28Z
---

# 정형 검증(보안 모델)

이 페이지는 OpenClaw 의 **정형 보안 모델**(현재는 TLA+/TLC, 필요에 따라 추가)을 추적합니다.

> 참고: 일부 오래된 링크는 이전 프로젝트 이름을 참조할 수 있습니다.

**목표(노스 스타):** 명시적 가정하에서 OpenClaw 가 의도된 보안 정책(권한 부여, 세션 격리, 도구 게이팅, 잘못된 구성에 대한 안전성)을 강제함을 머신 검증으로 입증합니다.

**이것이 의미하는 바(현재):** 실행 가능한, 공격자 주도 **보안 회귀 테스트 스위트**입니다.

- 각 주장에는 유한 상태 공간에 대한 실행 가능한 모델 검사기가 포함됩니다.
- 많은 주장은 현실적인 버그 클래스에 대한 반례 트레이스를 생성하는 짝을 이루는 **네거티브 모델**을 포함합니다.

**아직 아닌 것:** “OpenClaw 가 모든 측면에서 안전하다”는 증명이나 전체 TypeScript 구현이 정확하다는 증명은 아닙니다.

## 모델 위치

모델은 별도의 저장소에서 유지됩니다: [vignesh07/openclaw-formal-models](https://github.com/vignesh07/openclaw-formal-models).

## 중요한 주의 사항

- 이는 전체 TypeScript 구현이 아닌 **모델**입니다. 모델과 코드 간의 드리프트가 발생할 수 있습니다.
- 결과는 TLC 가 탐색한 상태 공간에 의해 제한됩니다. “그린”은 모델링된 가정과 범위를 넘어서는 보안을 의미하지 않습니다.
- 일부 주장은 명시적인 환경 가정(예: 올바른 배포, 올바른 구성 입력)에 의존합니다.

## 결과 재현

현재는 모델 저장소를 로컬로 클론하고 TLC 를 실행하여 결과를 재현합니다(아래 참조). 향후 반복에서는 다음을 제공할 수 있습니다:

- 공개 아티팩트(반례 트레이스, 실행 로그)를 포함한 CI 실행 모델
- 소규모, 제한된 검사를 위한 호스팅된 “이 모델 실행” 워크플로

시작하기:

```bash
git clone https://github.com/vignesh07/openclaw-formal-models
cd openclaw-formal-models

# Java 11+ required (TLC runs on the JVM).
# The repo vendors a pinned `tla2tools.jar` (TLA+ tools) and provides `bin/tlc` + Make targets.

make <target>
```

### Gateway 노출 및 오픈 Gateway 잘못된 구성

**주장:** 인증 없이 loopback 을 넘어 바인딩하면 원격 침해가 가능해지거나 노출이 증가할 수 있으며, 토큰/비밀번호는(모델 가정에 따라) 무인증 공격자를 차단합니다.

- 그린 실행:
  - `make gateway-exposure-v2`
  - `make gateway-exposure-v2-protected`
- 레드(예상):
  - `make gateway-exposure-v2-negative`

모델 저장소의 `docs/gateway-exposure-matrix.md` 도 참조하십시오.

### Nodes.run 파이프라인(최고 위험 기능)

**주장:** `nodes.run` 는 (a) 노드 명령 허용 목록과 선언된 명령, 그리고 (b) 구성된 경우 실시간 승인(live approval)을 요구합니다. 승인은(모델에서) 재사용 공격을 방지하기 위해 토큰화됩니다.

- 그린 실행:
  - `make nodes-pipeline`
  - `make approvals-token`
- 레드(예상):
  - `make nodes-pipeline-negative`
  - `make approvals-token-negative`

### 페어링 저장소(DM 게이팅)

**주장:** 페어링 요청은 TTL 과 대기 중 요청 상한을 준수합니다.

- 그린 실행:
  - `make pairing`
  - `make pairing-cap`
- 레드(예상):
  - `make pairing-negative`
  - `make pairing-cap-negative`

### 인그레스 게이팅(멘션 + 제어 명령 우회)

**주장:** 멘션이 요구되는 그룹 컨텍스트에서, 무권한 “제어 명령”은 멘션 게이팅을 우회할 수 없습니다.

- 그린:
  - `make ingress-gating`
- 레드(예상):
  - `make ingress-gating-negative`

### 라우팅/세션 키 격리

**주장:** 명시적으로 연결/구성되지 않는 한, 서로 다른 피어의 DM 은 동일한 세션으로 합쳐지지 않습니다.

- 그린:
  - `make routing-isolation`
- 레드(예상):
  - `make routing-isolation-negative`

## v1++: 추가 제한 모델(동시성, 재시도, 트레이스 정확성)

이는 실제 세계의 실패 모드(비원자적 업데이트, 재시도, 메시지 팬아웃)에 대한 충실도를 강화하는 후속 모델입니다.

### 페어링 저장소 동시성 / 멱등성

**주장:** 페어링 저장소는 인터리빙 하에서도 `MaxPending` 과 멱등성을 강제해야 합니다(즉, “검사-후-쓰기”는 원자적이거나 잠겨 있어야 하며, 갱신이 중복을 생성해서는 안 됩니다).

의미:

- 동시 요청 하에서 채널에 대해 `MaxPending` 를 초과할 수 없습니다.
- 동일한 `(channel, sender)` 에 대한 반복 요청/갱신은 중복된 활성 대기 행을 생성해서는 안 됩니다.

- 그린 실행:
  - `make pairing-race` (원자적/잠금된 상한 검사)
  - `make pairing-idempotency`
  - `make pairing-refresh`
  - `make pairing-refresh-race`
- 레드(예상):
  - `make pairing-race-negative` (비원자적 begin/commit 상한 경쟁)
  - `make pairing-idempotency-negative`
  - `make pairing-refresh-negative`
  - `make pairing-refresh-race-negative`

### 인그레스 트레이스 상관관계 / 멱등성

**주장:** 인제스천은 팬아웃 전반에 걸쳐 트레이스 상관관계를 보존해야 하며, 프로바이더 재시도 하에서 멱등적이어야 합니다.

의미:

- 하나의 외부 이벤트가 여러 내부 메시지로 변환될 때, 모든 부분은 동일한 트레이스/이벤트 식별자를 유지합니다.
- 재시도로 인해 이중 처리가 발생하지 않습니다.
- 프로바이더 이벤트 ID 가 누락된 경우, 중복 제거는 서로 다른 이벤트를 삭제하지 않도록 안전한 키(예: 트레이스 ID)로 폴백합니다.

- 그린:
  - `make ingress-trace`
  - `make ingress-trace2`
  - `make ingress-idempotency`
  - `make ingress-dedupe-fallback`
- 레드(예상):
  - `make ingress-trace-negative`
  - `make ingress-trace2-negative`
  - `make ingress-idempotency-negative`
  - `make ingress-dedupe-fallback-negative`

### 라우팅 dmScope 우선순위 + identityLinks

**주장:** 라우팅은 기본적으로 DM 세션을 격리해야 하며, 명시적으로 구성된 경우에만 세션을 병합해야 합니다(채널 우선순위 + identity 링크).

의미:

- 채널별 dmScope 재정의는 전역 기본값보다 우선해야 합니다.
- identityLinks 는 관련 없는 피어 전반이 아니라, 명시적으로 연결된 그룹 내부에서만 병합되어야 합니다.

- 그린:
  - `make routing-precedence`
  - `make routing-identitylinks`
- 레드(예상):
  - `make routing-precedence-negative`
  - `make routing-identitylinks-negative`
