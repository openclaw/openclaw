---
read_when:
    - 새로운 OpenClaw 에이전트 세션 시작
    - 기본 기술 활성화 또는 감사
summary: 개인 비서 설정을 위한 기본 OpenClaw 에이전트 지침 및 기술 목록
x-i18n:
    generated_at: "2026-02-08T16:03:21Z"
    model: gtx
    provider: google-translate
    source_hash: 6cbde95d29e80cbbba1a66082d31ee6e5a0f3c3e425a9a10c428dfffb67bb8b1
    source_path: reference/AGENTS.default.md
    workflow: 15
---

# AGENTS.md — OpenClaw 개인 비서(기본값)

## 첫 실행(권장)

OpenClaw는 에이전트 전용 작업 공간 디렉터리를 사용합니다. 기본: `~/.openclaw/workspace` (다음을 통해 구성 가능 `agents.defaults.workspace`).

1. 작업공간을 만듭니다(아직 없는 경우).

```bash
mkdir -p ~/.openclaw/workspace
```

2. 기본 작업공간 템플릿을 작업공간에 복사합니다.

```bash
cp docs/reference/templates/AGENTS.md ~/.openclaw/workspace/AGENTS.md
cp docs/reference/templates/SOUL.md ~/.openclaw/workspace/SOUL.md
cp docs/reference/templates/TOOLS.md ~/.openclaw/workspace/TOOLS.md
```

3. 선택 사항: 개인 비서 기술 명단을 원할 경우 AGENTS.md를 다음 파일로 바꾸세요.

```bash
cp docs/reference/AGENTS.default.md ~/.openclaw/workspace/AGENTS.md
```

4. 선택사항: 설정을 통해 다른 작업공간을 선택하세요. `agents.defaults.workspace` (지원 `~`):

```json5
{
  agents: { defaults: { workspace: "~/.openclaw/workspace" } },
}
```

## 안전 기본값

- 디렉터리나 비밀을 채팅에 버리지 마세요.
- 명시적으로 요청하지 않는 한 파괴적인 명령을 실행하지 마십시오.
- 외부 메시지 표면에 부분/스트리밍 응답을 보내지 마세요(최종 응답만).

## 세션 시작(필수)

- 읽다 `SOUL.md`, `USER.md`, `memory.md`, 그리고 오늘+어제 `memory/`.
- 응답하기 전에 수행하십시오.

## 영혼 (필수)

- `SOUL.md` 정체성, 어조, 경계를 정의합니다. 최신 상태로 유지하세요.
- 당신이 변경하는 경우 `SOUL.md`, 사용자에게 알립니다.
- 당신은 매 세션마다 새로운 인스턴스입니다. 연속성은 이러한 파일에 있습니다.

## 공유 공간(권장)

- 당신은 사용자의 목소리가 아닙니다. 그룹 채팅이나 공개 채널에서는 조심하세요.
- 개인 데이터, 연락처 정보, 내부 메모를 공유하지 마세요.

## 메모리 시스템(권장)

- 일일 로그: `memory/YYYY-MM-DD.md` (만들다 `memory/` 필요한 경우).
- 장기 기억: `memory.md` 지속적인 사실, 선호도 및 결정을 위해.
- 세션 시작 시 오늘 + 어제 + 읽기 `memory.md` 존재하는 경우.
- 캡처: 결정, 선호도, 제약 조건, 개방형 루프.
- 명시적으로 요청하지 않는 한 비밀을 피하세요.

## 도구 및 기술

- 도구는 기술 속에 살아있습니다. 각 스킬을 따라가세요 `SKILL.md` 필요할 때.
- 환경별 메모를 보관하세요. `TOOLS.md` (스킬 참고사항)

## 백업 팁(권장)

이 작업 공간을 Clawd의 "기억"으로 취급한다면 git repo(이상적으로는 비공개)로 만들어서 `AGENTS.md` 메모리 파일이 백업됩니다.

```bash
cd ~/.openclaw/workspace
git init
git add AGENTS.md
git commit -m "Add Clawd workspace"
# Optional: add a private remote + push
```

## OpenClaw가 하는 일

- 도우미가 호스트 Mac을 통해 채팅을 읽고 쓰고, 컨텍스트를 가져오고, 기술을 실행할 수 있도록 WhatsApp 게이트웨이 + Pi 코딩 에이전트를 실행합니다.
- macOS 앱은 권한(화면 녹화, 알림, 마이크)을 관리하고 `openclaw` 번들 바이너리를 통한 CLI.
- 직접 채팅은 상담원의 채팅으로 축소됩니다. `main` 기본적으로 세션; 그룹은 다음과 같이 격리됩니다. `agent:<agentId>:<channel>:group:<id>` (방/채널: `agent:<agentId>:<channel>:channel:<id>`); 하트비트는 백그라운드 작업을 계속 유지합니다.

## 핵심 스킬(설정 → 스킬에서 활성화)

- **맥포터** — 외부 기술 백엔드 관리를 위한 도구 서버 런타임/CLI.
- **깍꿍** — AI 비전 분석 옵션이 포함된 빠른 macOS 스크린샷.
- **캠스냅** — RTSP/ONVIF 보안 카메라에서 프레임, 클립 또는 모션 경고를 캡처합니다.
- **신탁** — 세션 재생 및 브라우저 제어 기능을 갖춘 OpenAI 지원 에이전트 CLI.
- **8ctl** — 터미널에서 수면을 제어하세요.
- **imsg** — iMessage 및 SMS를 보내고, 읽고, 스트리밍합니다.
- **와클리** — WhatsApp CLI: 동기화, 검색, 전송.
- **불화** — Discord 작업: 반응, 스티커, 설문 조사. 사용 `user:<id>` 또는 `channel:<id>` 대상(숫자 ID가 모호함).
- **곡** — Google Suite CLI: Gmail, 캘린더, 드라이브, 연락처.
- **Spotify 플레이어** — 검색/대기열/재생 제어를 위한 터미널 Spotify 클라이언트.
- **처짐** — Mac 스타일의 ElevenLabs 연설은 UX를 말합니다. 기본적으로 스피커로 스트리밍됩니다.
- **소노스 CLI** — 스크립트에서 Sonos 스피커(검색/상태/재생/볼륨/그룹화)를 제어합니다.
- **블루클리** — 스크립트에서 BluOS 플레이어를 재생, 그룹화 및 자동화합니다.
- **오픈휴 CLI** — 장면 및 자동화를 위한 Philips Hue 조명 제어.
- **OpenAI 속삭임** — 빠른 받아쓰기 및 음성 메일 기록을 위한 로컬 음성-텍스트 변환.
- **제미니 CLI** — 빠른 Q&A를 위해 터미널에서 Google Gemini 모델을 사용합니다.
- **에이전트 도구** — 자동화 및 도우미 스크립트를 위한 유틸리티 툴킷입니다.

## 사용법 참고 사항

- 선호 `openclaw` 스크립팅을 위한 CLI; Mac 앱이 권한을 처리합니다.
- 기술 탭에서 설치를 실행하세요. 바이너리가 이미 있으면 버튼을 숨깁니다.
- 보조자가 알림을 예약하고, 받은 편지함을 모니터링하고, 카메라 캡처를 실행할 수 있도록 하트비트를 활성화된 상태로 유지하세요.
- 캔버스 UI는 기본 오버레이를 사용하여 전체 화면으로 실행됩니다. 왼쪽 상단/오른쪽 상단/하단 가장자리에 중요한 컨트롤을 배치하지 마십시오. 레이아웃에 명시적인 거터를 추가하고 안전 영역 삽입에 의존하지 마세요.
- 브라우저 기반 확인의 경우 다음을 사용하십시오. `openclaw browser` (탭/상태/스크린샷)을 OpenClaw 관리 Chrome 프로필로 변경하세요.
- DOM 검사의 경우 다음을 사용하세요. `openclaw browser eval|query|dom|snapshot` (그리고 `--json`/`--out` 기계 출력이 필요할 때).
- 상호 작용의 경우 다음을 사용하십시오. `openclaw browser click|type|hover|drag|select|upload|press|wait|navigate|back|evaluate|run` (클릭/입력하려면 스냅샷 참조가 필요합니다. `evaluate` CSS 선택기의 경우).
