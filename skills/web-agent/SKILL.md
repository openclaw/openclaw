---
name: web-agent
description: Browser-based web automation agent (CUA). Use when automating web tasks without APIs - price monitoring, form filling, data scraping, account management. Supports multi-step workflows with error recovery. Triggers on "웹 자동화", "가격 모니터링", "스크래핑", "브라우저 자동화", "web agent", "CUA".
---

# Web Agent (CUA) 스킬

browser 도구 기반 Computer-Using Agent. API가 없는 웹사이트를 자동화한다.

## 핵심 워크플로우

### 1. 목표 분해 (Goal Decomposition)

사용자 요청을 단계별 브라우저 액션으로 분해한다.

- "쇼피에서 선크림 가격 확인해줘" → navigate → search → extract prices

### 2. 화면 인식 (Screen Recognition)

```
browser snapshot (refs="aria")  → DOM 트리로 현재 상태 파악
browser screenshot              → 시각적 확인 (레이아웃, 이미지 등)
```

- **항상 snapshot 먼저** 실행하여 페이지 구조 파악
- refs="aria" 사용 시 안정적인 요소 참조 가능

### 3. 액션 실행 (Action Execution)

```
browser act → request: { kind: "click", ref: "e12" }
browser act → request: { kind: "type", ref: "e15", text: "sunscreen" }
browser act → request: { kind: "press", ref: "e15", key: "Enter" }
browser navigate → targetUrl: "https://example.com"
```

### 4. 결과 검증 (Verification)

액션 실행 후 **반드시 snapshot으로 성공 여부 확인**.

- 페이지 전환 확인
- 예상 요소 존재 여부
- 에러 메시지 감지

### 5. 에러 복구 (Error Recovery)

| 상황         | 대응                                              |
| ------------ | ------------------------------------------------- |
| 팝업/모달    | snapshot → 닫기 버튼(X, Close, 닫기) 클릭         |
| 로딩 지연    | `act: { kind: "wait", timeMs: 3000 }` (최대 10초) |
| 요소 못 찾음 | 스크롤 다운 후 재 snapshot                        |
| CAPTCHA      | 사용자에게 Discord DM 알림, 대기                  |
| 세션 만료    | 재로그인 시도                                     |
| 페이지 에러  | navigate로 재접근                                 |

### 6. 결과 추출 (Data Extraction)

snapshot에서 텍스트 추출 → 구조화된 데이터(JSON/마크다운)로 변환.

## Browser 도구 액션 레퍼런스

| 액션         | 용도      | 주요 파라미터                            |
| ------------ | --------- | ---------------------------------------- |
| `navigate`   | URL 이동  | `targetUrl`                              |
| `snapshot`   | DOM 캡처  | `refs="aria"`, `compact`, `element`      |
| `screenshot` | 시각 캡처 | `fullPage`, `type`                       |
| `act`        | 복합 액션 | `request: { kind, ref, text, key, ... }` |

### act request kinds

- **click**: `{ kind: "click", ref: "e12" }` — 더블클릭: `doubleClick: true`
- **type**: `{ kind: "type", ref: "e15", text: "query", submit: true }` — submit=true로 Enter 포함
- **press**: `{ kind: "press", key: "Enter" }` — 키보드 입력
- **fill**: `{ kind: "fill", ref: "e15", text: "value" }` — 필드 값 설정
- **hover**: `{ kind: "hover", ref: "e12" }` — 마우스 오버
- **select**: `{ kind: "select", ref: "e20", values: ["option1"] }` — 드롭다운
- **wait**: `{ kind: "wait", timeMs: 2000 }` — 대기 (예외적 사용)
- **evaluate**: `{ kind: "evaluate", fn: "() => document.title" }` — JS 실행

### 팁

- `targetId` 유지: 같은 탭 작업 시 snapshot 응답의 targetId를 재사용
- `profile="openclaw"`: 격리된 브라우저 사용
- `profile="chrome"`: Chrome 확장 릴레이 (사용자 탭 접근)

## 결과 저장 패턴

- **단발 데이터** → `memory/*.md`에 저장
- **시계열 데이터** → 날짜별 누적 (예: `docs/prices/2026-02-20.md`)
- **알림** → Discord DM으로 가격 변동/이상 감지 전송
- **대량 데이터** → JSON 파일로 저장

## 템플릿

상세 워크플로우는 `references/` 폴더 참조:

- `shopee-monitor.md` — Shopee 가격 모니터링
- `lazada-monitor.md` — Lazada 가격 모니터링
- `tiktok-shop-monitor.md` — TikTok Shop 모니터링
- `generic-scraper.md` — 범용 웹 스크래핑
- `form-filler.md` — 범용 폼 입력
