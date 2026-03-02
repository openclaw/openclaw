---
summary: "OpenClaw 로깅: 롤링 진단 파일 로그 + 통합 로그 개인 정보 플래그"
read_when:
  - macOS 로그를 캡처하거나 개인 데이터 로깅을 조사할 때
  - 음성 웨이크/세션 라이프사이클 문제를 디버깅할 때
title: "macOS 로깅"
x-i18n:
  generated_at: "2026-03-02T00:00:00Z"
  model: "claude-opus-4-6"
  provider: "pi"
  source_path: "docs/platforms/mac/logging.md"
  workflow: 15
---

# 로깅 (macOS)

## 롤링 진단 파일 로그 (Debug 창)

OpenClaw는 macOS 앱 로그를 swift-log (기본적으로 통합 로깅)를 통해 라우트하며, 지속적인 캡처가 필요할 때 디스크에 로컬, 회전하는 파일 로그를 쓸 수 있습니다.

- 상세 정도: **Debug 창 → Logs → App logging → Verbosity**
- 활성화: **Debug 창 → Logs → App logging → "Write rolling diagnostics log (JSONL)"**
- 위치: `~/Library/Logs/OpenClaw/diagnostics.jsonl` (자동으로 회전함. 이전 파일은 `.1`, `.2`, … 접미사가 붙음)
- 지우기: **Debug 창 → Logs → App logging → "Clear"**

참고:

- 이것은 **기본적으로 꺼져 있습니다**. 활발히 디버깅할 때만 활성화합니다.
- 파일을 민감하게 취급합니다. 검토 없이 공유하지 마십시오.

## macOS의 통합 로깅 개인 데이터

통합 로깅은 서브시스템이 `privacy -off`로 옵트인하지 않으면 대부분의 페이로드를 редд삭합니다. Peter의 macOS [로깅 개인 정보 보안 문제](https://steipete.me/posts/2025/logging-privacy-shenanigans) (2025)에 대한 글씨에 따르면, 이것은 `/Library/Preferences/Logging/Subsystems/`의 plist에 의해 제어되며, 서브시스템 이름으로 키됩니다. 새 로그 항목만 플래그를 선택하므로 문제를 재현하기 전에 활성화합니다.

## OpenClaw에 대해 활성화 (`ai.openclaw`)

- 먼저 plist를 임시 파일에 작성한 후, 원자적으로 루트로 설치합니다:

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

- 재부팅이 필요하지 않습니다. logd는 파일을 빠르게 인식하지만, 새 로그 라인만 개인 페이로드를 포함합니다.
- 기존 도우미로 더 풍부한 출력을 봅니다 (예: `./scripts/clawlog.sh --category WebChat --last 5m`).

## 디버깅 후 비활성화

- 재정의를 제거합니다: `sudo rm /Library/Preferences/Logging/Subsystems/ai.openclaw.plist`.
- 선택적으로 `sudo log config --reload`를 실행하여 logd가 재정의를 즉시 삭제하도록 강제합니다.
- 이 표면에는 전화 번호와 메시지 본문이 포함될 수 있습니다. 추가 세부 정보가 활발히 필요할 때만 plist를 제자리에 유지합니다.
