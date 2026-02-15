---
summary: "OpenClaw logging: rolling diagnostics file log + unified log privacy flags"
read_when:
  - Capturing macOS logs or investigating private data logging
  - Debugging voice wake/session lifecycle issues
title: "macOS Logging"
x-i18n:
  source_hash: c4c201d154915e0eb08bf5e32bac98fa93766f50f2a24bf56ab4424eb7781526
---

# 로깅(macOS)

## 롤링 진단 파일 로그(디버그 창)

OpenClaw는 Swift-log(기본적으로 통합 로깅)를 통해 macOS 앱 로그를 라우팅하고 내구성 있는 캡처가 필요할 때 로컬 회전 파일 로그를 디스크에 쓸 수 있습니다.

- 자세한 정보 표시: **디버그 창 → 로그 → 앱 로깅 → 자세한 정보 표시**
- 활성화: **디버그 창 → 로그 → 앱 로깅 → “롤링 진단 로그 쓰기(JSONL)”**
- 위치: `~/Library/Logs/OpenClaw/diagnostics.jsonl` (자동으로 회전합니다. 이전 파일에는 `.1`, `.2` 접미사가 붙습니다.)
- 지우기: **디버그 창 → 로그 → 앱 로깅 → “지우기”**

참고:

- **기본적으로 꺼져 있습니다**. 적극적으로 디버깅하는 동안에만 활성화합니다.
- 파일을 민감한 파일로 취급하십시오. 검토 없이 공유하지 마세요.

## macOS에서 개인 데이터 로깅 통합

통합 로깅은 하위 시스템이 `privacy -off`를 선택하지 않는 한 대부분의 페이로드를 수정합니다. macOS [logging Privacy shenanigans](https://steipete.me/posts/2025/logging-privacy-shenanigans) (2025)에 대한 Peter의 글에 따르면 이는 하위 시스템 이름으로 키가 지정된 `/Library/Preferences/Logging/Subsystems/`의 plist에 의해 제어됩니다. 새 로그 항목만 플래그를 선택하므로 문제를 재현하기 전에 활성화하세요.

## OpenClaw 활성화 (`bot.molt`)

- 먼저 plist를 임시 파일에 쓴 다음 루트로 원자적으로 설치합니다.

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

- 재부팅이 필요하지 않습니다. logd는 파일을 빠르게 확인하지만 새 로그 줄에만 개인 페이로드가 포함됩니다.
- 기존 도우미를 사용하여 더욱 풍부한 출력을 봅니다. `./scripts/clawlog.sh --category WebChat --last 5m`.

## 디버깅 후 비활성화

- 재정의를 제거합니다: `sudo rm /Library/Preferences/Logging/Subsystems/bot.molt.plist`.
- 선택적으로 `sudo log config --reload`를 실행하여 logd가 재정의를 즉시 삭제하도록 강제합니다.
- 이 화면에는 전화번호와 메시지 본문이 포함될 수 있다는 점을 기억하세요. 추가 세부 사항이 적극적으로 필요할 때만 plist를 제자리에 유지하십시오.
