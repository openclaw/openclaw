---
summary: "macOS Skills 설정 UI 및 Gateway 기반 상태"
read_when:
  - macOS Skills 설정 UI 를 업데이트할 때
  - Skills 게이팅 또는 설치 동작을 변경할 때
title: "Skills (macOS)"
x-i18n:
  source_path: docs/platforms/mac/skills.md
---

# Skills (macOS)

macOS 앱은 Gateway 를 통해 OpenClaw Skills 를 표시합니다; 로컬에서 Skills 를 파싱하지 않습니다.

## 데이터 소스

- `skills.status` (Gateway) 가 모든 Skills 와 자격 및 누락된 요구 사항
  (번들된 Skills 에 대한 허용 목록 차단 포함) 을 반환합니다.
- 요구 사항은 각 `SKILL.md` 의 `metadata.openclaw.requires` 에서 파생됩니다.

## 설치 작업

- `metadata.openclaw.install` 이 설치 옵션 (brew/node/go/uv) 을 정의합니다.
- 앱이 `skills.install` 을 호출하여 Gateway 호스트에서 설치 프로그램을 실행합니다.
- 여러 설치 프로그램이 제공될 때 Gateway 는 하나의 선호 설치 프로그램만 표시합니다
  (사용 가능할 때 brew, 그렇지 않으면 `skills.install` 의 노드 관리자, 기본값 npm).

## 환경/API 키

- 앱은 `~/.openclaw/openclaw.json` 의 `skills.entries.<skillKey>` 아래에 키를 저장합니다.
- `skills.update` 가 `enabled`, `apiKey`, `env` 를 패치합니다.

## 원격 모드

- 설치 + 설정 업데이트는 Gateway 호스트에서 발생합니다 (로컬 Mac 이 아님).
