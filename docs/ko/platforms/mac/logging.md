---
summary: "OpenClaw 로깅: 순환 진단 파일 로그 + 통합 로그 개인정보 플래그"
read_when:
  - macOS 로그를 캡처하거나 개인정보 데이터 로깅을 조사할 때
  - 음성 웨이크/세션 라이프사이클 문제를 디버깅할 때
title: "macOS 로깅"
---

# 로깅 (macOS)

## 순환 진단 파일 로그 (디버그 패널)

OpenClaw 는 macOS 앱 로그를 swift-log (기본값은 통합 로깅) 를 통해 라우팅하며, 내구성 있는 캡처가 필요할 때 로컬에서 순환되는 파일 로그를 디스크에 기록할 수 있습니다.

- Verbosity: **Debug pane → Logs → App logging → Verbosity**
- 활성화: **Debug pane → Logs → App logging → “Write rolling diagnostics log (JSONL)”**
- 위치: `~/Library/Logs/OpenClaw/diagnostics.jsonl` (자동으로 순환되며, 이전 파일은 `.1`, `.2`, … 와 같이 접미사가 붙습니다)
- 삭제: **Debug pane → Logs → App logging → “Clear”**

참고:

- 기본값은 **비활성화**입니다. 실제로 디버깅 중일 때만 활성화하십시오.
- 파일에는 민감한 정보가 포함될 수 있으므로, 검토 없이 공유하지 마십시오.

## macOS 의 통합 로깅 개인정보 데이터

통합 로깅은 서브시스템이 `privacy -off` 에 옵트인하지 않는 한 대부분의 페이로드를 마스킹합니다. Peter 의 macOS [logging privacy shenanigans](https://steipete.me/posts/2025/logging-privacy-shenanigans) (2025) 글에 따르면, 이는 `/Library/Preferences/Logging/Subsystems/` 에 있는 plist 로 제어되며 서브시스템 이름을 키로 사용합니다. 새로운 로그 항목만 이 플래그를 적용하므로, 문제를 재현하기 전에 활성화해야 합니다.

## OpenClaw 에 대해 활성화 (`bot.molt`)

- 먼저 plist 를 임시 파일로 작성한 다음, root 권한으로 원자적으로 설치하십시오:

```bash
cat <<'EOF' >/tmp/bot.molt.plist
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
sudo install -m 644 -o root -g wheel /tmp/bot.molt.plist /Library/Preferences/Logging/Subsystems/bot.molt.plist
```

- 재부팅은 필요하지 않습니다. logd 가 파일을 빠르게 인식하지만, 새로운 로그 라인만 개인정보 페이로드를 포함합니다.
- 기존 헬퍼를 사용하여 더 풍부한 출력을 확인할 수 있습니다. 예: `./scripts/clawlog.sh --category WebChat --last 5m`.

## 디버깅 후 비활성화

- 오버라이드를 제거하십시오: `sudo rm /Library/Preferences/Logging/Subsystems/bot.molt.plist`.
- 필요하다면 `sudo log config --reload` 를 실행하여 logd 가 즉시 오버라이드를 해제하도록 할 수 있습니다.
- 이 표면에는 전화번호와 메시지 본문이 포함될 수 있음을 기억하십시오. 추가 세부 정보가 실제로 필요한 동안에만 plist 를 유지하십시오.
