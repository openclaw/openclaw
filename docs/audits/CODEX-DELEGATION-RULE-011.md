# CODEX-DELEGATION-RULE-011 — Codex 반자동 개발 위임 규칙

**Date:** 2026-06-23 12:00 KST  
**Status:** ✅ COMPLETE  
**Grade:** 🟡 Light (운영 규칙 문서화, DB write 없음)

## Summary

형이 전체 목표만 주면 Codex/OpenClaw가 구현·검증·테스트·보고까지 진행하고, 진희가 최종 리뷰/디버깅/위험도 판정을 담당하는 반자동 개발 루프 규칙을 정립한다.

---

## 1. 역할 분담

| 역할              | 담당             |                                                설명 |
| :---------------- | :--------------- | --------------------------------------------------: |
| **목표 제시**     | 형               |                    전체 방향, Heavy 승인, 최종 결정 |
| **아키텍처 리뷰** | 진희             |  위험도 판정, 템플릿 작성, 디버깅 가이드, 최종 검토 |
| **구현/테스트**   | Codex / OpenClaw | 코드 조사·구현·수정, 테스트 실행, diff 생성, 보고서 |
| **실행 환경**     | OpenClaw Gateway |       파일 I/O, 프로세스 실행, smoke, Telegram 연동 |

**운영 원칙:**

- 형은 목표만 던진다. 작업지시서 세부 작성은 진희가 한다.
- 구현은 Codex/OpenClaw가 한다. 진희는 마이크로매니징하지 않는다.
- 🔴 Heavy 발견 시 즉시 중단 → 형 승인 요청.

---

## 2. 작업 등급

### 🟢 Auto — 사전 승인 불필요, 사후 보고

| 작업 유형          |                                      예시 |
| :----------------- | ----------------------------------------: |
| read-only 분석     |    grep, DB select (read-only), 로그 분석 |
| 상태 점검          | gateway status, git status, 시스템 리소스 |
| docs/audits 보고서 |                마크다운 리포트, 진단 문서 |
| focused test       |         단일 테스트 파일 실행, smoke test |
| preview 실행       |         bridge preview, candidate preview |
| 후보 추출          |            memory candidate, ticket draft |

### 🟡 Light — 사후 보고 (forbidden diff clean 조건)

| 작업 유형        |                                 예시 |
| :--------------- | -----------------------------------: |
| 소규모 코드 패치 |          5~20줄 변경, 단일 파일 수정 |
| 테스트 추가      | 기존 테스트 보강, 신규 테스트 케이스 |
| preview script   |              read-only 분석 스크립트 |
| 문서/리포트 생성 |         audit 리포트, 운영 규칙 문서 |
| alias/guard 개선 |                 타입 가드, 헬퍼 함수 |
| 비파괴 리팩토링  |             변수명 정리, import 정리 |

**조건:** forbidden files 변경 없음, DB write 없음, package/lock/config/model 변경 없음, MEMORY.md 변경 없음.  
이 조건을 위반하면 즉시 중단 → 🔴 Heavy 전환.

### 🔴 Heavy — 사전 명시 승인 필수

| 작업 유형              |                                          예시 |
| :--------------------- | --------------------------------------------: |
| DB write               |             INSERT/UPDATE/DELETE on any table |
| canonical memory 변경  |                       canonical_memories 수정 |
| config 변경            | openclaw.json, provider/model/router/fallback |
| package/lock 변경      |           npm/pnpm install, package.json 수정 |
| secrets/env 접근       |                      API key, token 조회/출력 |
| 외부 send/write/delete |             이메일 발송, 파일 삭제, API write |
| 비용 발생              |               유료 API 호출, 외부 서비스 사용 |
| MEMORY.md 수정         |               직접 편집 (승인 후 진희만 가능) |
| gateway restart        |                         systemd 재시작, build |
| 실거래/금융 실행       |                         실제 주문, 결제, 송금 |

---

## 3. 작업지시서 템플릿

### 🟢🟡 Green/Yellow — 5줄 템플릿

```
TASK: <티켓명-번호>
등급: 🟢 Auto | 🟡 Light
목적: <한 줄 목표>
허용: <허용되는 작업 목록>
금지: <금지되는 작업 목록>
검증: <PASS 조건> / 보고: <출력 위치>
```

### 🔴 Heavy — 상세 템플릿

```
TASK: <티켓명-번호>
등급: 🔴 Heavy — <변경 유형>
목적:
<상세 목표>

배경:
<왜 필요한지>
<선행 작업 참조>

허용 범위:
- <허용 작업 1>
- <허용 작업 2>

금지 범위:
- <금지 작업 1>
- <금지 작업 2>

백업:
<필요한 경우 백업 명령어>

실행 절차:
1. <단계 1>
2. <단계 2>
3. <단계 3>

검증:
1. <검증 1>
2. <검증 2>

Rollback:
<실패 시 복구 명령어>

보고 형식:
<출력해야 할 필드 목록>
```

실제 사용 예시는 MEMORY-OPERATING-RULE-007 (🔴 Heavy INSERT), MEMORY-BRIDGE-THRESHOLD-010 (🔴 Heavy UPDATE) 참조.

---

## 4. Codex 결과 판정 라벨

| 라벨                           | 의미                     |                                다음 행동 |
| :----------------------------- | :----------------------- | ---------------------------------------: |
| **APPROVE** ✅                 | 통과, 금지 위반 없음     |                 다음 단계 진행 또는 보고 |
| **NEEDS_DEBUG** 🔧             | 일부 실패, 디버깅 필요   |   로그 분석, 원인 파악 → 수정 → 재테스트 |
| **HEAVY_APPROVAL_REQUIRED** 🔴 | 형 승인 필요한 작업 발견 | 작업 중단 → 형에게 상황 보고 → 승인 대기 |
| **REJECT** ❌                  | 금지 위반 또는 방향 오류 |    중단 → 형에게 원인 보고 → 방향 재수립 |
| **READONLY_ONLY** 🔍           | 실행 금지, 조사만 허용   |         분석 결과만 보고, 변경 없이 종료 |

**판정 기준:**

- `APPROVE`: forbidden diff clean + 테스트 통과 + 금지 범위 미접촉
- `NEEDS_DEBUG`: 테스트 실패 but 금지 위반 아님
- `HEAVY_APPROVAL_REQUIRED`: 🔴 영역 작업 필요 감지
- `REJECT`: forbidden file 변경, DB write, config 변경 등 규칙 위반 발견
- `READONLY_ONLY`: 🔴 작업이 필요하지만 승인 없음 → 분석만 수행

---

## 5. 자동 진행 조건 (🟢🟡)

아래 **모든** 조건을 만족하면 사후 보고로 PASS 가능:

1. ✅ forbidden files 변경 없음 (package/lock/config/model/MEMORY.md)
2. ✅ DB write 없음
3. ✅ secrets/env 출력/변경 없음
4. ✅ 외부 write/send/delete 없음
5. ✅ 비용 발생 없음
6. ✅ gateway build/restart 없음
7. ✅ 테스트 또는 smoke 결과 정상
8. ✅ docs/audits 보고서 생성 또는 요약 보고 완료

---

## 6. 중단 조건 (🟢🟡 → 🔴 전환)

아래 중 **하나라도** 발견 시 즉시 중단하고 형 승인 요청:

| 조건                          |                                 발견 시 행동 |
| :---------------------------- | -------------------------------------------: |
| DB write 필요                 |               `🔴 Heavy 필요: DB write` 보고 |
| canonical memory 변경 필요    |         `🔴 Heavy 필요: canonical 변경` 보고 |
| gateway restart 필요          |        `🔴 Heavy 필요: gateway restart` 보고 |
| package/lock 변경 필요        |            `🔴 Heavy 필요: 의존성 변경` 보고 |
| config/model/router 변경 필요 |              `🔴 Heavy 필요: 설정 변경` 보고 |
| secrets/env 접근 필요         |           `🔴 Heavy 필요: secrets 접근` 보고 |
| 외부 write/send/delete 필요   |              `🔴 Heavy 필요: 외부 전송` 보고 |
| 비용 발생 가능성              |              `🔴 Heavy 필요: 비용 발생` 보고 |
| 테스트 실패 원인 불명확       | `🟡 Light: 디버깅 필요` 보고 후 형 판단 대기 |

---

## 7. 다음 단계 추천

1. **🟢 Auto로 즉시 실행 가능:** memory 후보 distill, bridge preview, 로그 분석, 시스템 상태 점검
2. **🟡 Light로 가능:** Codex worker 설정 보완, 작업지시서 템플릿 개선, 추가 audit 리포트
3. **🔴 Heavy (형 승인 필요):** 아직 없음 (대기 중)

---

## 참조 문서

- [MEMORY-OPERATING-RULE-007](./MEMORY-OPERATING-RULE-007.md) — 🔴 Heavy INSERT 사례
- [MEMORY-OPERATING-RULE-ROUNDTRIP-008](./MEMORY-OPERATING-RULE-ROUNDTRIP-008.md) — 🟢 Auto roundtrip 사례
- [MEMORY-BRIDGE-THRESHOLD-009](./MEMORY-BRIDGE-THRESHOLD-009.md) — 🟢 Auto 진단 사례
- [MEMORY-BRIDGE-THRESHOLD-010](./MEMORY-BRIDGE-THRESHOLD-010.md) — 🔴 Heavy UPDATE 사례
- CANONICAL ID 107 — 위험도 등급제 운영 규칙 (confidence 950)
