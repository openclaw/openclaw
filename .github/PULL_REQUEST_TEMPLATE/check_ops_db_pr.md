PR: Fix and enhance scripts/check_ops_db.py

Summary
- Normalize exit codes to team standard (0=OK,1=Issues,2=Fatal)
- Remove duplicated trailing block causing SyntaxError/IndentError
- Add pytest tests (stub/no-db/apply-without-approve)
- Add guardian README examples for verification

Checklist
- [ ] Lint: flake8/oxlint run locally
- [ ] Unit tests: pytest passes locally
- [ ] CI workflow included (if needed)
- [ ] README examples validated
- [ ] No secrets/credentials committed

How to validate locally
- python3 scripts/check_ops_db.py --stub
- python3 -m pytest tests/test_check_ops_db.py
- Verify exit codes as documented
