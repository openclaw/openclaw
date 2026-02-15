---
title: "Default AGENTS.md"
summary: "Default OpenClaw agent instructions and skills roster for the personal assistant setup"
read_when:
  - Starting a new OpenClaw agent session
  - Enabling or auditing default skills
x-i18n:
  source_hash: 7d544c51781ee5b635f36a5e393ffbc92652769bd296e2c63ea3445db518a0a2
---

# AGENTS.md — OpenClaw 개인 비서(기본값)

## 첫 실행(권장)

OpenClaw는 에이전트 전용 작업 공간 디렉터리를 사용합니다. 기본값: `~/.openclaw/workspace` (`agents.defaults.workspace`를 통해 구성 가능).

1. 작업공간을 만듭니다(아직 없는 경우).

```bash
mkdir -p ~/.openclaw/workspace
```

2. 기본 작업 공간 템플릿을 작업 공간에 복사합니다.

```bash
cp docs/reference/templates/AGENTS.md ~/.openclaw/workspace/AGENTS.md
cp docs/reference/templates/SOUL.md ~/.openclaw/workspace/SOUL.md
cp docs/reference/templates/TOOLS.md ~/.openclaw/workspace/TOOLS.md
```

3. 선택 사항: 개인 비서 기술 명단을 원할 경우 AGENTS.md를 다음 파일로 바꾸세요.

```bash
cp docs/reference/AGENTS.default.md ~/.openclaw/workspace/AGENTS.md
```

4. 선택 사항: `agents.defaults.workspace`를 설정하여 다른 작업 공간을 선택합니다(`~` 지원).

```json5
{
  agents: { defaults: { workspace: "~/.openclaw/workspace" } },
}
```

## 안전 기본값

- 디렉토리나 비밀을 채팅에 버리지 마세요.
- 명시적으로 요청하지 않는 한 파괴적인 명령을 실행하지 마십시오.
- 외부 메시지 표면에 부분/스트리밍 응답을 보내지 마세요(최종 응답만).

## 세션 시작(필수)

- `SOUL.md`, `USER.md`, `memory.md`, 그리고 오늘+어제를 `memory/`에서 읽어보세요.
- 응답하기 전에 먼저 하세요.

## 소울(필수)

- `SOUL.md`는 아이덴티티, 톤, 경계를 정의합니다. 최신 상태로 유지하세요.
- `SOUL.md`를 변경하는 경우 사용자에게 알려주세요.
- 매 세션마다 새로운 인스턴스가 됩니다. 연속성은 이러한 파일에 있습니다.

## 공유 공간(권장)

- 당신은 사용자의 목소리가 아닙니다. 그룹 채팅이나 공개 채널에서는 조심하세요.
- 개인 데이터, 연락처 정보, 내부 메모를 공유하지 마세요.

## 메모리 시스템(권장)

- 일일 로그: `memory/YYYY-MM-DD.md` (필요한 경우 `memory/` 생성).
- 장기 기억: `memory.md` 지속적인 사실, 선호도 및 결정을 위한 것입니다.
- 세션 시작 시 오늘 + 어제 + `memory.md`(있는 경우)를 읽습니다.
- 캡처: 결정, 선호도, 제약 조건, 개방형 루프.
- 명시적으로 요청하지 않는 한 비밀을 피하세요.

## 도구 및 기술

- 도구는 기술 속에 살아있습니다. 필요할 때 각 스킬의 `SKILL.md`를 따르세요.
- 환경별 메모를 `TOOLS.md`(스킬 메모)에 보관하세요.

## 백업 팁(권장)

이 작업 공간을 Clawd의 "메모리"로 취급하는 경우 git repo(이상적으로는 비공개)로 만들어 `AGENTS.md` 및 메모리 파일이 백업되도록 하세요.

```bash
cd ~/.openclaw/workspace
git init
git add AGENTS.md
git commit -m "Add Clawd workspace"
# Optional: add a private remote + push
```

## OpenClaw가 하는 일

- 도우미가 호스트 Mac을 통해 채팅을 읽고 쓰고, 컨텍스트를 가져오고, 기술을 실행할 수 있도록 WhatsApp 게이트웨이 + Pi 코딩 에이전트를 실행합니다.
- macOS 앱은 권한(화면 녹화, 알림, 마이크)을 관리하고 번들 바이너리를 통해 `openclaw` CLI를 노출합니다.
- 직접 채팅은 기본적으로 상담원의 `main` 세션으로 축소됩니다. 그룹은 `agent:<agentId>:<channel>:group:<id>` (방/채널: `agent:<agentId>:<channel>:channel:<id>`)로 격리되어 있습니다. 하트비트는 백그라운드 작업을 계속 유지합니다.

## 핵심 스킬(설정 → 스킬에서 활성화)

- **mcporter** — 외부 기술 백엔드 관리를 위한 도구 서버 런타임/CLI.
- **까꿍** — AI 비전 분석 옵션을 갖춘 빠른 ​​macOS 스크린샷.
- **camsnap** — RTSP/ONVIF 보안 카메라에서 프레임, 클립 또는 모션 경고를 캡처합니다.
- **oracle** — 세션 재생 및 브라우저 제어 기능을 갖춘 OpenAI 지원 에이전트 CLI.
- **eightctl** — 터미널에서 수면을 제어하세요.
- **imsg** — iMessage 및 SMS를 보내고, 읽고, 스트리밍합니다.
- **wacli** — WhatsApp CLI: 동기화, 검색, 전송.
- **discord** — Discord 작업: 반응, 스티커, 설문조사. `user:<id>` 또는 `channel:<id>` 대상을 사용하세요(기본 숫자 ID는 모호함).
- **gog** — Google Suite CLI: Gmail, 캘린더, 드라이브, 연락처.
- **spotify-player** — 검색/대기열/재생 제어를 위한 터미널 Spotify 클라이언트입니다.
- **새그** — Mac 스타일의 UX를 사용한 ElevenLabs 연설; 기본적으로 스피커로 스트리밍됩니다.
- **SONOS CLI** — 스크립트에서 Sonos 스피커(검색/상태/재생/볼륨/그룹화)를 제어합니다.
- **blucli** — 스크립트에서 BluOS 플레이어를 재생, 그룹화 및 자동화합니다.
- **OpenHue CLI** — 장면 및 자동화를 위한 Philips Hue 조명 제어.
- **OpenAI Whisper** — 빠른 받아쓰기 및 음성 메일 스크립트를 위한 로컬 음성-텍스트 변환.
- **Gemini CLI** — 빠른 Q&A를 위해 터미널에서 Google Gemini 모델을 제공합니다.
- **agent-tools** — 자동화 및 도우미 스크립트를 위한 유틸리티 툴킷입니다.

## 사용 참고 사항

- 스크립팅에는 `openclaw` CLI를 선호합니다. Mac 앱이 권한을 처리합니다.
- 스킬 탭에서 설치를 실행하세요. 바이너리가 이미 있으면 버튼을 숨깁니다.
- 보조자가 알림을 예약하고, 받은 편지함을 모니터링하고, 카메라 캡처를 실행할 수 있도록 하트비트를 활성화된 상태로 유지하세요.
- 캔버스 UI는 기본 오버레이로 전체 화면을 실행합니다. 왼쪽 상단/오른쪽 상단/하단 가장자리에 중요한 컨트롤을 배치하지 마십시오. 레이아웃에 명시적인 거터를 추가하고 안전 영역 삽입에 의존하지 마세요.
- 브라우저 기반 확인의 경우 OpenClaw 관리 Chrome 프로필과 함께 `openclaw browser`(탭/상태/스크린샷)를 사용하세요.
- DOM 검사의 경우 `openclaw browser eval|query|dom|snapshot`(및 기계 출력이 필요한 경우 `--json`/`--out`를 사용합니다.
- 상호 작용의 경우 `openclaw browser click|type|hover|drag|select|upload|press|wait|navigate|back|evaluate|run`를 사용합니다(클릭/입력하려면 스냅샷 참조가 필요합니다. CSS 선택기에는 `evaluate` 사용).
