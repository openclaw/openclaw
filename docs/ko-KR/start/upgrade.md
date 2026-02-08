---
summary: "업그레이드 및 마이그레이션 가이드"
read_when:
  - 새 버전으로 업그레이드할 때
title: "업그레이드"
---

# 업그레이드

OpenClaw를 최신 버전으로 업그레이드하는 방법입니다.

## 자동 업그레이드

```bash
openclaw update
```

### 채널 선택

```bash
# 안정 버전 (기본값)
openclaw update --channel stable

# 베타 버전
openclaw update --channel beta

# 개발 버전
openclaw update --channel dev
```

## 수동 업그레이드

### npm 사용

```bash
npm update -g openclaw
```

### 특정 버전

```bash
npm install -g openclaw@2024.2.0
```

## 업그레이드 전 확인

### 현재 버전

```bash
openclaw --version
```

### 변경 사항 확인

```bash
openclaw update --check
```

### 릴리스 노트

```bash
openclaw update --changelog
```

## 설정 마이그레이션

### 자동 마이그레이션

대부분의 설정은 자동으로 마이그레이션됩니다:

```bash
openclaw migrate
```

### 수동 마이그레이션

주요 버전 변경 시 수동 조정이 필요할 수 있습니다.

## 백업

### 업그레이드 전 백업

```bash
# 설정 백업
cp -r ~/.openclaw ~/.openclaw.backup

# 또는
openclaw backup create
```

### 복원

```bash
cp -r ~/.openclaw.backup ~/.openclaw

# 또는
openclaw backup restore
```

## 롤백

### 이전 버전으로

```bash
npm install -g openclaw@<previous-version>
```

### 설정 롤백

```bash
openclaw migrate --rollback
```

## 주요 버전 업그레이드

### 브레이킹 체인지 확인

```bash
openclaw update --breaking-changes
```

### 마이그레이션 가이드

주요 버전 업그레이드 시 공식 마이그레이션 가이드 참조:

- 릴리스 노트 확인
- 브레이킹 체인지 목록 확인
- 테스트 환경에서 먼저 시도

## 다운그레이드

### 주의사항

- 새 버전에서 생성된 데이터가 호환되지 않을 수 있음
- 백업 필수

### 다운그레이드 방법

```bash
# 특정 버전으로
npm install -g openclaw@2024.1.0

# 마이그레이션 롤백
openclaw migrate --rollback --to 2024.1.0
```

## 서비스 업그레이드

### systemd 서비스

```bash
# 서비스 중지
sudo systemctl stop openclaw

# 업그레이드
openclaw update

# 서비스 시작
sudo systemctl start openclaw
```

### Docker

```bash
docker pull openclaw/openclaw:latest
docker compose up -d
```

## 문제 해결

### 업그레이드 실패

1. npm 캐시 정리:

```bash
npm cache clean --force
```

2. 재설치:

```bash
npm uninstall -g openclaw
npm install -g openclaw
```

### 마이그레이션 오류

1. 로그 확인
2. 백업에서 복원
3. 수동 마이그레이션
