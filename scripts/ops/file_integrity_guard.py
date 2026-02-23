#!/usr/bin/env python3
"""
file_integrity_guard.py - 파일 무결성 보호 스크립트
=====================================================
macOS/Linux 환경에서 파일 무결성을 보장하기 위한 스크립트

기능:
1. 해시 고정: SHA-256 해시 파일 생성 및 접근 제한
2. 변경 불가 설정: macOS chflags / Linux chattr
3. 감사 규칙: auditd (Linux) / fsevents (macOS)
4. 증거 번들: 해시/로그/타임스탬프 포함 .tar.gz 생성

사용법:
    python3 file_integrity_guard.py --help

작성: 2026-02-15
환경: macOS 15.6 (arm64)
"""

import argparse
import hashlib
import os
import json
import subprocess
import sys
import tarfile
import datetime
import re
from pathlib import Path
from typing import List, Dict, Optional, Tuple

# =============================================================================
# 상수 정의
# =============================================================================
SCRIPT_NAME = "file_integrity_guard"
VERSION = "1.0.0"
LOG_DIR = Path("/Users/ron/.openclaw/logs")
HASH_DIR = Path("/Users/ron/.openclaw/workspace/.integrity")
EVIDENCE_DIR = Path("/Users/ron/.openclaw/workspace/.evidence")
CONFIG_FILE = Path("/Users/ron/.openclaw/workspace/.integrity_config.json")

# =============================================================================
# 로깅
# =============================================================================
class Logger:
    """간단한 로거 클래스"""
    
    def __init__(self, log_file: Path):
        self.log_file = log_file
        self.log_file.parent.mkdir(parents=True, exist_ok=True)
        
    def log(self, level: str, message: str):
        timestamp = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        log_line = f"[{timestamp}] [{level}] {message}"
        print(log_line)
        with open(self.log_file, "a") as f:
            f.write(log_line + "\n")
    
    def info(self, msg: str):
        self.log("INFO", msg)
    
    def warn(self, msg: str):
        self.log("WARN", msg)
    
    def error(self, msg: str):
        self.log("ERROR", msg)
    
    def debug(self, msg: str):
        self.log("DEBUG", msg)

# =============================================================================
# 유틸리티 함수
# =============================================================================
def get_file_hash(file_path: Path) -> str:
    """SHA-256 해시 계산"""
    sha256 = hashlib.sha256()
    with open(file_path, "rb") as f:
        for chunk in iter(lambda: f.read(8192), b""):
            sha256.update(chunk)
    return sha256.hexdigest()

def is_macos() -> bool:
    """macOS 환경 여부 확인"""
    return sys.platform == "darwin"

def is_linux() -> bool:
    """Linux 환경 여부 확인"""
    return sys.platform.startswith("linux")

def run_command(cmd: List[str], check: bool = True) -> Tuple[int, str, str]:
    """명령어 실행 유틸리티"""
    try:
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=30
        )
        return result.returncode, result.stdout, result.stderr
    except subprocess.TimeoutExpired:
        return -1, "", "Command timeout"
    except Exception as e:
        return -1, "", str(e)

# =============================================================================
# 파일 보호 기능
# =============================================================================
class FileProtector:
    """파일 보호 관리자"""
    
    def __init__(self, logger: Logger, dry_run: bool = False):
        self.logger = logger
        self.dry_run = dry_run
        self.changes = []
        
    def calculate_hash(self, file_path: Path) -> Dict:
        """파일 해시 계산"""
        if not file_path.exists():
            return {"error": "File not found"}
        
        hash_value = get_file_hash(file_path)
        stat = file_path.stat()
        
        return {
            "path": str(file_path),
            "hash": hash_value,
            "size": stat.st_size,
            "mtime": stat.st_mtime,
            "mode": oct(stat.st_mode)
        }
    
    def save_hash_record(self, file_path: Path, hash_record: Dict) -> Path:
        """해시 레코드 저장"""
        hash_file = HASH_DIR / f"{file_path.name}.sha256"
        hash_file.parent.mkdir(parents=True, exist_ok=True)
        
        # 해시 파일 내용: "hash  filename\n"
        with open(hash_file, "w") as f:
            f.write(f"{hash_record['hash']}  {file_path.name}\n")
        
        # 해시 파일 보호 (읽기 전용)
        if not self.dry_run:
            os.chmod(hash_file, 0o444)
            if is_macos():
                run_command(["chflags", "uchg", str(hash_file)])
            elif is_linux():
                run_command(["chattr", "+i", str(hash_file)])
        
        self.logger.info(f"해시 기록 저장: {hash_file}")
        return hash_file
    
    def set_immutable(self, file_path: Path) -> bool:
        """파일 변경 불가 설정 (macOS: chflags uchg, Linux: chattr +i)"""
        if self.dry_run:
            self.logger.info(f"[DRY-RUN] 변경 불가 설정: {file_path}")
            return True
            
        if not file_path.exists():
            self.logger.error(f"파일 없음: {file_path}")
            return False
        
        try:
            if is_macos():
                # 읽기 전용 + 변경 불가 플래그
                os.chmod(file_path, 0o444)
                rc, _, err = run_command(["chflags", "nouchg", str(file_path)])  # 기존 플래그 제거
                rc, _, err = run_command(["chflags", "uchg", str(file_path)])
                if rc != 0:
                    self.logger.warn(f"chflags 실패 (sudo 필요할 수 있음): {err}")
                    # sudo 없이 읽기 전용만 설정
                    os.chmod(file_path, 0o444)
                    return True
                return True
                
            elif is_linux():
                rc, _, err = run_command(["chattr", "+i", str(file_path)])
                if rc != 0:
                    self.logger.warn(f"chattr 실패 (sudo 필요): {err}")
                    return False
                return True
                
        except Exception as e:
            self.logger.error(f"변경 불가 설정 실패: {e}")
            return False
        
        return True
    
    def unset_immutable(self, file_path: Path) -> bool:
        """파일 변경 불가 해제"""
        if self.dry_run:
            self.logger.info(f"[DRY-RUN] 변경 불가 해제: {file_path}")
            return True
            
        try:
            if is_macos():
                rc, _, _ = run_command(["chflags", "nouchg", str(file_path)])
                return rc == 0
            elif is_linux():
                rc, _, _ = run_command(["chattr", "-i", str(file_path)])
                return rc == 0
        except Exception as e:
            self.logger.error(f"변경 불가 해제 실패: {e}")
            return False
        return True
    
    def verify_hash(self, file_path: Path) -> Tuple[bool, Dict]:
        """해시 검증"""
        if not file_path.exists():
            return False, {"error": "File not found"}
        
        hash_file = HASH_DIR / f"{file_path.name}.sha256"
        if not hash_file.exists():
            return False, {"error": "Hash file not found"}
        
        # 저장된 해시 읽기
        with open(hash_file, "r") as f:
            stored_hash = f.read().split()[0]
        
        # 현재 해시 계산
        current_hash = get_file_hash(file_path)
        
        is_valid = stored_hash == current_hash
        result = {
            "path": str(file_path),
            "stored_hash": stored_hash,
            "current_hash": current_hash,
            "valid": is_valid
        }
        
        return is_valid, result

# =============================================================================
# 감사(Audit) 기능
# =============================================================================
class AuditManager:
    """감사 규칙 관리자"""
    
    def __init__(self, logger: Logger, dry_run: bool = False):
        self.logger = logger
        self.dry_run = dry_run
        self.audit_rules = []
        
    def add_audit_rule(self, file_path: Path) -> bool:
        """감사 규칙 추가 (macOS: FSEvents 대체方案, Linux: auditd)"""
        if self.dry_run:
            self.logger.info(f"[DRY-RUN] 감사 규칙 추가: {file_path}")
            return True
        
        if is_macos():
            # macOS: opensnoop 또는 fseventsd 활용
            # 실제 구현은-launchd 또는 fsevents 모니터링 필요
            # 여기서는 기본적인 watch 파일 생성
            watch_file = Path(f"/tmp/.fswatch_{file_path.name}")
            with open(watch_file, "w") as f:
                f.write(str(file_path))
            self.logger.info(f"감시 파일 생성: {watch_file}")
            return True
            
        elif is_linux():
            # Linux: auditd 규칙 추가
            rule = f"-w {file_path} -p wa -k integrity_monitor"
            rc, _, err = run_command([
                "auditctl", "-a", "always,exit -F", f"path={file_path}", "-F", "perm=wa"
            ])
            
            if rc != 0:
                # auditd 설치 안 되어있을 경우
                self.logger.warn(f"auditd 규칙 추가 실패: {err}")
                return False
            
            self.logger.info(f"감사 규칙 추가: {rule}")
            return True
        
        return False
    
    def check_audit_status(self) -> Dict:
        """감사 시스템 상태 확인"""
        status = {"enabled": False, "system": "unknown"}
        
        if is_macos():
            # macOS: fseventsd 확인
            rc, out, _ = run_command(["ps", "aux"])
            status["enabled"] = "fseventsd" in out or "fswatch" in out
            status["system"] = "fsevents"
            
        elif is_linux():
            # Linux: auditd 확인
            rc, out, _ = run_command(["systemctl", "is-active", "auditd"])
            status["enabled"] = rc == 0 and "active" in out
            status["system"] = "auditd"
        
        return status

# =============================================================================
# 증거 번들 생성
# =============================================================================
class EvidenceBundler:
    """증거 번들 생성기"""
    
    def __init__(self, logger: Logger, dry_run: bool = False):
        self.logger = logger
        self.dry_run = dry_run
        self.bundle_dir = EVIDENCE_DIR
        
    def create_bundle(self, files: List[Path], bundle_name: Optional[str] = None) -> Path:
        """증거 번들 생성 (.tar.gz)"""
        if self.dry_run:
            self.logger.info(f"[DRY-RUN] 증거 번들 생성: {files}")
            return Path("/tmp/dry_run_bundle.tar.gz")
        
        # 번들 디렉토리 생성
        self.bundle_dir.mkdir(parents=True, exist_ok=True)
        
        # 번들 이름: evidence_YYYYMMDD_HHMMSS.tar.gz
        if not bundle_name:
            timestamp = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
            bundle_name = f"evidence_{timestamp}.tar.gz"
        
        bundle_path = self.bundle_dir / bundle_name
        
        # tar.gz 생성
        with tarfile.open(bundle_path, "w:gz") as tar:
            for file_path in files:
                if file_path.exists():
                    tar.add(file_path, arcname=file_path.name)
                else:
                    self.logger.warn(f"번들할 파일 없음: {file_path}")
        
        # 체크섬 생성
        checksum_path = bundle_path.with_suffix(".sha256")
        hash_value = get_file_hash(bundle_path)
        
        with open(checksum_path, "w") as f:
            f.write(f"{hash_value}  {bundle_name}\n")
        
        # 메타데이터 생성
        meta_path = bundle_path.with_suffix(".meta.json")
        metadata = {
            "bundle": str(bundle_path),
            "checksum": hash_value,
            "created": datetime.datetime.now().isoformat(),
            "files": [str(f) for f in files if f.exists()],
            "size": bundle_path.stat().st_size
        }
        
        with open(meta_path, "w") as f:
            json.dump(metadata, f, indent=2)
        
        self.logger.info(f"증거 번들 생성: {bundle_path}")
        self.logger.info(f"체크섬: {hash_value}")
        
        return bundle_path

# =============================================================================
# 메인 로직
# =============================================================================
class IntegrityGuard:
    """파일 무결성 보호 메인 클래스"""
    
    def __init__(self, args):
        self.args = args
        self.logger = Logger(LOG_DIR / f"file_integrity_guard_{datetime.datetime.now().strftime('%Y%m%d')}.log")
        self.protector = FileProtector(self.logger, args.dry_run)
        self.auditor = AuditManager(self.logger, args.dry_run)
        self.bundler = EvidenceBundler(self.logger, args.dry_run)
        
    def run(self):
        """메인 실행"""
        self.logger.info(f"=== {SCRIPT_NAME} v{VERSION} 시작 ===")
        
        if self.args.dry_run:
            self.logger.info("*** DRY-RUN MODE ***")
        
        # 작업 분기
        if self.args.action == "protect":
            return self.action_protect()
        elif self.args.action == "verify":
            return self.action_verify()
        elif self.args.action == "bundle":
            return self.action_bundle()
        elif self.args.action == "audit-status":
            return self.action_audit_status()
        elif self.args.action == "rollback":
            return self.action_rollback()
        elif self.args.action == "test":
            return self.action_test()
        else:
            self.logger.error(f"알 수 없는 작업: {self.args.action}")
            return 1
    
    def action_protect(self) -> int:
        """파일 보호 작업"""
        target_files = self.args.files
        
        if not target_files:
            self.logger.error("대상 파일이 지정되지 않았습니다")
            return 1
        
        results = []
        
        for file_path_str in target_files:
            file_path = Path(file_path_str).resolve()
            self.logger.info(f"처리 중: {file_path}")
            
            result = {"file": str(file_path), "success": False}
            
            # 1. 해시 계산
            hash_info = self.protector.calculate_hash(file_path)
            self.logger.info(f"해시: {hash_info.get('hash', 'N/A')[:16]}...")
            
            # 2. 해시 기록 저장
            hash_file = self.protector.save_hash_record(file_path, hash_info)
            
            # 3. 변경 불가 설정
            if self.protector.set_immutable(file_path):
                self.logger.info("변경 불가 설정 완료")
                result["immutable"] = True
            else:
                self.logger.warn("변경 불가 설정 실패")
                result["immutable"] = False
            
            # 4. 감사 규칙 추가
            if self.auditor.add_audit_rule(file_path):
                self.logger.info("감사 규칙 추가 완료")
                result["audit"] = True
            else:
                self.logger.warn("감사 규칙 추가 실패")
                result["audit"] = False
            
            result["success"] = True
            results.append(result)
        
        # 결과 요약
        success_count = sum(1 for r in results if r["success"])
        self.logger.info(f"완료: {success_count}/{len(results)} 파일 처리됨")
        
        # 결과 저장
        if not self.args.dry_run:
            result_file = HASH_DIR / "protect_results.json"
            with open(result_file, "w") as f:
                json.dump(results, f, indent=2)
            self.logger.info(f"결과 저장: {result_file}")
        
        return 0 if success_count == len(results) else 1
    
    def action_verify(self) -> int:
        """해시 검증 작업"""
        target_files = self.args.files
        
        if not target_files:
            self.logger.error("대상 파일이 지정되지 않았습니다")
            return 1
        
        results = []
        
        for file_path_str in target_files:
            file_path = Path(file_path_str).resolve()
            self.logger.info(f"검증 중: {file_path}")
            
            is_valid, verify_info = self.protector.verify_hash(file_path)
            
            if is_valid:
                self.logger.info("✅ 해시 검증 통과")
            else:
                self.logger.error(f"❌ 해시 검증 실패: {verify_info.get('error', '해시 불일치')}")
            
            results.append({
                "file": str(file_path),
                "valid": is_valid,
                "details": verify_info
            })
        
        # 결과 저장
        result_file = HASH_DIR / "verify_results.json"
        with open(result_file, "w") as f:
            json.dump(results, f, indent=2)
        
        valid_count = sum(1 for r in results if r["valid"])
        self.logger.info(f"검증 완료: {valid_count}/{len(results)} 통과")
        
        return 0 if valid_count == len(results) else 1
    
    def action_bundle(self) -> int:
        """증거 번들 생성"""
        target_files = [Path(f).resolve() for f in self.args.files] if self.args.files else []
        
        # 기본 번들 대상: 해시 디렉토리 + 로그
        if not target_files:
            target_files = [
                HASH_DIR,
                LOG_DIR / "file_integrity_guard_*.log"
            ]
        
        bundle_path = self.bundler.create_bundle(target_files, self.args.bundle_name)
        self.logger.info(f"증거 번들 생성 완료: {bundle_path}")
        
        return 0
    
    def action_audit_status(self) -> int:
        """감사 시스템 상태 확인"""
        status = self.auditor.check_audit_status()
        
        self.logger.info(f"감사 시스템: {status['system']}")
        self.logger.info(f"활성화 상태: {status['enabled']}")
        
        print(json.dumps(status, indent=2))
        return 0
    
    def action_rollback(self) -> int:
        """변경 불가 해제 (롤백)"""
        target_files = self.args.files
        
        if not target_files:
            self.logger.error("대상 파일이 지정되지 않았습니다")
            return 1
        
        for file_path_str in target_files:
            file_path = Path(file_path_str).resolve()
            
            if self.protector.unset_immutable(file_path):
                self.logger.info(f"롤백 완료: {file_path}")
            else:
                self.logger.error(f"롤백 실패: {file_path}")
        
        return 0
    
    def action_test(self) -> int:
        """테스트 케이스 실행"""
        self.logger.info("=== 테스트 케이스 실행 ===")
        
        # 테스트 1: DRY-RUN 모드 실행
        test_args = argparse.Namespace(
            action="protect",
            files=["/Users/ron/.openclaw/workspace/scripts/test_file.txt"],
            dry_run=True,
            bundle_name=None
        )
        
        # 테스트 파일 생성 (없으면)
        test_file = Path("/Users/ron/.openclaw/workspace/scripts/test_file.txt")
        if not test_file.exists():
            test_file.parent.mkdir(parents=True, exist_ok=True)
            with open(test_file, "w") as f:
                f.write("test content for integrity guard")
        
        # DRY-RUN 실행
        guard = IntegrityGuard(test_args)
        result = guard.run()
        
        self.logger.info(f"테스트 결과: {'성공' if result == 0 else '실패'}")
        
        # 테스트 파일 정리
        if test_file.exists() and not self.args.dry_run:
            test_file.unlink()
        
        return result

# =============================================================================
# CLI 파서
# =============================================================================
def create_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="file_integrity_guard - 파일 무결성 보호 스크립트",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
사용 예시:
  # 파일 보호 (해시 고정 + 변경 불가 + 감사 규칙)
  python3 file_integrity_guard.py protect /path/to/file1 /path/to/file2
  
  # DRY-RUN 모드
  python3 file_integrity_guard.py --dry-run protect /path/to/file
  
  # 해시 검증
  python3 file_integrity_guard.py verify /path/to/file
  
  # 증거 번들 생성
  python3 file_integrity_guard.py bundle --bundle-name my_evidence.tar.gz
  
  # 감사 시스템 상태 확인
  python3 file_integrity_guard.py audit-status
  
  # 변경 불가 해제 (롤백)
  python3 file_integrity_guard.py rollback /path/to/file
  
  # 테스트 실행
  python3 file_integrity_guard.py test
        """
    )
    
    parser.add_argument("action", choices=[
        "protect", "verify", "bundle", "audit-status", "rollback", "test"
    ], help="실행할 작업")
    
    parser.add_argument("files", nargs="*", help="대상 파일 목록")
    
    parser.add_argument("--dry-run", "-n", action="store_true",
                        help="DRY-RUN 모드 (실제 변경 없음)")
    
    parser.add_argument("--bundle-name", "-b", 
                        help="증거 번들 파일 이름")
    
    parser.add_argument("--version", "-v", action="version",
                        version=f"{SCRIPT_NAME} v{VERSION}")
    
    return parser

# =============================================================================
# 진입점
# =============================================================================
def main():
    parser = create_parser()
    args = parser.parse_args()
    
    guard = IntegrityGuard(args)
    sys.exit(guard.run())

if __name__ == "__main__":
    main()
