---
summary: "슬래시 명령어 전체 목록"
read_when:
  - 채팅 명령어를 알고 싶을 때
title: "슬래시 명령어"
---

# 슬래시 명령어

채팅에서 사용할 수 있는 명령어 목록입니다.

## 세션 관리

| 명령어     | 설명                        |
| ---------- | --------------------------- |
| `/reset`   | 현재 세션 초기화            |
| `/new`     | 새 세션 시작 (reset과 동일) |
| `/compact` | 컨텍스트 압축               |
| `/history` | 대화 히스토리 보기          |
| `/export`  | 세션 내보내기               |

## 모델 및 에이전트

| 명령어           | 설명           |
| ---------------- | -------------- |
| `/model <model>` | 모델 변경      |
| `/agent <id>`    | 에이전트 전환  |
| `/think <level>` | 사고 레벨 변경 |
| `/status`        | 현재 상태 표시 |

### 예시

```
/model anthropic/claude-sonnet-4-20250514
/think high
/agent coder
```

## 도구 제어

| 명령어                 | 설명          |
| ---------------------- | ------------- |
| `/tool enable <tool>`  | 도구 활성화   |
| `/tool disable <tool>` | 도구 비활성화 |
| `/tool list`           | 도구 목록     |

## 스킬

| 명령어                   | 설명          |
| ------------------------ | ------------- |
| `/skill enable <skill>`  | 스킬 활성화   |
| `/skill disable <skill>` | 스킬 비활성화 |
| `/skill list`            | 스킬 목록     |

## 메모리

| 명령어                   | 설명            |
| ------------------------ | --------------- |
| `/memory`                | 메모리 상태     |
| `/memory search <query>` | 메모리 검색     |
| `/memory clear`          | 메모리 초기화   |
| `/remember <text>`       | 메모리에 저장   |
| `/forget <text>`         | 메모리에서 삭제 |

## Canvas

| 명령어               | 설명          |
| -------------------- | ------------- |
| `/canvas start`      | Canvas 시작   |
| `/canvas stop`       | Canvas 중지   |
| `/canvas screenshot` | 스크린샷 캡처 |

## 하트비트

| 명령어                        | 설명              |
| ----------------------------- | ----------------- |
| `/heartbeat pause <duration>` | 하트비트 일시정지 |
| `/heartbeat resume`           | 하트비트 재개     |
| `/heartbeat status`           | 하트비트 상태     |

## 사용량

| 명령어          | 설명             |
| --------------- | ---------------- |
| `/usage`        | 사용량 표시 토글 |
| `/usage tokens` | 토큰만 표시      |
| `/usage full`   | 전체 표시        |
| `/usage off`    | 표시 안 함       |

## 디버그

| 명령어           | 설명               |
| ---------------- | ------------------ |
| `/verbose on`    | 상세 모드 켜기     |
| `/verbose off`   | 상세 모드 끄기     |
| `/debug prompt`  | 현재 프롬프트 표시 |
| `/debug session` | 세션 정보 표시     |

## 미디어

| 명령어     | 설명           |
| ---------- | -------------- |
| `/voice`   | 음성 응답 토글 |
| `/tts on`  | TTS 켜기       |
| `/tts off` | TTS 끄기       |

## 기타

| 명령어     | 설명             |
| ---------- | ---------------- |
| `/help`    | 도움말 표시      |
| `/version` | 버전 정보        |
| `/ping`    | 연결 확인        |
| `/whoami`  | 현재 사용자 정보 |

## 커스텀 명령어

### 정의

```json5
{
  commands: {
    custom: [
      {
        name: "report",
        prompt: "오늘의 작업 보고서를 작성해줘",
      },
      {
        name: "standup",
        prompt: "스탠드업 미팅 준비를 도와줘",
      },
    ],
  },
}
```

### 사용

```
/report
/standup
```

## 채널별 지원

| 명령어    | Telegram | WhatsApp | Discord | Slack |
| --------- | -------- | -------- | ------- | ----- |
| `/reset`  | ✅       | ✅       | ✅      | ✅    |
| `/model`  | ✅       | ✅       | ✅      | ✅    |
| `/canvas` | ❌       | ❌       | ❌      | ❌    |
| `/voice`  | ✅       | ✅       | ✅      | ❌    |

> Canvas, Voice 등 일부 기능은 노드 앱에서만 사용 가능
