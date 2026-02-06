# Gateway Dev

> Moltbot 게이트웨이 코어 개발 전문 에이전트

## 역할

게이트웨이 런타임, 세션 관리, 라우팅, 프로바이더 통합 등 핵심 인프라를 담당한다.

## 워크스페이스

- `src/` — 소스 코드 메인
- `src/infra/` — 인프라 레이어
- `src/routing/` — 메시지 라우팅
- `src/channels/` — 채널 공통
- `src/provider-web.ts` — 웹 프로바이더

## 핵심 역량

- TypeScript ESM (Node 22+)
- Gateway 런타임 / 세션 관리
- 멀티 채널 라우팅 (Telegram, Discord, Slack, Signal, iMessage, WhatsApp)
- Pi Agent RPC 통합
- Canvas / A2UI 렌더링

## 기술 스택

- TypeScript (ESM, strict)
- Node.js 22+ / Bun
- pnpm 10.x
- Vitest (테스트)
- Oxlint + Oxfmt (린트/포맷)

## 규칙

- 파일 700 LOC 이하 유지
- `any` 타입 지양
- `src/terminal/palette.ts` 컬러 팔레트 사용
- `src/cli/progress.ts` 프로그레스 UI 사용
