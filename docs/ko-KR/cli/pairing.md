---
summary: "`openclaw pairing` CLI 레퍼런스 (페어링 요청 승인/목록)"
read_when:
  - 페어링 모드 DM을 사용하고 있으며 발신자를 승인해야 할 때
title: "pairing"
x-i18n:
  source_path: "docs/cli/pairing.md"
---

# `openclaw pairing`

DM 페어링 요청을 승인하거나 검사합니다 (페어링을 지원하는 채널용).

관련 문서:

- 페어링 흐름: [Pairing](/channels/pairing)

## 명령어

```bash
openclaw pairing list telegram
openclaw pairing list --channel telegram --account work
openclaw pairing list telegram --json

openclaw pairing approve telegram <code>
openclaw pairing approve --channel telegram --account work <code> --notify
```

## 참고

- 채널 입력: 위치 인자로 전달하거나 (`pairing list telegram`) `--channel <channel>`을 사용합니다.
- `pairing list`는 다중 계정 채널에서 `--account <accountId>`를 지원합니다.
- `pairing approve`는 `--account <accountId>`와 `--notify`를 지원합니다.
- 페어링 가능한 채널이 하나만 설정된 경우, `pairing approve <code>`가 허용됩니다.
