# check_ops_db 실행 예제 (Guardian 검증용)

다음 예제 3개는 guardian 검증 절차에서 사용하세요. 각 예제는 기대 결과를 함께 제공합니다.

1) 스텁 DB로 전체 검사 실행 (기본, 사람이 읽을 수 있는 로그)

- 명령:
  python3 scripts/check_ops_db.py --stub

- 기대 결과:
  - Exit code: 0
  - stdout에 "STUB DB created" 또는 "Check run at" 로그 포함
  - 로그 파일: logs/check_ops_db_report_<ts>.txt 생성

2) 스텁 DB로 JSON 요약 출력 (자동화 파이프라인 테스트)

- 명령:
  python3 scripts/check_ops_db.py --stub --json

- 기대 결과:
  - Exit code: 0
  - stdout: JSON 오브젝트 (timestamp, db_path, problems_found, recovered, report_path, summary)
  - 문제/복구 여부를 자동 검사 파이프라인에서 파싱 가능

3) 존재하지 않는 DB 경로로 실행 (오류 경로 검증)

- 명령:
  python3 scripts/check_ops_db.py --db /nonexistent/path/db.sqlite

- 기대 결과:
  - Exit code: 2
  - stdout 또는 stderr에 "DB not found" 메시지 포함
  - report 파일이 생성되어 관련 메시지 포함 가능
