#!/usr/bin/env bash
set -euo pipefail

# whitelist_rollback.sh
# 안전한 화이트리스트 롤백(undo) 스크립트
# 위치: scripts/whitelist_rollback.sh
# 사용법:
#  - ./scripts/whitelist_rollback.sh --dry-run
#  - sudo ./scripts/whitelist_rollback.sh --apply --target /etc/openclaw/whitelist.txt
# 기본 동작:
#  1) 현재 화이트리스트 파일을 백업(타임스탬프 포함)
#  2) 변경 기록을 백업 파일에 주석으로 추가
#  3) --apply 지정 시 지정된 백업으로 복구
#  4) 정규식(패턴) 유효성/중복 검사 수행

TARGET="/etc/openclaw/whitelist.txt"
BACKUP_DIR="/var/backups/openclaw"
DRY_RUN=false
APPLY=false
BACKUP_FILE=""
VERBOSE=true

# 필수 명령 검사
_required_cmds=(cp mktemp grep python3 date id)
for cmd in "${_required_cmds[@]}"; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "[whitelist_rollback][ERROR] 필수 명령 없음: $cmd" >&2
    exit 20
  fi
done

usage(){
  cat <<EOF
usage: $0 [--dry-run] [--apply] [--target PATH] [--backup-dir PATH]

Options:
  --dry-run       : 시뮬레이션 모드 (비파괴). 변경 없이 검증만 수행
  --apply         : 실제 복구 적용. 관리자 권한(required)
  --target PATH   : 롤백 대상 화이트리스트 파일 경로 (기본: /etc/openclaw/whitelist.txt)
  --backup-dir DIR: 백업 저장 디렉터리 (기본: /var/backups/openclaw)
  -h,--help       : 도움말
EOF
}

log(){
  echo "[whitelist_rollback] $1"
}

err(){
  echo "[whitelist_rollback][ERROR] $1" >&2
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=true; shift ;;
    --apply) APPLY=true; shift ;;
    --target) TARGET="$2"; shift 2 ;;
    --backup-dir) BACKUP_DIR="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) err "Unknown arg: $1"; usage; exit 2 ;;
  esac
done

if [[ "$APPLY" == true && $(id -u) -ne 0 ]]; then
  err "--apply 모드에는 관리자 권한이 필요합니다. sudo로 실행하세요."
  exit 3
fi

if [[ ! -f "$TARGET" ]]; then
  err "대상 파일이 존재하지 않습니다: $TARGET"
  exit 4
fi

# 안전한 백업 디렉터리 생성: 최소 권한(0750)
umask 027
mkdir -p -- "$BACKUP_DIR"

TS=$(date -u +"%Y%m%dT%H%M%SZ")
BACKUP_FILE="$BACKUP_DIR/whitelist.txt.$TS.bak"

log "백업 위치: $BACKUP_FILE"

if [[ "$DRY_RUN" == true ]]; then
  log "--dry-run: 파일 복사 없이 시뮬레이션 (검증만 수행)"
  # dry-run도 동일한 배열 형식으로 유지 (출력만 수행)
  cp_cmd=(echo cp -- "$TARGET" "$BACKUP_FILE")
else
  cp_cmd=(cp --preserve=mode,timestamps -- "$TARGET" "$BACKUP_FILE")
fi

log "백업 실행: ${cp_cmd[*]:-}" 
if [[ "$DRY_RUN" == false ]]; then
  if ! "${cp_cmd[@]}"; then
    err "백업 실패: $TARGET -> $BACKUP_FILE"
    exit 5
  fi
else
  # dry-run 출력 실행 (안전하게 보여주기)
  "${cp_cmd[@]}"
fi

# 주석으로 변경 기록 추가 (백업 파일에)
COMMENT="# backup created by whitelist_rollback.sh at $TS (uid=$(id -u))"
if [[ "$DRY_RUN" == true ]]; then
  log "--dry-run: 백업 파일에 주석 추가 시뮬레이션: echo '$COMMENT' >> $BACKUP_FILE"
else
  # append atomically
  printf '%s\n' "$COMMENT" >> "$BACKUP_FILE"
  # 안전한 권한 설정(백업 파일): root가 소유자면 root:root, 권한 0640
  if [[ $(id -u) -eq 0 ]]; then
    chown root:root -- "$BACKUP_FILE" || true
  fi
  chmod 0640 -- "$BACKUP_FILE" || true
  # 백업 체크섬 생성 (가능하면 sha256)
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$BACKUP_FILE" > "$BACKUP_FILE.sha256" || true
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$BACKUP_FILE" > "$BACKUP_FILE.sha256" || true
  else
    log "경고: checksum 도구(sha256sum/shasum)가 없음. 체크섬을 생성하지 못했습니다."
  fi
fi

# 안전검증: 유효한 정규식인지 확인하고 중복/충돌 검사 수행
# 규칙: 화이트리스트 파일에서 '#'으로 시작하거나 빈 줄은 무시
# 각 비주석 라인은 하나의 정규식(Perl-정규식 호환)로 가정

log "정규식 유효성 및 중복 검사 시작"

# 추출된 패턴을 임시파일로 만듬 (mktemp 안전 사용)
PATTERNS_TMP=$(mktemp --tmpdir "whitelist_patterns.XXXXXX")
# 안전한 정리
cleanup(){
  rm -f -- "$PATTERNS_TMP"
}
trap cleanup EXIT

# non-comment, non-empty lines
grep -v -e '^\s*#' -e '^\s*$' -- "$TARGET" > "$PATTERNS_TMP" || true

# Python을 사용해 각 패턴을 컴파일하고 중복/교차(동일 패턴) 검사
python3 "$PATTERNS_TMP" <<'PY'
import sys, re
pfile = sys.argv[1]
with open(pfile, 'r', encoding='utf-8') as f:
    lines = [l.rstrip('\n') for l in f if l.strip()]

seen = {}
errors = 0
for i, pat in enumerate(lines, start=1):
    try:
        re.compile(pat)
    except re.error as e:
        print(f"INVALID_REGEX at line {i}: {pat!r} -> {e}")
        errors += 1
    if pat in seen:
        print(f"DUPLICATE_PATTERN at lines {seen[pat]} and {i}: {pat!r}")
        errors += 1
    else:
        seen[pat] = i

if errors:
    sys.exit(10)
else:
    print('REGEX_CHECK_OK')
PY

rc=$?
if [[ $rc -eq 10 ]]; then
  err "정규식 검사 실패. 백업은 생성되었으나 적용 전 확인 필요합니다."
  exit 6
fi

log "정규식 검사 통과"

if [[ "$APPLY" == true ]]; then
  # 복구 동작: 백업 파일의 내용을 TARGET으로 덮어씀
  log "--apply: 백업 파일에서 복구를 수행합니다."
  if [[ "$DRY_RUN" == true ]]; then
    log "--dry-run and --apply: 시뮬레이션 모드이므로 실제 적용하지 않습니다"
  else
    # 복구 시 안전을 위해 임시파일로 쓰고 원자 교체
    TMP_RESTORE=$(mktemp --tmpdir "whitelist_restore.XXXXXX")
    if ! cp --preserve=mode,timestamps -- "$BACKUP_FILE" "$TMP_RESTORE"; then
      err "복구 준비 실패: $BACKUP_FILE -> $TMP_RESTORE"
      rm -f -- "$TMP_RESTORE"
      exit 7
    fi
    if ! mv -- "$TMP_RESTORE" "$TARGET"; then
      err "복구 실패: $TMP_RESTORE -> $TARGET"
      rm -f -- "$TMP_RESTORE"
      exit 8
    fi
    log "복구 성공: $BACKUP_FILE -> $TARGET"
  fi
else
  log "--apply 미지정: 복구는 수행되지 않았습니다. 백업만 생성됨"
fi

log "완료. 백업 파일: $BACKUP_FILE"
if [[ "$DRY_RUN" == false ]]; then
  log "권장: sudo openclaw policy reload 또는 시스템의 정책 로드 명령을 실행하세요."
fi

exit 0
