---
summary: "macOS Skills 설정 UI 및 Gateway(게이트웨이) 기반 상태"
read_when:
  - macOS Skills 설정 UI 를 업데이트할 때
  - Skills 게이팅 또는 설치 동작을 변경할 때
title: "Skills"
---

# Skills (macOS)

macOS 앱은 Gateway(게이트웨이)를 통해 OpenClaw Skills 를 노출하며, Skills 를 로컬에서 파싱하지 않습니다.

## Data source

- `skills.status` (Gateway(게이트웨이))는 모든 Skills 와 적격성 및 누락된 요구 사항을 반환합니다
  (번들된 Skills 에 대한 allowlist 차단 포함).
- 요구 사항은 각 `SKILL.md` 내의 `metadata.openclaw.requires` 에서 파생됩니다.

## Install actions

- `metadata.openclaw.install` 는 설치 옵션 (brew/node/go/uv) 을 정의합니다.
- 앱은 Gateway(게이트웨이) 호스트에서 설치 프로그램을 실행하기 위해 `skills.install` 를 호출합니다.
- 여러 옵션이 제공되는 경우 Gateway(게이트웨이)는 하나의 선호 설치 프로그램만 노출합니다
  (가능한 경우 brew, 그렇지 않으면 `skills.install` 의 node manager, 기본값은 npm).

## Env/API keys

- 앱은 `skills.entries.<skillKey> ` 아래의 `~/.openclaw/openclaw.json` 에 키를 저장합니다.36. \`.
- `skills.update` 는 `enabled`, `apiKey`, 및 `env` 을 패치합니다.

## Remote mode

- 설치 및 설정 업데이트는 로컬 Mac 이 아닌 Gateway(게이트웨이) 호스트에서 이루어집니다.
