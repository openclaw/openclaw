---
summary: "macOS Skills settings UI and gateway-backed status"
read_when:
  - Updating the macOS Skills settings UI
  - Changing skills gating or install behavior
title: "Skills"
x-i18n:
  source_hash: ecd5286bbe49eed89319686c4f7d6da55ef7b0d3952656ba98ef5e769f3fbf79
---

# 스킬(macOS)

macOS 앱은 게이트웨이를 통해 OpenClaw 기술을 표면화합니다. 기술을 로컬로 구문 분석하지 않습니다.

## 데이터 소스

- `skills.status` (게이트웨이)는 모든 기술과 자격 및 누락된 요구 사항을 반환합니다.
  (번들 기술에 대한 허용 목록 블록 포함)
- 요구사항은 각 `SKILL.md`의 `metadata.openclaw.requires`에서 파생됩니다.

## 설치 작업

- `metadata.openclaw.install`는 설치 옵션(brew/node/go/uv)을 정의합니다.
- 앱은 `skills.install`를 호출하여 게이트웨이 호스트에서 설치 프로그램을 실행합니다.
- 게이트웨이는 여러 개가 제공되는 경우 기본 설치 프로그램을 하나만 표시합니다.
  (사용 가능한 경우 추출하고, 그렇지 않으면 `skills.install`의 노드 관리자, 기본 npm).

## 환경/API 키

- 앱은 `skills.entries.<skillKey>` 아래의 `~/.openclaw/openclaw.json`에 키를 저장합니다.
- `skills.update` 패치 `enabled`, `apiKey`, `env`를 패치합니다.

## 원격 모드

- 설치 + 구성 업데이트는 게이트웨이 호스트(로컬 Mac이 아님)에서 발생합니다.
