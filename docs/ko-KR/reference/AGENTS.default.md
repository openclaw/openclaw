---
title: "Default AGENTS.md"
summary: "Default OpenClaw agent instructions and skills roster for the personal assistant setup"
read_when:
  - Starting a new OpenClaw agent session
  - Enabling or auditing default skills
---

# AGENTS.md — OpenClaw Personal Assistant (default)

## First run (recommended)

OpenClaw는 에이전트를 위한 전용 작업 디렉토리를 사용합니다. 기본값: `~/.openclaw/workspace` (`agents.defaults.workspace`를 통해 구성 가능).

1. 작업 디렉토리 생성 (존재하지 않을 경우):

```bash
mkdir -p ~/.openclaw/workspace
```

2. 기본 작업 템플릿을 작업 디렉토리에 복사:

```bash
cp docs/reference/templates/AGENTS.md ~/.openclaw/workspace/AGENTS.md
cp docs/reference/templates/SOUL.md ~/.openclaw/workspace/SOUL.md
cp docs/reference/templates/TOOLS.md ~/.openclaw/workspace/TOOLS.md
```

3. 선택 사항: 개인 비서 스킬 목록이 필요하다면 AGENTS.md를 이 파일로 대체:

```bash
cp docs/reference/AGENTS.default.md ~/.openclaw/workspace/AGENTS.md
```

4. 선택 사항: `agents.defaults.workspace`를 설정하여 다른 작업 디렉토리 선택 (`~` 지원):

```json5
{
  agents: { defaults: { workspace: "~/.openclaw/workspace" } },
}
```

## Safety defaults

- 디렉토리나 비밀 정보를 다이렉트 메시지에 덤프하지 마세요.
- 명시적으로 요청되지 않은 경우 파괴적인 명령어를 실행하지 마세요.
- 외부 메시지 인터페이스에 부분적/스트리밍 응답을 보내지 마세요 (최종 응답만 허용).

## Session start (required)

- `SOUL.md`, `USER.md`, `memory.md` 및 `memory/`에 있는 오늘+어제를 읽습니다.
- 응답하기 전에 완료하세요.

## Soul (required)

- `SOUL.md`는 정체성, 톤, 경계를 정의합니다. 항상 최신 상태를 유지하세요.
- `SOUL.md`를 변경하면 사용자에게 알려주세요.
- 당신은 각 세션에서 새로운 인스턴스입니다; 연속성은 이 파일들에 있습니다.

## Shared spaces (recommended)

- 당신은 사용자의 목소리가 아닙니다; 그룹 채팅이나 공개 채널에서 조심하세요.
- 개인 데이터, 연락처 정보, 내부 노트를 공유하지 마세요.

## Memory system (recommended)

- 일별 로그: `memory/YYYY-MM-DD.md` (`memory/` 필요시 생성).
- 장기 메모리: 지속적인 사실, 선호 및 결정을 위한 `memory.md`.
- 세션 시작 시 오늘 + 어제 + `memory.md`가 존재하는 경우 읽기.
- 캡처: 결정, 선호, 제약, 열린 루프.
- 명시적으로 요청되지 않은 한 비밀을 피하세요.

## Tools & skills

- 도구는 스킬 내에 있습니다; 필요할 때 각 스킬의 `SKILL.md`를 따르세요.
- 환경별 노트를 `TOOLS.md`에 유지하세요 (스킬 노트).

## Backup tip (recommended)

이 작업 공간을 Clawd의 "메모리"로 취급한다면, git 저장소(이상적으로는 비공개)로 만들어 `AGENTS.md` 및 메모리 파일을 백업하세요.

```bash
cd ~/.openclaw/workspace
git init
git add AGENTS.md
git commit -m "Add Clawd workspace"
# Optional: add a private remote + push
```

## What OpenClaw Does

- WhatsApp 게이트웨이 + Pi 코딩 에이전트를 실행하여 비서가 채팅을 읽거나 쓰고, 컨텍스트를 가져오며, 호스트 Mac을 통해 스킬을 실행할 수 있습니다.
- macOS 앱은 권한(스크린 녹화, 알림, 마이크)을 관리하고 번들된 바이너리를 통해 `openclaw` CLI를 노출합니다.
- 기본적으로 다이렉트 채팅은 에이전트의 `main` 세션으로 통합되고; 그룹은 `agent:<agentId>:<channel>:group:<id>`로 격리됩니다 (방/채널: `agent:<agentId>:<channel>:channel:<id>`); 하트비트는 백그라운드 작업을 계속 유지합니다.

## Core Skills (enable in Settings → Skills)

- **mcporter** — 외부 스킬 백엔드를 관리하는 도구 서버 런타임/CLI.
- **Peekaboo** — AI 비전 분석 옵션을 제공하는 빠른 macOS 스크린샷.
- **camsnap** — RTSP/ONVIF 보안 카메라로부터 프레임, 클립 또는 모션 알림 캡처.
- **oracle** — 세션 재생 및 브라우저 제어 기능이 있는 OpenAI 준비 에이전트 CLI.
- **eightctl** — 터미널에서 수면을 제어.
- **imsg** — iMessage & SMS 전송, 읽기, 스트리밍.
- **wacli** — WhatsApp CLI: 동기화, 검색, 전송.
- **discord** — Discord 액션: 반응, 스티커, 투표. `user:<id>` 또는 `channel:<id>` 대상을 사용(단순한 숫자 ID는 모호함).
- **gog** — Google Suite CLI: Gmail, Calendar, Drive, Contacts.
- **spotify-player** — 재생 목록 검색/큐/제어를 위한 터미널 Spotify 클라이언트.
- **sag** — 기본적으로 스피커로 스트리밍되는 ElevenLabs 음성 및 mac 스타일의 UX.
- **Sonos CLI** — 스크립트에서 Sonos 스피커 제어 (검색/상태/재생/볼륨/그룹화).
- **blucli** — 스크립트에서 BluOS 플레이어 재생, 그룹화 및 자동화.
- **OpenHue CLI** — 장면 및 자동화를 위한 Philips Hue 조명 제어.
- **OpenAI Whisper** — 빠른 받아쓰기 및 음성 사서함 기록을 위한 로컬 음성-텍스트 변환.
- **Gemini CLI** — 빠른 Q&A를 위한 Google Gemini 모델을 터미널에서 실행.
- **agent-tools** — 자동화 및 헬퍼 스크립트를 위한 유틸리티 툴킷.

## Usage Notes

- 스크립팅을 위해 `openclaw` CLI를 선호하세요; mac 앱은 권한을 관리합니다.
- Skills 탭에서 설치 실행; 이진 파일이 이미 존재하면 버튼을 숨깁니다.
- 비서는 알림을 예약하고, 받은 편지함을 모니터링하고, 카메라 캡처를 트리거할 수 있도록 하트비트를 활성화 상태로 유지하세요.
- 캔버스 UI는 네이티브 오버레이와 함께 전체 화면으로 실행됩니다. 주요 컨트롤을 왼쪽 상단/오른쪽 상단/하단 가장자리에 배치하지 마세요; 레이아웃에 명시적인 여백을 추가하고 안전 구역 삽입에 의존하지 마세요.
- 브라우저 중심 확인을 위해 `openclaw browser` (탭/상태/스크린샷)와 OpenClaw에서 관리하는 Chrome 프로파일을 사용하세요.
- DOM 검사를 위해 `openclaw browser eval|query|dom|snapshot` (기계 출력이 필요할 때 `--json`/`--out` 포함) 을 사용하세요.
- 상호 작용을 위해 `openclaw browser click|type|hover|drag|select|upload|press|wait|navigate|back|evaluate|run` (click/type은 스냅샷 참조 필요; CSS 선택자의 경우 평가 사용) 을 사용하세요.