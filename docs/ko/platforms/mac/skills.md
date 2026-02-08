---
read_when:
    - macOS 기술 설정 UI 업데이트
    - 스킬 게이팅 또는 설치 동작 변경
summary: macOS Skills 설정 UI 및 게이트웨이 지원 상태
title: 기술
x-i18n:
    generated_at: "2026-02-08T16:04:47Z"
    model: gtx
    provider: google-translate
    source_hash: ecd5286bbe49eed89319686c4f7d6da55ef7b0d3952656ba98ef5e769f3fbf79
    source_path: platforms/mac/skills.md
    workflow: 15
---

# 스킬(macOS)

macOS 앱은 게이트웨이를 통해 OpenClaw 기술을 표면화합니다. 기술을 로컬로 구문 분석하지 않습니다.

## 데이터 소스

- `skills.status` (게이트웨이)는 모든 기술과 자격 및 누락된 요구 사항을 반환합니다.
  (번들 기술에 대한 허용 목록 블록 포함)
- 요구사항은 다음에서 파생됩니다. `metadata.openclaw.requires` 각각 `SKILL.md`.

## 설치 작업

- `metadata.openclaw.install` 설치 옵션(brew/node/go/uv)을 정의합니다.
- 앱이 호출합니다. `skills.install` 게이트웨이 호스트에서 설치 프로그램을 실행합니다.
- 게이트웨이는 여러 개가 제공되는 경우 기본 설치 프로그램을 하나만 표시합니다.
  (사용 가능한 경우 추출하고, 그렇지 않으면 노드 관리자에서 `skills.install`, 기본 npm).

## 환경/API 키

- 앱은 키를 다음 위치에 저장합니다. `~/.openclaw/openclaw.json` 아래에 `skills.entries.<skillKey>`.
- `skills.update` 패치 `enabled`, `apiKey`, 그리고 `env`.

## 원격 모드

- 설치 + 구성 업데이트는 게이트웨이 호스트(로컬 Mac이 아님)에서 발생합니다.
