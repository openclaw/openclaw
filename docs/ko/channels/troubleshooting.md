---
read_when:
    - 채널 전송이 연결되었다고 표시되지만 응답이 실패합니다.
    - 심층 공급자 문서를 작성하기 전에 채널별 확인이 필요합니다.
summary: 채널별 오류 서명 및 수정을 통해 빠른 채널 수준 문제 해결
title: 채널 문제 해결
x-i18n:
    generated_at: "2026-02-08T15:50:25Z"
    model: gtx
    provider: google-translate
    source_hash: 30443f9aa52c4e0c732b12b18f69665349aaee45175c5d203fa4633cb216f5e0
    source_path: channels/troubleshooting.md
    workflow: 15
---

# 채널 문제 해결

채널이 연결되었지만 동작이 잘못된 경우 이 페이지를 사용하세요.

## 명령 사다리

먼저 다음을 순서대로 실행하세요.

```bash
openclaw status
openclaw gateway status
openclaw logs --follow
openclaw doctor
openclaw channels status --probe
```

정상 기준:

- `Runtime: running`
- `RPC probe: ok`
- 채널 프로브에 연결/준비가 표시됩니다.

## 왓츠앱

### WhatsApp 실패 서명

| Symptom                         | Fastest check                                       | Fix                                                     |
| ------------------------------- | --------------------------------------------------- | ------------------------------------------------------- |
| Connected but no DM replies     | `openclaw pairing list whatsapp`                    | Approve sender or switch DM policy/allowlist.           |
| Group messages ignored          | Check `requireMention` + mention patterns in config | Mention the bot or relax mention policy for that group. |
| Random disconnect/relogin loops | `openclaw channels status --probe` + logs           | Re-login and verify credentials directory is healthy.   |

전체 문제 해결: [/channels/whatsapp#troubleshooting-quick](/channels/whatsapp#troubleshooting-quick)

## 전보

### 전보 실패 서명

| Symptom                           | Fastest check                                   | Fix                                                       |
| --------------------------------- | ----------------------------------------------- | --------------------------------------------------------- |
| `/start` but no usable reply flow | `openclaw pairing list telegram`                | Approve pairing or change DM policy.                      |
| Bot online but group stays silent | Verify mention requirement and bot privacy mode | Disable privacy mode for group visibility or mention bot. |
| Send failures with network errors | Inspect logs for Telegram API call failures     | Fix DNS/IPv6/proxy routing to `api.telegram.org`.         |

전체 문제 해결: [/channels/telegram#문제 해결](/channels/telegram#troubleshooting)

## 불화

### 불일치 실패 서명

| Symptom                         | Fastest check                       | Fix                                                       |
| ------------------------------- | ----------------------------------- | --------------------------------------------------------- |
| Bot online but no guild replies | `openclaw channels status --probe`  | Allow guild/channel and verify message content intent.    |
| Group messages ignored          | Check logs for mention gating drops | Mention bot or set guild/channel `requireMention: false`. |
| DM replies missing              | `openclaw pairing list discord`     | Approve DM pairing or adjust DM policy.                   |

전체 문제 해결: [/channels/discord#문제해결](/channels/discord#troubleshooting)

## 느슨하게

### Slack 실패 서명

| Symptom                                | Fastest check                             | Fix                                               |
| -------------------------------------- | ----------------------------------------- | ------------------------------------------------- |
| Socket mode connected but no responses | `openclaw channels status --probe`        | Verify app token + bot token and required scopes. |
| DMs blocked                            | `openclaw pairing list slack`             | Approve pairing or relax DM policy.               |
| Channel message ignored                | Check `groupPolicy` and channel allowlist | Allow the channel or switch policy to `open`.     |

전체 문제 해결: [/channels/slack#문제 해결](/channels/slack#troubleshooting)

## iMessage와 BlueBubbles

### iMessage 및 BlueBubbles 실패 서명

| Symptom                          | Fastest check                                                           | Fix                                                   |
| -------------------------------- | ----------------------------------------------------------------------- | ----------------------------------------------------- |
| No inbound events                | Verify webhook/server reachability and app permissions                  | Fix webhook URL or BlueBubbles server state.          |
| Can send but no receive on macOS | Check macOS privacy permissions for Messages automation                 | Re-grant TCC permissions and restart channel process. |
| DM sender blocked                | `openclaw pairing list imessage` or `openclaw pairing list bluebubbles` | Approve pairing or update allowlist.                  |

전체 문제 해결: 

- [/channels/imessage#문제 해결-macos-privacy-and-security-tcc](/channels/imessage#troubleshooting-macos-privacy-and-security-tcc)
- [/channels/bluebubbles#문제해결](/channels/bluebubbles#troubleshooting)

## 신호

### 신호 오류 서명

| Symptom                         | Fastest check                              | Fix                                                      |
| ------------------------------- | ------------------------------------------ | -------------------------------------------------------- |
| Daemon reachable but bot silent | `openclaw channels status --probe`         | Verify `signal-cli` daemon URL/account and receive mode. |
| DM blocked                      | `openclaw pairing list signal`             | Approve sender or adjust DM policy.                      |
| Group replies do not trigger    | Check group allowlist and mention patterns | Add sender/group or loosen gating.                       |

전체 문제 해결: [/channels/signal#문제해결](/channels/signal#troubleshooting)

## 행렬

### 매트릭스 오류 서명

| Symptom                             | Fastest check                                | Fix                                             |
| ----------------------------------- | -------------------------------------------- | ----------------------------------------------- |
| Logged in but ignores room messages | `openclaw channels status --probe`           | Check `groupPolicy` and room allowlist.         |
| DMs do not process                  | `openclaw pairing list matrix`               | Approve sender or adjust DM policy.             |
| Encrypted rooms fail                | Verify crypto module and encryption settings | Enable encryption support and rejoin/sync room. |

전체 문제 해결: [/channels/matrix#문제해결](/channels/matrix#troubleshooting)
