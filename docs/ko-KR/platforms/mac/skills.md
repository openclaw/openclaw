---
summary: "macOS Skills 설정 UI 및 gateway-backed 상태"
read_when:
  - macOS Skills 설정 UI를 업데이트할 때
  - skills 게이팅 또는 설치 동작을 변경할 때
title: "Skills"
x-i18n:
  generated_at: "2026-03-02T00:00:00Z"
  model: "claude-opus-4-6"
  provider: "pi"
  source_path: "docs/platforms/mac/skills.md"
  workflow: 15
---

# Skills (macOS)

macOS 앱은 gateway를 통해 OpenClaw skills를 표시합니다. 로컬로 skills를 구문 분석하지 않습니다.

## 데이터 원본

- `skills.status` (gateway)는 모든 skills 더하기 자격 및 누락된 요구 사항을 반환합니다
  (번들된 skills에 대한 허용 목록 차단 포함).
- 요구 사항은 각 `SKILL.md`의 `metadata.openclaw.requires`에서 파생됩니다.

## 설치 작업

- `metadata.openclaw.install`은 설치 옵션을 정의합니다 (brew/node/go/uv).
- 앱은 gateway 호스트에서 설치를 실행하기 위해 `skills.install`을 호출합니다.
- gateway는 여러 제공자 경우 단 하나의 선호 설치를 표시합니다
  (이용 가능한 brew, 그렇지 않으면 `skills.install`의 node 관리자, 기본 npm).

## Env/API 키

- 앱은 키를 `~/.openclaw/openclaw.json`의 `skills.entries.<skillKey>` 아래에 저장합니다.
- `skills.update`는 `enabled`, `apiKey`, 그리고 `env`를 패치합니다.

## 원격 모드

- 설치 + 구성 업데이트는 gateway 호스트에서 발생합니다 (로컬 Mac이 아님).
