---
summary: "OpenClaw 로깅: 롤링 진단 파일 로그 + 통합 로그 개인 정보 플래그"
read_when:
  - macOS 로그를 캡처하거나 개인 데이터 로깅을 조사할 때
  - 음성 웨이크/세션 라이프사이클 문제를 디버깅할 때
title: "macOS 로깅"
x-i18n:
  source_path: docs/platforms/mac/logging.md
---

# 로깅 (macOS)

## 롤링 진단 파일 로그 (디버그 패인)

OpenClaw 은 macOS 앱 로그를 swift-log (기본적으로 통합 로깅) 를 통해 라우팅하며, 지속적인 캡처가 필요할 때 디스크에 로컬 회전 파일 로그를 작성할 수 있습니다.

- 상세도: **디버그 패인 → 로그 → 앱 로깅 → 상세도**
- 활성화: **디버그 패인 → 로그 → 앱 로깅 → "롤링 진단 로그 (JSONL) 작성"**
- 위치: `~/Library/Logs/OpenClaw/diagnostics.jsonl` (자동 회전; 이전 파일은 `.1`, `.2`, ... 접미사가 붙음)
- 지우기: **디버그 패인 → 로그 → 앱 로깅 → "지우기"**

참고:

- 이 기능은 **기본적으로 꺼져** 있습니다. 적극적으로 디버깅할 때만 활성화하세요.
- 파일을 민감한 것으로 취급하세요; 검토 없이 공유하지 마세요.

## macOS 에서 통합 로깅 개인 데이터

통합 로깅은 서브시스템이 `privacy -off` 를 선택하지 않는 한 대부분의 페이로드를 편집합니다. macOS [로깅 프라이버시 문제](https://steipete.me/posts/2025/logging-privacy-shenanigans) (2025) 에 대한 Peter 의 글에 따르면, 이는 서브시스템 이름으로 키가 지정된 `/Library/Preferences/Logging/Subsystems/` 의 plist 로 제어됩니다. 새 로그 항목만 플래그를 적용하므로, 문제를 재현하기 전에 활성화하세요.

## OpenClaw (`ai.openclaw`) 에 대해 활성화

- 먼저 plist 를 임시 파일에 작성한 다음, 루트로 원자적으로 설치합니다:

```bash
cat <<'EOF' >/tmp/ai.openclaw.plist
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>DEFAULT-OPTIONS</key>
    <dict>
        <key>Enable-Private-Data</key>
        <true/>
    </dict>
</dict>
</plist>
EOF
sudo install -m 644 -o root -g wheel /tmp/ai.openclaw.plist /Library/Preferences/Logging/Subsystems/ai.openclaw.plist
```

- 재부팅이 필요하지 않습니다; logd 가 파일을 빠르게 감지하지만, 새 로그 줄만 개인 페이로드를 포함합니다.
- 기존 헬퍼로 더 풍부한 출력을 확인합니다, 예: `./scripts/clawlog.sh --category WebChat --last 5m`.

## 디버깅 후 비활성화

- 오버라이드 제거: `sudo rm /Library/Preferences/Logging/Subsystems/ai.openclaw.plist`.
- 선택적으로 `sudo log config --reload` 를 실행하여 logd 가 오버라이드를 즉시 제거하도록 강제합니다.
- 이 영역에는 전화번호와 메시지 본문이 포함될 수 있습니다; 추가 세부 정보가 적극적으로 필요한 동안만 plist 를 유지하세요.
