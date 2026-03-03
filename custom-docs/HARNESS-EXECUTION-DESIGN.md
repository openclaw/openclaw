# Harness-Aware Agent Execution 설계

> Harness 스펙 준수를 시스템적으로 추적하는 구조.
> Task Hub의 Harness(Project → Item → Spec) 시스템과 연동하여
> 에이전트가 step/check를 보고하고, 자동으로 verification 상태를 관리한다.
>
> **상태**: 구현 완료 (2026-03-03)

---

## 1. 개요

Harness 프로젝트가 Launch되면 각 Item의 steps/verificationChecklist가
두 개의 에이전트 도구(`harness_report_step`, `harness_report_check`)를 통해
Task Hub의 Verify API로 보고된다. 모든 checks 통과 시 자동으로 `verification.status = "passed"`.

## 2. 데이터 흐름

```
Task Hub (Launch)
  → delegateToAgent(harness_project_slug, harness_item_id)
  → Gateway task_backlog_add
  → TaskFile.md (backlog JSON에 harness 필드 포함)
  → task-continuation-runner가 idle 에이전트에 pickup prompt 전송
  → pickup prompt에 harness protocol 자동 주입
  → 에이전트가 harness_report_step/check 도구 호출
  → hubFetch → POST /api/harness/{itemId}/verify
  → Task Hub: HarnessItem.verification 업데이트
  → 전체 check 통과 시 verification.status = "passed"
```

## 3. 에이전트 도구

### harness_report_step

스펙 step 완료 보고.

| 파라미터     | 타입   | 필수 | 설명                           |
| ------------ | ------ | ---- | ------------------------------ |
| `item_id`    | string | O    | HarnessItem `_id`              |
| `step_index` | number | O    | 0-based index (`spec.steps[]`) |
| `status`     | string | O    | `"done"` 또는 `"skipped"`      |
| `note`       | string |      | 완료/스킵 사유                 |

**응답**: `success`, `stepIndex`, `status`, `stepsRemaining`, `stepsDone`, `stepsTotal`, `verificationStatus`

### harness_report_check

검증 체크리스트 항목 결과 보고. 모든 check 통과 시 자동으로 `verification.status = "passed"`.

| 파라미터      | 타입    | 필수 | 설명                                      |
| ------------- | ------- | ---- | ----------------------------------------- |
| `item_id`     | string  | O    | HarnessItem `_id`                         |
| `check_index` | number  | O    | 0-based index (`verificationChecklist[]`) |
| `passed`      | boolean | O    | 통과 여부                                 |
| `note`        | string  |      | 검증 메모                                 |

**응답**: `success`, `checkIndex`, `passed`, `checksRemaining`, `checksPassed`, `checksTotal`, `verificationStatus`, `allChecksPassed`

## 4. 구현 상세

### 4.1 TaskFile 확장

`TaskFile` 인터페이스에 harness 필드 추가. backlog JSON에 직렬화/파싱.

```typescript
harnessProjectSlug?: string; // Harness 프로젝트 slug
harnessItemId?: string;      // Harness 아이템 ID (verification 보고용)
```

### 4.2 task_backlog_add 스키마 확장

`TaskBacklogAddSchema`에 `harness_project_slug`, `harness_item_id` 추가.
Task Hub Launch → Gateway 호출 시 전달.

### 4.3 Prompt Injection (task-continuation-runner)

`formatBacklogPickupPrompt()`에서 `task.harnessProjectSlug`를 감지하면
harness protocol 블록을 pickup prompt에 주입:

```
## Harness Protocol
This is a harness-managed task. You MUST follow the harness protocol:
- **Harness Item ID:** {harnessItemId}
- **Project Slug:** {harnessProjectSlug}

1. Read `.harness/{slug}/specs/` for spec files
2. Follow each spec's steps in order
3. After completing each step, call harness_report_step(...)
4. After all steps, verify each checklist item and call harness_report_check(...)
5. Only mark task complete after ALL checks pass
```

### 4.4 Verify API (Task Hub)

`POST /api/harness/{itemId}/verify`

- **주의**: `[id]` 파라미터는 **itemId** (다른 harness 라우트의 projectId와 다름)

**type: "step"**

- `verification.stepProgress[]` lazy 초기화 (spec.steps 기반)
- `stepProgress[index]`에 `{ status, note, updatedAt }` upsert

**type: "check"**

- `verification.checklist[index].checked` 업데이트
- 전체 checklist checked 시 `verification.status = "passed"` 자동 전환

### 4.5 모델 확장 (Task Hub)

`IVerification`에 `stepProgress` 필드 추가:

```typescript
interface IStepProgress {
  index: number;
  status: "pending" | "done" | "skipped";
  note?: string;
  updatedAt?: Date;
}
```

## 5. 수정 파일 목록

### prontoclaw (Gateway)

| 파일                                    | 변경                                                          |
| --------------------------------------- | ------------------------------------------------------------- |
| `src/agents/tools/harness-tool.ts`      | **신규** — `harness_report_step`, `harness_report_check` 도구 |
| `src/agents/openclaw-tools.ts`          | `createHarnessTools()` 등록                                   |
| `src/agents/tools/task-file-io.ts`      | `TaskFile`에 `harnessProjectSlug`, `harnessItemId` 추가       |
| `src/agents/tools/task-blocking.ts`     | `TaskBacklogAddSchema`에 harness 필드 추가                    |
| `src/infra/task-continuation-runner.ts` | `formatBacklogPickupPrompt`에 harness protocol 주입           |

### task-hub (Next.js)

| 파일                                       | 변경                                      |
| ------------------------------------------ | ----------------------------------------- |
| `src/models/Harness.ts`                    | `IStepProgress`, `stepProgress` 필드 추가 |
| `src/app/api/harness/[id]/verify/route.ts` | **신규** — Verify API                     |
| `src/lib/harness/export-files.ts`          | **신규** — `generateHarnessFiles()`       |
| `src/app/api/harness/[id]/export/route.ts` | POST 응답에 `files` 배열 추가             |
| `src/lib/gateway.ts`                       | `delegateToAgent`에 harness 옵션 추가     |
| `src/app/api/harness/[id]/launch/route.ts` | harness 메타데이터 전달                   |

### prontoclaw-config

| 파일                                   | 변경                              |
| -------------------------------------- | --------------------------------- |
| `workspace-shared/HARNESS-PROTOCOL.md` | **신규** — 에이전트 프로토콜 문서 |

## 6. 테스트

```bash
# Harness tool 단위 테스트 (8 tests)
npx vitest run src/agents/tools/harness-tool.test.ts

# TaskFile harness roundtrip 테스트
npx vitest run src/agents/tools/task-file-io.test.ts
```

- `harness-tool.test.ts`: `globalThis.fetch = fetchMock` 패턴 사용 (vitest forks pool 필수)
- `task-file-io.test.ts`: harness 필드 roundtrip 3건 (harness only, milestone+harness, undefined)

## 7. 환경변수

| 변수           | 기본값                  | 용도                             |
| -------------- | ----------------------- | -------------------------------- |
| `TASK_HUB_URL` | `http://localhost:3102` | harness-tool에서 Verify API 호출 |

---

_작성일: 2026-03-03_
