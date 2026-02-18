---
summary: "OpenClaw 로깅: 순환 진단 파일 로그 + 통합 로그 개인정보 보호 플래그"
read_when:
  - macOS 로그를 캡처하거나 개인 데이터 로깅을 조사할 때
  - 음성 호출/세션 라이프사이클 문제를 디버깅할 때
title: "macOS 로깅"
---

# 로깅 (macOS)

## 순환 진단 파일 로그 (디버그 창)

OpenClaw는 macOS 앱 로그를 swift-log(기본적으로 통합 로깅)를 통해 라우팅하며, 내구성 있는 캡처가 필요할 때 로컬 순환 파일 로그를 디스크에 쓸 수 있습니다.

- 상세 설정: **디버그 창 → 로그 → 앱 로깅 → 상세 설정**
- 활성화: **디버그 창 → 로그 → 앱 로깅 → “순환 진단 로그 쓰기 (JSONL)”**
- 위치: `~/Library/Logs/OpenClaw/diagnostics.jsonl` (자동으로 순환되며, 이전 파일은 `.1`, `.2`, …와 같이 접미사로 표시됨)
- 삭제: **디버그 창 → 로그 → 앱 로깅 → “삭제”**

주의사항:

- 기본적으로 **비활성화**되어 있습니다. 적극적으로 디버깅할 때만 활성화하십시오.
- 이 파일은 민감하게 취급하십시오. 검토 없이 공유하지 마세요.

## macOS의 통합 로깅 개인 데이터

통합 로깅은 대부분의 페이로드를 적출합니다. 특정 하위 시스템이 `privacy -off`를 선택하지 않는 한. Peter의 macOS [로깅 개인정보 장난질](https://steipete.me/posts/2025/logging-privacy-shenanigans) (2025)에 의하면 이는 하위 시스템 이름으로 키된 `/Library/Preferences/Logging/Subsystems/`에 있는 plist에 의해 제어됩니다. 새로운 로그 항목만 플래그를 픽업하므로 문제 재현 전에 활성화하세요.

## OpenClaw (`bot.molt`)에 대해 활성화

- 먼저 plist를 임시 파일에 작성한 다음 루트로 원자적으로 설치합니다:

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

- 재부팅은 필요하지 않으며, logd가 파일을 빠르게 인식하지만 새로운 로그 줄만 개인 페이로드를 포함합니다.
- 기존의 도우미를 사용하여 더 풍부한 출력을 확인하세요. 예: `./scripts/clawlog.sh --category WebChat --last 5m`.

## 디버깅 후 비활성화

- 오버라이드를 제거합니다: `sudo rm /Library/Preferences/Logging/Subsystems/bot.molt.plist`.
- 선택적으로 `sudo log config --reload`를 실행하여 logd가 오버라이드를 즉시 제거하도록 할 수 있습니다.
- 이 표면에는 전화번호와 메시지 본문이 포함될 수 있으므로, 추가 정보가 필요할 때만 plist를 유지하십시오.
