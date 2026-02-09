---
summary: "TOOLS.md 를 위한 워크스페이스 템플릿"
read_when:
  - 워크스페이스를 수동으로 부트스트래핑할 때
---

# TOOLS.md - 로컬 노트

Skills 는 도구가 _어떻게_ 동작하는지를 정의합니다. 이 파일은 _당신_ 의 구체적인 사항 — 즉, 당신의 설정에만 고유한 것들을 위한 공간입니다.

## 23. 여기에 들어갈 것

24. 다음과 같은 것들:

- 카메라 이름과 위치
- SSH 호스트와 별칭
- TTS 를 위한 선호 음성
- 스피커 / 방 이름
- 디바이스 별명
- 환경에 특화된 모든 것

## 예제

```markdown
### Cameras

- living-room → Main area, 180° wide angle
- front-door → Entrance, motion-triggered

### SSH

- home-server → 192.168.1.100, user: admin

### TTS

- Preferred voice: "Nova" (warm, slightly British)
- Default speaker: Kitchen HomePod
```

## 분리하는 이유

Skills 는 공유됩니다. 당신의 설정은 당신의 것입니다. 이를 분리해 두면 노트를 잃지 않고 Skills 를 업데이트할 수 있고, 인프라를 노출하지 않고 Skills 를 공유할 수 있습니다.

---

업무에 도움이 되는 무엇이든 추가하십시오. 이 파일은 당신만의 치트 시트입니다.
