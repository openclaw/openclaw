# TOOLS.md - Environment Notes

_프로젝트별 상세 정보는 `memory/`에 있음. 여기는 환경 설정 + 매턴 필요한 규칙만._

## ⚠️ 파일 쓰기 경로 제한

- `C:\MAIBOT\...` → ✅ `write`/`edit` 도구
- 외부 (`C:\TEST\*`, Obsidian 볼트) → ❌ write 실패 → `exec` + PowerShell `Out-File`/`Set-Content` 사용
- **Obsidian 전용 헬퍼:** `exec 'C:\MAIBOT\scripts\write-obsidian.ps1 -RelPath "경로" -Content $content'`  
  (경로는 볼트 루트 기준 상대경로, UTF-8 자동 처리)

## MAIBOT 개발 명령

| 명령                                      | 용도                                   |
| ----------------------------------------- | -------------------------------------- |
| `pnpm build`                              | TypeScript compile + canvas + metadata |
| `pnpm dev`                                | 개발 실행                              |
| `pnpm test`                               | 테스트 (vitest)                        |
| `pnpm test:coverage`                      | 커버리지 (70% threshold)               |
| `pnpm gateway:dev`                        | 게이트웨이 개발 (SKIP_CHANNELS=1)      |
| `prek install && pnpm build && pnpm test` | Pre-commit                             |

## 환경

- **Node:** ≥22.12.0 | **PM:** pnpm@10.23.0 | **Alt:** bun
- **Timezone:** Asia/Seoul (GMT+9)
- **MCP:** Playwright, Fetcher, Context7, Magic

## Discord 노티 규칙

- **DM 전용**: 채널 1466624220632059934 으로만 전송
- **#일반(1466615738512179394) 절대 금지** (보안 위험)
- 민감 정보 (규정 번호, 내부 시스템명) 포함 금지

## Obsidian 볼트

- **경로:** `C:\Users\jini9\OneDrive\Documents\JINI_SYNC`
- **구조:** PARA 기반 (`00.DAILY`, `01.PROJECT/XX.프로젝트명`, `02.AREA`, `03.RESOURCES`, `04.ARCHIVE`)
- **동기화:** OneDrive → 아이패드 Obsidian 실시간 반영
- **규칙:** 새 프로젝트 → `01.PROJECT/XX.프로젝트명/` 에 생성

## 프로젝트별 참조 (memory/)

| 프로젝트   | 스크립트/서비스 정보                                            |
| ---------- | --------------------------------------------------------------- |
| M.AI.UPbit | `memory/maiupbit.md` — 스크립트 매핑, 퀀트 명령, 매매 안전 규칙 |
| MAIBEAUTY  | `memory/vietnam-beauty.md` — 서비스 접근, API, gcloud           |

_Last updated: 2026-03-08_
