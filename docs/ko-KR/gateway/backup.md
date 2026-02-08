---
summary: "백업, 설정 내보내기/가져오기"
read_when:
  - 데이터를 백업하고 싶을 때
title: "백업"
---

# 백업

OpenClaw 데이터 백업 및 복원 가이드입니다.

## 백업 대상

| 항목         | 경로                        | 중요도 |
| ------------ | --------------------------- | ------ |
| 설정         | `~/.openclaw/openclaw.json` | 높음   |
| 자격 증명    | `~/.openclaw/credentials/`  | 높음   |
| 세션         | `~/.openclaw/sessions/`     | 중간   |
| 메모리       | `~/.openclaw/memory/`       | 중간   |
| 워크스페이스 | `~/.openclaw/workspace/`    | 높음   |
| 로그         | `~/.openclaw/logs/`         | 낮음   |

## 빠른 백업

### 전체 백업

```bash
openclaw backup create
```

### 특정 항목만

```bash
openclaw backup create --only config,credentials,workspace
```

### 백업 위치 지정

```bash
openclaw backup create --output ~/backups/openclaw-backup.tar.gz
```

## 수동 백업

### 전체 폴더

```bash
# Linux/macOS
tar -czvf openclaw-backup.tar.gz ~/.openclaw

# Windows PowerShell
Compress-Archive -Path $env:USERPROFILE\.openclaw -DestinationPath openclaw-backup.zip
```

### 설정만

```bash
cp ~/.openclaw/openclaw.json ~/openclaw-config-backup.json
```

## 복원

### 전체 복원

```bash
openclaw backup restore ~/backups/openclaw-backup.tar.gz
```

### 선택적 복원

```bash
openclaw backup restore ~/backups/openclaw-backup.tar.gz --only config,workspace
```

## 자동 백업

### 설정

```json5
{
  backup: {
    auto: true,
    schedule: "0 0 * * *", // 매일 자정
    retention: 7, // 7일 보관
    path: "~/.openclaw/backups",
  },
}
```

### 백업 옵션

```json5
{
  backup: {
    include: ["config", "credentials", "workspace", "memory"],
    exclude: ["logs", "cache"],
    compress: true,
  },
}
```

## 이전 (Migration)

### 다른 컴퓨터로

1. 소스에서 백업:

```bash
openclaw backup create --output ./transfer-backup.tar.gz
```

2. 파일 전송

3. 대상에서 복원:

```bash
openclaw backup restore ./transfer-backup.tar.gz
```

### 주의사항

- 채널 자격 증명은 기기별로 다를 수 있음
- WhatsApp 세션은 전송 후 재로그인 필요
- API 키는 환경변수로 별도 관리 권장

## 클라우드 백업

### 수동 업로드

```bash
# Google Drive (rclone 사용)
rclone copy ~/.openclaw/backups remote:openclaw-backups

# AWS S3
aws s3 sync ~/.openclaw/backups s3://my-bucket/openclaw-backups
```

### 자동화

```json5
{
  backup: {
    auto: true,
    postBackup: "rclone copy ~/.openclaw/backups remote:openclaw-backups",
  },
}
```

## 설정 내보내기/가져오기

### 내보내기

```bash
# 설정만
openclaw config export > config-export.json

# 전체
openclaw config export --full > full-export.json
```

### 가져오기

```bash
openclaw config import < config-export.json
```

## 세션 백업

### 특정 세션

```bash
openclaw sessions export <session-key> > session-backup.json
```

### 모든 세션

```bash
openclaw sessions export --all > all-sessions.json
```

### 세션 복원

```bash
openclaw sessions import < session-backup.json
```

## 문제 해결

### 복원 실패

1. 백업 파일 무결성 확인
2. 버전 호환성 확인
3. 권한 확인

### 채널 재연결 필요

- WhatsApp: QR 코드 재스캔
- Telegram: 봇 토큰 유효성 확인
- Discord: 봇 초대 상태 확인
