---
summary: "Bun 워크플로우 (실험적): pnpm 대비 설치 및 주의사항"
read_when:
  - 가장 빠른 로컬 개발 루프를 원할 때 (bun + watch)
  - Bun 설치/패치/생명주기 스크립트 문제를 겪을 때
title: "Bun (실험적)"
---

# Bun (실험적)

목표: **Bun**을 사용하여 이 저장소를 실행하는 것 (Optional, WhatsApp/Telegram에서는 권장하지 않음)  
pnpm 워크플로우에서 벗어나지 않는 것이 목표입니다.

⚠️ **게이트웨이 런타임에서는 권장되지 않음** (WhatsApp/Telegram 버그). 프로덕션에서는 Node를 사용하세요.

## 상태

- Bun은 TypeScript를 직접 실행할 수 있는 선택적 로컬 런타임입니다 (`bun run …`, `bun --watch …`).
- `pnpm`은 빌드의 기본 도구로 완전히 지원되며 일부 문서 도구에서도 사용됩니다.
- Bun은 `pnpm-lock.yaml`을 사용할 수 없으며 이를 무시합니다.

## 설치

기본:

```sh
bun install
```

참고: `bun.lock`/`bun.lockb`는 gitignore 처리되어 있으므로 리포지토리 변동이 없습니다. *잠금 파일 미작성*을 원한다면:

```sh
bun install --no-save
```

## 빌드 / 테스트 (Bun)

```sh
bun run build
bun run vitest run
```

## Bun 생명주기 스크립트 (기본적으로 차단됨)

Bun은 명시적으로 신뢰되지 않는 한 종속성 생명주기 스크립트를 차단할 수 있습니다(`bun pm untrusted` / `bun pm trust`).  
이 저장소에서는 일반적으로 차단된 스크립트가 필요하지 않습니다:

- `@whiskeysockets/baileys` `preinstall`: Node 메이저 >= 20를 체크함 (Node 22+ 사용 중).
- `protobufjs` `postinstall`: 호환되지 않는 버전 스키마에 대한 경고를 출력함 (빌드 산출물 없음).

실제로 이러한 스크립트가 필요한 실행 문제를 겪을 경우, 명시적으로 신뢰하세요:

```sh
bun pm trust @whiskeysockets/baileys protobufjs
```

## 주의사항

- 일부 스크립트는 여전히 pnpm을 하드코딩하고 있습니다 (예: `docs:build`, `ui:*`, `protocol:check`). 해당 스크립트는 현재 pnpm을 통해 실행하세요.
