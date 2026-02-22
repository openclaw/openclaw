---
summary: "macOS 스킬 설정 UI 및 게이트웨이 지원 상태"
read_when:
  - macOS 스킬 설정 UI 업데이트
  - 스킬 게이팅 또는 설치 동작 변경
title: "스킬"
---

# 스킬 (macOS)

macOS 앱은 OpenClaw 스킬을 게이트웨이를 통해 노출합니다. 로컬에서 스킬을 구문 분석하지 않습니다.

## 데이터 소스

- `skills.status` (게이트웨이)는 모든 스킬과 적격성 및 누락된 요구 사항을 반환합니다
  (번들 스킬에 대한 허용 목록 차단 포함).
- 요구 사항은 각 `SKILL.md`의 `metadata.openclaw.requires`에서 파생됩니다.

## 설치 동작

- `metadata.openclaw.install`는 설치 옵션을 정의합니다 (brew/node/go/uv).
- 앱은 게이트웨이 호스트에서 설치 프로그램을 실행하기 위해 `skills.install`을 호출합니다.
- 게이트웨이는 여러 설치 프로그램이 제공될 경우 하나의 선호하는 설치 프로그램만 노출합니다
  (사용 가능한 경우 brew, 그렇지 않으면 `skills.install`의 노드 관리자에서, 기본 npm).

## 환경/API 키

- 앱은 키를 `~/.openclaw/openclaw.json`의 `skills.entries.<skillKey>`에 저장합니다.
- `skills.update`는 `enabled`, `apiKey`, 및 `env`를 수정합니다.

## 원격 모드

- 설치 + 설정 업데이트는 로컬 Mac이 아닌 게이트웨이 호스트에서 발생합니다.
