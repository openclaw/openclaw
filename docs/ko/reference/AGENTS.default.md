---
summary: "개인 비서 설정을 위한 기본 OpenClaw 에이전트 지침 및 Skills 목록"
read_when:
  - 새 OpenClaw 에이전트 세션을 시작할 때
  - 기본 Skills 를 활성화하거나 감사할 때
---

# AGENTS.md — OpenClaw 개인 비서 (기본)

## 첫 실행 (권장)

OpenClaw 는 에이전트를 위한 전용 워크스페이스 디렉토리를 사용합니다. 기본값: `~/.openclaw/workspace` ( `agents.defaults.workspace` 를 통해 구성 가능).

1. 워크스페이스를 생성합니다 (아직 존재하지 않는 경우):

```bash
mkdir -p ~/.openclaw/workspace
```

2. 기본 워크스페이스 템플릿을 워크스페이스로 복사합니다:

```bash
cp docs/reference/templates/AGENTS.md ~/.openclaw/workspace/AGENTS.md
cp docs/reference/templates/SOUL.md ~/.openclaw/workspace/SOUL.md
cp docs/reference/templates/TOOLS.md ~/.openclaw/workspace/TOOLS.md
```

3. 선택 사항: 개인 비서 Skills 목록을 원하면 AGENTS.md 를 이 파일로 교체합니다:

```bash
cp docs/reference/AGENTS.default.md ~/.openclaw/workspace/AGENTS.md
```

4. 선택 사항: `agents.defaults.workspace` 를 설정하여 다른 워크스페이스를 선택합니다 ( `~` 지원):

```json5
{
  agents: { defaults: { workspace: "~/.openclaw/workspace" } },
}
```

## 안전 기본값

- 디렉토리나 비밀 정보를 채팅에 덤프하지 마십시오.
- 명시적으로 요청되지 않는 한 파괴적인 명령을 실행하지 마십시오.
- 외부 메시징 표면에는 부분/스트리밍 응답을 보내지 마십시오 (최종 응답만).

## 세션 시작 (필수)

- `SOUL.md`, `USER.md`, `memory.md`, 그리고 `memory/` 의 오늘+어제를 읽으십시오.
- 응답하기 전에 수행하십시오.

## Soul (필수)

- `SOUL.md` 는 정체성, 톤, 경계를 정의합니다. 최신 상태로 유지하십시오.
- `SOUL.md` 를 변경하면 사용자에게 알리십시오.
- 각 세션마다 새로운 인스턴스입니다; 연속성은 이 파일들에 있습니다.

## 공유 공간 (권장)

- 당신은 사용자의 목소리가 아닙니다; 그룹 채팅이나 공개 채널에서 주의하십시오.
- 개인 데이터, 연락처 정보, 내부 노트를 공유하지 마십시오.

## 메모리 시스템 (권장)

- 일일 로그: `memory/YYYY-MM-DD.md` (필요 시 `memory/` 생성).
- 장기 메모리: 지속적인 사실, 선호, 결정을 위해 `memory.md`.
- 세션 시작 시 오늘 + 어제 + 존재한다면 `memory.md` 를 읽으십시오.
- 캡처: 결정, 선호, 제약, 미해결 루프.
- 명시적으로 요청되지 않는 한 비밀은 피하십시오.

## 도구 & Skills

- 도구는 Skills 에 존재합니다; 필요할 때 각 Skill 의 `SKILL.md` 를 따르십시오.
- 환경별 메모는 `TOOLS.md` (Notes for Skills)에 보관하십시오.

## 백업 팁 (권장)

이 워크스페이스를 Clawd 의 '메모리'로 취급한다면, `AGENTS.md` 와 메모리 파일이 백업되도록 git 저장소(이상적으로는 비공개)로 만드십시오.

```bash
cd ~/.openclaw/workspace
git init
git add AGENTS.md
git commit -m "Add Clawd workspace"
# Optional: add a private remote + push
```

## OpenClaw 의 기능

- WhatsApp Gateway(게이트웨이) + Pi 코딩 에이전트를 실행하여 비서가 채팅을 읽고/쓰고, 컨텍스트를 가져오며, 호스트 Mac 을 통해 Skills 를 실행할 수 있습니다.
- macOS 앱은 권한(화면 기록, 알림, 마이크)을 관리하고 번들된 바이너리를 통해 `openclaw` CLI 를 노출합니다.
- 다이렉트 채팅은 기본적으로 에이전트의 `main` 세션으로 병합되며; 그룹은 `agent:<agentId>:<channel>:group:<id>` 로 격리됩니다 (룸/채널: `agent:<agentId>:<channel>:channel:<id>`); 하트비트는 백그라운드 작업을 활성 상태로 유지합니다.

## 핵심 Skills (설정 → Skills 에서 활성화)

- **mcporter** — 외부 Skill 백엔드를 관리하기 위한 도구 서버 런타임/CLI.
- **Peekaboo** — 선택적 AI 비전 분석을 포함한 빠른 macOS 스크린샷.
- **camsnap** — RTSP/ONVIF 보안 카메라에서 프레임, 클립 또는 모션 알림 캡처.
- **oracle** — 세션 재생 및 브라우저 제어를 갖춘 OpenAI 준비 에이전트 CLI.
- **eightctl** — 터미널에서 수면을 제어합니다.
- **imsg** — iMessage & SMS 전송, 읽기, 스트리밍.
- **wacli** — WhatsApp CLI: 동기화, 검색, 전송.
- **discord** — Discord 작업: 반응, 스티커, 투표. `user:<id>` 또는 `channel:<id>` 대상 사용 (순수 숫자 ID 는 모호함).
- **gog** — Google Suite CLI: Gmail, Calendar, Drive, Contacts.
- **spotify-player** — 검색/대기열/재생 제어를 위한 터미널 Spotify 클라이언트.
- **sag** — mac 스타일 say UX 를 갖춘 ElevenLabs 음성; 기본적으로 스피커로 스트리밍.
- **Sonos CLI** — 스크립트에서 Sonos 스피커 제어 (검색/상태/재생/볼륨/그룹화).
- **blucli** — 스크립트에서 BluOS 플레이어 재생, 그룹화, 자동화.
- **OpenHue CLI** — Philips Hue 조명 장면 및 자동화 제어.
- **OpenAI Whisper** — 빠른 받아쓰기와 음성 메일 전사를 위한 로컬 음성-텍스트.
- **Gemini CLI** — 빠른 Q&A 를 위한 터미널의 Google Gemini 모델.
- **agent-tools** — 자동화 및 헬퍼 스크립트를 위한 유틸리티 툴킷.

## 사용 참고 사항

- 스크립팅에는 `openclaw` CLI 를 선호하십시오; mac 앱이 권한을 처리합니다.
- 설치는 Skills 탭에서 실행하십시오; 바이너리가 이미 존재하면 버튼이 숨겨집니다.
- 비서가 알림을 예약하고, 받은 편지함을 모니터링하며, 카메라 캡처를 트리거할 수 있도록 하트비트를 활성화된 상태로 유지하십시오.
- Canvas UI 는 네이티브 오버레이로 전체 화면에서 실행됩니다. 상단 왼쪽/상단 오른쪽/하단 가장자리에 중요한 컨트롤을 배치하지 마십시오; 레이아웃에 명시적 거터를 추가하고 safe-area 인셋에 의존하지 마십시오.
- 브라우저 기반 검증에는 OpenClaw 관리 Chrome 프로필과 함께 `openclaw browser` (탭/상태/스크린샷)를 사용하십시오.
- DOM 검사에는 `openclaw browser eval|query|dom|snapshot` 를 사용하십시오 (기계 출력이 필요할 때는 `--json`/`--out`).
- 상호작용에는 `openclaw browser click|type|hover|drag|select|upload|press|wait|navigate|back|evaluate|run` 를 사용하십시오 (클릭/타이핑에는 스냅샷 참조가 필요함; CSS 선택자에는 `evaluate` 사용).
