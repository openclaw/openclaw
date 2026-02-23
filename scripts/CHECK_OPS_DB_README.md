Usage examples for guardian verification

1) Basic stub run (verify behaviour without touching prod DB)

  python3 scripts/check_ops_db.py --stub

Expected: prints STUB DB created at <path>, writes report to logs/check_ops_db_report_<ts>.txt, exit code 0 or 1 depending on stub data.

2) Dry run against missing DB (boundary case)

  python3 scripts/check_ops_db.py --db /nonexistent/path/ops_multiagent.db

Expected: prints 'DB not found', writes report, exit code 2 (fatal)

3) Attempt autorepair without approval

  python3 scripts/check_ops_db.py --stub --apply

Expected: finds stuck entries, reports 'Stuck entries found but --approve-recovery not provided', exit code 1 (issues)
