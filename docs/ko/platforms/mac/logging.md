---
read_when:
    - macOS 로그 캡처 또는 개인 데이터 로깅 조사
    - 음성 깨우기/세션 수명 주기 문제 디버깅
summary: 'OpenClaw 로깅: 롤링 진단 파일 로그 + 통합 로그 개인 정보 보호 플래그'
title: macOS 로깅
x-i18n:
    generated_at: "2026-02-08T16:00:55Z"
    model: gtx
    provider: google-translate
    source_hash: c4c201d154915e0eb08bf5e32bac98fa93766f50f2a24bf56ab4424eb7781526
    source_path: platforms/mac/logging.md
    workflow: 15
---

# 로깅(macOS)

## 롤링 진단 파일 로그(디버그 창)

OpenClaw는 Swift-log(기본적으로 통합 로깅)를 통해 macOS 앱 로그를 라우팅하고 내구성 있는 캡처가 필요할 때 로컬 회전 파일 로그를 디스크에 쓸 수 있습니다.

- 다변: **디버그 창 → 로그 → 앱 로깅 → 자세한 정보 표시**
- 할 수 있게 하다: **디버그 창 → 로그 → 앱 로깅 → "롤링 진단 로그 쓰기(JSONL)"**
- 위치: `~/Library/Logs/OpenClaw/diagnostics.jsonl` (자동으로 회전하며 오래된 파일에는 다음이 붙습니다. `.1`, `.2`, …)
- 분명한: **디버그 창 → 로그 → 앱 로깅 → '지우기'**

참고:

- 이것은 **기본적으로 꺼짐**. 적극적으로 디버깅하는 동안에만 활성화합니다.
- 파일을 민감한 파일로 취급하십시오. 검토 없이 공유하지 마세요.

## macOS의 통합 로깅 개인 데이터

통합 로깅은 하위 시스템이 선택하지 않는 한 대부분의 페이로드를 수정합니다. `privacy -off`. MacOS에 대한 Per Peter의 글 [개인 정보 보호 헛소리 기록](https://steipete.me/posts/2025/logging-privacy-shenanigans) (2025) 이것은 plist에 의해 제어됩니다. `/Library/Preferences/Logging/Subsystems/` 하위 시스템 이름으로 입력됩니다. 새 로그 항목만 플래그를 선택하므로 문제를 재현하기 전에 활성화하세요.

## OpenClaw에 대해 활성화(`bot.molt`)

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
- 기존 도우미를 사용하여 더욱 풍부한 출력을 확인하세요. `./scripts/clawlog.sh --category WebChat --last 5m`.

## 디버깅 후 비활성화

- 재정의를 제거합니다. `sudo rm /Library/Preferences/Logging/Subsystems/bot.molt.plist`.
- 선택적으로 실행 `sudo log config --reload` logd가 재정의를 즉시 삭제하도록 강제합니다.
- 이 화면에는 전화번호와 메시지 본문이 포함될 수 있다는 점을 기억하세요. 추가 세부 사항이 적극적으로 필요할 때만 plist를 제자리에 유지하십시오.
