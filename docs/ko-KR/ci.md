---
title: CI 파이프라인
description: OpenClaw CI 파이프라인 작동 방식
---

# CI 파이프라인

CI는 `main`에 대한 모든 푸시와 모든 풀 리퀘스트에서 실행됩니다. 문서나 네이티브 코드만 변경된 경우 비용이 큰 작업을 건너뛰기 위해 스마트 스코핑을 사용합니다.

## 작업 개요

| 작업              | 목적                                   | 실행 시점             |
| ----------------- | -------------------------------------- | --------------------- |
| `docs-scope`      | 문서만 변경되었는지 감지               | 항상                  |
| `changed-scope`   | 변경된 영역 감지 (node/macos/android)  | 문서 외 PR            |
| `check`           | TypeScript 타입, 린트, 포맷            | 문서 외 변경          |
| `check-docs`      | Markdown 린트 + 깨진 링크 검사         | 문서 변경 시          |
| `code-analysis`   | LOC 임계값 검사 (1000줄)               | PR만                  |
| `secrets`         | 유출된 시크릿 감지                     | 항상                  |
| `build-artifacts` | dist를 한 번 빌드하고 다른 작업과 공유 | 문서 외, node 변경    |
| `release-check`   | npm pack 콘텐츠 검증                   | 빌드 후               |
| `checks`          | Node/Bun 테스트 + 프로토콜 검사        | 문서 외, node 변경    |
| `checks-windows`  | Windows 전용 테스트                    | 문서 외, node 변경    |
| `macos`           | Swift 린트/빌드/테스트 + TS 테스트     | macos 변경이 있는 PR  |
| `android`         | Gradle 빌드 + 테스트                   | 문서 외, android 변경 |

## Fail-Fast 순서

비용이 적은 검사가 먼저 실패하도록 작업이 정렬됩니다:

1. `docs-scope` + `code-analysis` + `check` (병렬, ~1-2분)
2. `build-artifacts` (위 작업에 의해 차단)
3. `checks`, `checks-windows`, `macos`, `android` (빌드에 의해 차단)

## 러너

| 러너                             | 작업                                 |
| -------------------------------- | ------------------------------------ |
| `blacksmith-16vcpu-ubuntu-2404`  | 스코프 감지 포함 대부분의 Linux 작업 |
| `blacksmith-16vcpu-windows-2025` | `checks-windows`                     |
| `macos-latest`                   | `macos`, `ios`                       |

## 로컬 동등 명령어

```bash
pnpm check          # 타입 + 린트 + 포맷
pnpm test           # vitest 테스트
pnpm check:docs     # 문서 포맷 + 린트 + 깨진 링크
pnpm release:check  # npm pack 검증
```
