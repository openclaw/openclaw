---
summary: Node + tsx "__name is not a function" 충돌 메모 및 해결 방법
read_when:
  - Node 전용 개발 스크립트 또는 watch 모드 실패를 디버깅할 때
  - OpenClaw 에서 tsx/esbuild 로더 충돌을 조사할 때
title: "Node + tsx 충돌"
---

# Node + tsx "\_\_name is not a function" 충돌

## 요약

Node 를 통해 OpenClaw 를 실행할 때 `tsx` 로 시작 시 다음 오류와 함께 실패합니다:

```
[openclaw] Failed to start CLI: TypeError: __name is not a function
    at createSubsystemLogger (.../src/logging/subsystem.ts:203:25)
    at .../src/agents/auth-profiles/constants.ts:25:20
```

이는 개발 스크립트를 Bun 에서 `tsx` 로 전환한 이후(커밋 `2871657e`, 2026-01-06) 발생하기 시작했습니다. 동일한 런타임 경로는 Bun 에서는 정상 동작했습니다.

## 환경

- Node: v25.x (v25.3.0 에서 관찰됨)
- tsx: 4.21.0
- OS: macOS (Node 25 를 실행하는 다른 플랫폼에서도 재현 가능성이 높음)

## 재현 (Node 전용)

```bash
# in repo root
node --version
pnpm install
node --import tsx src/entry.ts status
```

## 리포지토리의 최소 재현 예제

```bash
node --import tsx scripts/repro/tsx-name-repro.ts
```

## Node 버전 확인

- Node 25.3.0: 실패
- Node 22.22.0 (Homebrew `node@22`): 실패
- Node 24: 아직 설치되지 않음; 검증 필요

## 메모 / 가설

- `tsx` 는 esbuild 를 사용해 TS/ESM 을 변환합니다. esbuild 의 `keepNames` 는 `__name` 헬퍼를 출력하고 함수 정의를 `__name(...)` 로 감쌉니다.
- 충돌은 `__name` 가 존재하지만 런타임에서 함수가 아님을 나타내며, 이는 Node 25 로더 경로에서 해당 모듈에 대해 헬퍼가 누락되었거나 덮어써졌음을 시사합니다.
- 유사한 `__name` 헬퍼 문제는 헬퍼가 누락되거나 재작성될 때 다른 esbuild 소비자에서도 보고되었습니다.

## 회귀 이력

- `2871657e` (2026-01-06): Bun 을 선택 사항으로 만들기 위해 스크립트를 Bun 에서 tsx 로 변경.
- 그 이전(Bun 경로)에는 `openclaw status` 및 `gateway:watch` 가 정상 동작했습니다.

## 해결 방법

- 개발 스크립트에 Bun 사용(현재의 임시 되돌림).

- Node + tsc watch 를 사용한 다음, 컴파일된 출력을 실행:

  ```bash
  pnpm exec tsc --watch --preserveWatchOutput
  node --watch openclaw.mjs status
  ```

- 로컬에서 확인됨: Node 25 에서 `pnpm exec tsc -p tsconfig.json` + `node openclaw.mjs status` 조합이 동작합니다.

- 가능하다면 TS 로더에서 esbuild keepNames 를 비활성화( `__name` 헬퍼 삽입을 방지); tsx 는 현재 이를 노출하지 않습니다.

- Node LTS (22/24) 를 `tsx` 와 함께 테스트하여 Node 25 전용 문제인지 확인합니다.

## 참고 자료

- [https://opennext.js.org/cloudflare/howtos/keep_names](https://opennext.js.org/cloudflare/howtos/keep_names)
- [https://esbuild.github.io/api/#keep-names](https://esbuild.github.io/api/#keep-names)
- [https://github.com/evanw/esbuild/issues/1031](https://github.com/evanw/esbuild/issues/1031)

## 다음 단계

- Node 22/24 에서 재현하여 Node 25 회귀 여부를 확인합니다.
- 알려진 회귀가 있는지 `tsx` 나이틀리를 테스트하거나 이전 버전으로 고정합니다.
- Node LTS 에서도 재현된다면 `__name` 스택 트레이스와 함께 최소 재현을 업스트림에 보고합니다.
