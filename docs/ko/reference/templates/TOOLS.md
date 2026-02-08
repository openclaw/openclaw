---
read_when:
    - 작업공간을 수동으로 부트스트래핑
summary: TOOLS.md용 작업 공간 템플릿
x-i18n:
    generated_at: "2026-02-08T16:02:21Z"
    model: gtx
    provider: google-translate
    source_hash: 3ed08cd537620749c40ab363f5db40a058d8ddab4d0192a1f071edbfcf37a739
    source_path: reference/templates/TOOLS.md
    workflow: 15
---

# TOOLS.md - 로컬 메모

기술이 정의합니다 _어떻게_ 도구가 작동합니다. 이 파일은 _당신의_ 세부 사항 - 설정에 고유한 항목입니다.

## 여기에 무엇이 들어가나요?

다음과 같은 것:

- 카메라 이름 및 위치
- SSH 호스트 및 별칭
- TTS에 선호되는 음성
- 발표자/회의실 이름
- 기기 닉네임
- 환경에 따른 모든 것

## 예

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

## 왜 분리해야 합니까?

기술은 공유됩니다. 귀하의 설정은 귀하의 것입니다. 이를 별도로 유지한다는 것은 메모를 잃지 않고 기술을 업데이트하고 인프라 유출 없이 기술을 공유할 수 있음을 의미합니다.

---

업무 수행에 도움이 되는 것은 무엇이든 추가하세요. 이것은 치트 시트입니다.
