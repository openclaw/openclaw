---
title: CI Pipeline
description: How the OpenClaw CI pipeline works
x-i18n:
  source_hash: 4ce7e33bbac926a4d0f2f0dc23fece51159e98de3e6162894489434d8074bad2
---

# CI 파이프라인

CI는 `main`에 대한 모든 푸시와 모든 풀 요청에서 실행됩니다. 문서나 기본 코드만 변경된 경우 스마트 범위 지정을 사용하여 비용이 많이 드는 작업을 건너뜁니다.

## 직무 개요

| 직업              | 목적                                     | 실행될 때                   |
| ----------------- | ---------------------------------------- | --------------------------- |
| `docs-scope`      | 문서 전용 변경 사항 감지                 | 항상                        |
| `changed-scope`   | 변경된 영역 감지(노드/macos/Android)     | 문서가 아닌 PR              |
| `check`           | TypeScript 유형, 린트, 형식              | 문서가 아닌 변경사항        |
| `check-docs`      | 마크다운 린트 + 끊어진 링크 확인         | 문서가 변경되었습니다       |
| `code-analysis`   | LOC 임계값 확인(1000라인)                | PR만                        |
| `secrets`         | 유출된 비밀 감지                         | 항상                        |
| `build-artifacts` | dist를 한 번만 구축하면 다른 작업과 공유 | 비문서, 노드 변경           |
| `release-check`   | npm 팩 내용 유효성 검사                  | 빌드 후                     |
| `checks`          | 노드/Bun 테스트 + 프로토콜 확인          | 비문서, 노드 변경           |
| `checks-windows`  | Windows 관련 테스트                      | 비문서, 노드 변경           |
| `macos`           | Swift 린트/빌드/테스트 + TS 테스트       | macOS 변경 사항이 포함된 PR |
| `android`         | Gradle 빌드 + 테스트                     | 비 문서, 안드로이드 변경    |

## 빠른 실패 주문

작업은 주문되므로 값비싼 검사가 실행되기 전에 저렴한 검사가 실패합니다.

1. `docs-scope` + `code-analysis` + `check` (병렬, ~1-2분)
2. `build-artifacts` (위에서 차단됨)
3. `checks`, `checks-windows`, `macos`, `android` (빌드 시 차단됨)

## 주자

| 러너                            | 채용정보                |
| ------------------------------- | ----------------------- |
| `blacksmith-4vcpu-ubuntu-2404`  | 대부분의 Linux 채용정보 |
| `blacksmith-4vcpu-windows-2025` | `checks-windows`        |
| `macos-latest`                  | `macos`, `ios`          |
| `ubuntu-latest`                 | 스코프 감지(경량)       |

## 로컬 등가물

```bash
pnpm check          # types + lint + format
pnpm test           # vitest tests
pnpm check:docs     # docs format + lint + broken links
pnpm release:check  # validate npm pack
```
