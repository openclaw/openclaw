# GOVERNANCE CHECKLIST

## 목적

고위험/중요 변경 전에 **승인 게이트**를 통과시키고, 실행 후 **감사 가능성(auditability)** 을 보장하기 위한 운영 체크리스트.

---

## Gate 0) 변경 분류

- [ ] `action_type`를 `policy-matrix.yaml` 항목과 매칭했다.
- [ ] 매칭 실패 시 `unknown_or_unclassified_action`으로 분류했다.
- [ ] `risk_tier`(low/medium/high/critical)를 확정했다.

## Gate 1) 정책 요건 확인

- [ ] `requires_approval=true` 여부를 확인했다.
- [ ] `required_checks` 항목 증빙(링크/파일/스크린샷)을 준비했다.
- [ ] high/critical 변경은 실행 전 승인 ID 발급 경로를 확보했다.

## Gate 2) 실행 전 기술 검증

- [ ] 테스트/검증(dry-run 포함) 결과를 확보했다.
- [ ] 롤백/복구 경로(backup, rollback_plan)를 준비했다.
- [ ] 영향 범위(서비스/데이터/비용/수신자)를 문서화했다.
- [ ] 자동화/스케줄 변경은 kill-switch 동작을 검증했다.

## Gate 3) 승인

- [ ] 승인권자(approver) 식별 완료
- [ ] 승인 ID(`approval_id`) 기록 완료
- [ ] critical 변경은 이중 승인(dual approval) 또는 명시적 사용자 확인 완료

## Gate 4) 실행 및 감사로그 기록

- [ ] 실행 결과(`result`)를 success/partial/failed/blocked 중 하나로 기록했다.
- [ ] high/critical 실행은 `summary`, `evidence_refs`를 필수로 남겼다.
- [ ] 실패/차단 시 원인과 후속 조치를 기록했다.
- [ ] `run-ledger.schema.json` 검증을 통과했다.

## Gate 5) 사후 점검

- [ ] 변경 후 모니터링(오류율/비용/성능/보안 이벤트)을 확인했다.
- [ ] 필요 시 즉시 롤백 또는 완화조치를 실행했다.
- [ ] 주간 리포트에 본 변경의 영향(기여/매출/운영)을 반영했다.

---

## 고위험 액션 최소 증빙 가이드

- `production_deploy`: 테스트 결과, changelog, rollback plan
- `destructive_delete_or_rollback`: backup 증빙, 영향 분석, 사용자 명시 승인
- `credential_or_secret_change`: secret 범위 검토, rotation 계획, 롤백 계획
- `access_control_change`: 최소권한 검토, 영향 분석, 이중 승인
- `external_data_export_or_share`: 데이터 분류, PII 제거 확인, 수신 범위 확인
- `financial_transaction_or_billing_change`: 비용 추정, 예산 승인자 확인, 감사추적

---

## 감사로그 필수필드 제안 10개 (vNext)

아래 10개는 고위험 변경 기준으로 **필수화 권장**:

1. `run_id` (실행 고유 ID)
2. `timestamp` (실행 시각, ISO-8601)
3. `action_type` (정책 매트릭스 분류값)
4. `actor_id` (실행 주체/에이전트 ID)
5. `target_scope` (영향 대상: 서비스/레포/데이터셋)
6. `risk_level` (low/medium/high/critical)
7. `approval_required` (승인 필요 여부)
8. `approval_id` (승인 식별자)
9. `result` (success/partial/failed/blocked)
10. `integrity_hash` (로그 위변조 방지 해시, 예: sha256)
