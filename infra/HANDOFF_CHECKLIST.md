# Observability Stack Handoff Checklist

**Handoff Date:** ________________  
**From (Engineering):** ________________  
**To (Operations):** ________________  

---

## Pre-Handoff (Engineering Team)

### Testing & Validation
- [ ] **Staging Tests**: All tests in VERIFY_STAGING.md passed
  - Reference: [`infra/VERIFY_STAGING.md`](VERIFY_STAGING.md)
  - Date completed: ________________
  - Issues: _______________________________________________

- [ ] **Production Tests**: All tests in VERIFY_PRODUCTION.md passed (if deploying to prod)
  - Reference: [`infra/VERIFY_PRODUCTION.md`](VERIFY_PRODUCTION.md)
  - Date completed: ________________
  - Issues: _______________________________________________

- [ ] **Component Testing**: TEST_COMPONENTS_STAGING.md fully completed
  - Reference: [`infra/TEST_COMPONENTS_STAGING.md`](TEST_COMPONENTS_STAGING.md)
  - All components: Prometheus, Grafana, Loki, AlertManager
  - Date completed: ________________

- [ ] **Data Validation**: VALIDATE_DATA_STAGING.md fully completed
  - Reference: [`infra/VALIDATE_DATA_STAGING.md`](VALIDATE_DATA_STAGING.md)
  - Metrics, logs, and storage validated
  - Date completed: ________________

- [ ] **Dashboard Validation**: VALIDATE_DASHBOARDS_STAGING.md fully completed
  - Reference: [`infra/VALIDATE_DASHBOARDS_STAGING.md`](VALIDATE_DASHBOARDS_STAGING.md)
  - All 3 dashboards tested
  - Date completed: ________________

- [ ] **Alert Testing**: VALIDATE_ALERTS_STAGING.md fully completed
  - Reference: [`infra/VALIDATE_ALERTS_STAGING.md`](VALIDATE_ALERTS_STAGING.md)
  - Slack routing, grouping, silencing tested
  - Date completed: ________________

- [ ] **Failure Scenarios**: TEST_FAILURE_SCENARIOS_STAGING.md fully completed
  - Reference: [`infra/TEST_FAILURE_SCENARIOS_STAGING.md`](TEST_FAILURE_SCENARIOS_STAGING.md)
  - Pod failure, storage failure, network failure tested
  - Date completed: ________________

- [ ] **Integration Tests**: TEST_INTEGRATION_STAGING.md fully completed
  - Reference: [`infra/TEST_INTEGRATION_STAGING.md`](TEST_INTEGRATION_STAGING.md)
  - End-to-end flows tested
  - Date completed: ________________

### Documentation Review
- [ ] **Architecture Documentation**: OBSERVABILITY_STACK_ARCHITECTURE.md reviewed and approved
  - Reference: [`plans/OBSERVABILITY_STACK_ARCHITECTURE.md`](../plans/OBSERVABILITY_STACK_ARCHITECTURE.md)
  - Reviewed by: ________________
  - Date: ________________

- [ ] **Component Documentation**: All component READMEs complete
  - [ ] Prometheus: [`infra/prometheus/README.md`](prometheus/README.md)
  - [ ] Grafana: [`infra/grafana/README.md`](grafana/README.md)
  - [ ] Loki: [`infra/loki/README.md`](loki/README.md)
  - [ ] AlertManager: [`infra/alertmanager/README.md`](alertmanager/README.md)

- [ ] **Runbook Documentation**: RUNBOOK_OPERATIONS.md reviewed and complete
  - Reference: [`infra/RUNBOOK_OPERATIONS.md`](RUNBOOK_OPERATIONS.md)
  - Covers incident response, SLOs, on-call procedures
  - Reviewed by: ________________
  - Date: ________________

- [ ] **Disaster Recovery**: DISASTER_RECOVERY.md reviewed and complete
  - Reference: [`infra/DISASTER_RECOVERY.md`](DISASTER_RECOVERY.md)
  - Backup/restore procedures tested
  - Reviewed by: ________________
  - Date: ________________

- [ ] **Troubleshooting Guide**: All troubleshooting documentation complete
  - [ ] TROUBLESHOOTING_QUICK_REF.md
  - [ ] FAQ.md
  - Component-specific troubleshooting sections

- [ ] **Operations Quick Start**: OPERATIONS_QUICK_START.md reviewed
  - Reference: [`infra/OPERATIONS_QUICK_START.md`](OPERATIONS_QUICK_START.md)
  - Covers daily operations, common tasks
  - Reviewed by: ________________
  - Date: ________________

### Operational Readiness
- [ ] **SLOs Defined**: Service Level Objectives agreed with business
  - Availability SLO: ☐ 99.5% ☐ 99.9% ☐ Other: _______
  - Latency SLO (p95): ☐ <500ms ☐ <1000ms ☐ Other: _______
  - Error rate SLO: ☐ <0.1% ☐ <1% ☐ Other: _______
  - Approved by Product Manager: ________________ Date: ________
  - Approved by Operations Lead: ________________ Date: ________

- [ ] **On-Call Rotation Established**: Schedule created for operations team
  - Primary on-call: ________________
  - Secondary on-call: ________________
  - Escalation path documented: ☐ Yes ☐ No
  - Page schedule: ________________

- [ ] **Alert Escalation Policies**: Clear escalation for alert severity
  - Informational: ________________
  - Warning: ________________
  - Critical: ________________
  - Approved by Operations Lead: ________________ Date: ________

- [ ] **Access Provisioned**: Operations team has all necessary access
  - [ ] Kubernetes cluster access (kubectl)
  - [ ] AWS console access (if on AWS)
  - [ ] Grafana admin access
  - [ ] AlertManager access
  - [ ] Slack #monitoring-alerts channel
  - [ ] PagerDuty (production only)
  - [ ] Relevant service accounts created
  - Provisioned by: ________________ Date: ________

- [ ] **Cost Budget Approved**: Infrastructure cost approved ($351/month for 2 clusters)
  - Cost breakdown documented: ☐ Yes ☐ No
  - Reference: ARCHITECTURE_SUMMARY.md
  - Approved by Finance/Manager: ________________ Date: ________
  - Monthly budget: $________________

- [ ] **Change Control Ticket Created**: For production deployment (if applicable)
  - Ticket ID: ________________
  - Ticket URL: ________________
  - Change window scheduled: ________________
  - Approved by: ________________

- [ ] **Backup/Recovery Tested**: Disaster recovery verified
  - EFS snapshot restore tested: ☐ Yes ☐ No
  - Prometheus data restore tested: ☐ Yes ☐ No
  - Loki data restore tested: ☐ Yes ☐ No
  - Recovery time measured: ________________
  - Tested by: ________________ Date: ________

---

## Handoff Meeting (Engineering + Operations)

### Pre-Meeting Preparation
- [ ] **Meeting Scheduled**: Date and time set
  - Date: ________________
  - Time: ________________
  - Duration: 2-3 hours
  - Attendees: Engineering + Operations leads

- [ ] **Materials Printed/Prepared**:
  - [ ] OPERATIONS_QUICK_START.md printed or bookmarked
  - [ ] RUNBOOK_OPERATIONS.md printed or bookmarked
  - [ ] ARCHITECTURE_SUMMARY.md printed or bookmarked
  - [ ] TROUBLESHOOTING_QUICK_REF.md accessible
  - [ ] Component READMEs accessible
  - [ ] Live environment access confirmed (terminal/laptop)

### Meeting Agenda & Execution
- [ ] **Architecture Overview** (15 min)
  - Walk through ARCHITECTURE_SUMMARY.md
  - Explain data flow and component roles
  - Q&A: _____________________________________________________

- [ ] **Prometheus Deep Dive** (15 min)
  - Explain metrics collection and retention
  - Show targets and scrape configuration
  - Demo querying and creating custom queries
  - Q&A: _____________________________________________________

- [ ] **Grafana Dashboards** (15 min)
  - Walk through all 3 operational dashboards
  - Explain panel types and queries
  - Show how to add custom panels
  - Q&A: _____________________________________________________

- [ ] **Loki & Logs** (15 min)
  - Explain log collection via Promtail
  - Demo LogQL queries in Grafana Explore
  - Show log retention and search
  - Q&A: _____________________________________________________

- [ ] **AlertManager & Alerting** (15 min)
  - Walk through alert rules and evaluation
  - Explain routing to Slack/PagerDuty
  - Demo silencing and inhibition
  - Show AlertManager UI and clustering
  - Q&A: _____________________________________________________

- [ ] **High Availability & Failover** (10 min)
  - Explain pod anti-affinity and PDBs
  - Demo pod failure recovery
  - Walk through storage strategy
  - Q&A: _____________________________________________________

- [ ] **Incident Response & Runbooks** (15 min)
  - Walk through RUNBOOK_OPERATIONS.md
  - Explain SLO targets and monitoring
  - Demo how to investigate issues
  - Q&A: _____________________________________________________

- [ ] **Disaster Recovery & Backup** (10 min)
  - Explain backup strategy (daily EFS snapshots)
  - Walk through DISASTER_RECOVERY.md
  - Demo snapshot restore (if safe)
  - Q&A: _____________________________________________________

- [ ] **Operations Access Verification**
  - [ ] Can operations team access Kubernetes? (`kubectl get pods -n monitoring`)
  - [ ] Can operations team access Grafana UI?
  - [ ] Can operations team access AlertManager UI?
  - [ ] Can operations team access Prometheus UI?
  - [ ] Can operations team access Slack #monitoring-alerts?
  - [ ] Can operations team access on-call tools (PagerDuty)?

- [ ] **Q&A & Documentation Review**
  - Operations team confirms all documentation understood
  - Any missing documentation identified: _______________________________________________________________
  - Notes from operations team: _____________________________________________________________________

### Sign-Off from Meeting
- [ ] **Attendees Confirm Understanding**:
  - Engineering Lead: ________________ (Print name) ☐ Confirmed
  - Operations Lead: ________________ (Print name) ☐ Confirmed
  - Product Manager (if present): ________________ ☐ Confirmed

- [ ] **Outstanding Questions Documented**:
  - Question 1: _______________________________________________________________
  - Answer/Owner: _______________________________________________________________
  - Question 2: _______________________________________________________________
  - Answer/Owner: _______________________________________________________________

---

## Post-Handoff (Operations Team - Weeks 1-2)

### Verification & Ownership Transfer

- [ ] **FINAL_VERIFICATION.md Signed Off**
  - Operations team completes FINAL_VERIFICATION.md in their own environment
  - All sections marked ✓
  - Date completed: ________________
  - Verified by: ________________

- [ ] **Live Incident Response Drill** (Week 1)
  - Simulate high latency alert → ops investigates and documents findings
  - Result: ___________________________________________________________________
  - Issues found: ________________________________________________________________
  - Time to respond: ________________

- [ ] **Failover Drill** (Week 1)
  - Kill one pod → verify other replicas handle traffic
  - Kill PVC (simulated) → verify graceful degradation
  - Restore and verify data consistency
  - Result: ___________________________________________________________________
  - Issues found: ________________________________________________________________

- [ ] **Runbook Procedure Practice** (Week 1)
  - Run through 3 runbook scenarios:
    1. Scenario: _________________ → Result: _________________ ☐ Pass ☐ Fail
    2. Scenario: _________________ → Result: _________________ ☐ Pass ☐ Fail
    3. Scenario: _________________ → Result: _________________ ☐ Pass ☐ Fail
  - Issues found: ________________________________________________________________

- [ ] **On-Call Alerting Test** (Week 1)
  - Create test alert and send to on-call engineer via PagerDuty (prod) or Slack (staging)
  - Verify on-call engineer received page/notification
  - Time to alert: ________________
  - Time acknowledged: ________________

- [ ] **Meta-Monitoring Setup**
  - Reference: [`infra/META_MONITORING.md`](META_MONITORING.md)
  - Set up monitoring of the monitoring components themselves
  - Alerts configured for monitoring system health
  - Date completed: ________________

- [ ] **Weekly Knowledge Transfer Session 1** (Week 1)
  - 30-min sync with engineering
  - Topics covered: ________________________________________________________________
  - Action items: ________________________________________________________________

### Shadowing & Ownership

- [ ] **Shadowing Phase** (Weeks 1-2)
  - Engineering shadows operations for 1 week
  - Dates: ________________ to ________________
  - Shift covered: ☐ Business hours ☐ Off-hours ☐ Both
  - Handoff notes: ________________________________________________________________

- [ ] **Ownership Handoff**
  - Operations team leads first incident response (with engineering observing)
  - Incident date: ________________
  - Issue: ________________________________________________________________
  - Resolution: ________________________________________________________________
  - Engineering feedback: ________________________________________________________________
  - ☐ Handoff successful

- [ ] **Weekly Knowledge Transfer Session 2** (Week 2)
  - 30-min sync with engineering
  - Topics covered: ________________________________________________________________
  - Action items: ________________________________________________________________

### Documentation & Procedures

- [ ] **Dashboard Access Verified**
  - Staging Grafana accessible: http://staging-grafana:3000 ☐ Yes ☐ No
  - Production Grafana accessible: http://prod-grafana:3000 ☐ Yes ☐ No
  - Shortcuts bookmarked in browser
  - Bookmark folder: "OpenClaw Monitoring"

- [ ] **Runbooks Printed/Bookmarked**
  - All runbooks bookmarked or printed
  - [ ] OPERATIONS_QUICK_START.md - printed ☐ or bookmarked ☐
  - [ ] RUNBOOK_OPERATIONS.md - printed ☐ or bookmarked ☐
  - [ ] TROUBLESHOOTING_QUICK_REF.md - printed ☐ or bookmarked ☐
  - [ ] Component-specific guides - accessible ☐

- [ ] **Notification Channels Verified**
  - Slack channel #monitoring-alerts configured
  - Alerts being sent to channel: ☐ Yes ☐ No
  - Mute settings appropriate: ☐ Yes ☐ No
  - PagerDuty integration active (prod): ☐ Yes ☐ N/A
  - Escalation policy configured: ☐ Yes ☐ N/A

- [ ] **SLO Dashboard Created**
  - Dashboard showing SLO attainment (weekly/monthly)
  - Refreshed: ☐ Daily ☐ Weekly ☐ On-demand
  - Location: ________________________________________________________________

---

## Post-Handoff (Ongoing - Month 1+)

### Week 3-4 Checkpoints

- [ ] **Operational Stability Check**
  - No critical incidents: ☐ Yes ☐ No
  - SLO targets being met: ☐ Yes ☐ No (current: _____)
  - Alert noise level acceptable: ☐ Yes ☐ No
  - Storage growth on track: ☐ Yes ☐ No
  - Date assessed: ________________
  - Assessed by: ________________

- [ ] **Alert Tuning**
  - Alert thresholds reviewed for accuracy
  - Changes made: ________________________________________________________________
  - Approved by: ________________
  - Date: ________________

- [ ] **Documentation Updates**
  - Any missing documentation added
  - Any unclear sections clarified
  - Updates committed: ☐ Yes ☐ No
  - Date: ________________

- [ ] **Monthly SLO Report**
  - Week 1 SLO attainment: ________________
  - Week 2 SLO attainment: ________________
  - Week 3 SLO attainment: ________________
  - Week 4 SLO attainment: ________________
  - Monthly average: ________________
  - Targets met: ☐ Yes ☐ No
  - Date submitted: ________________
  - Submitted by: ________________

### Ownership Confirmation

- [ ] **Operations Team Ready for Independence**
  - Can troubleshoot common issues independently: ☐ Yes ☐ No
  - Confident responding to incidents: ☐ Yes ☐ No
  - Comfortable scaling components if needed: ☐ Yes ☐ No
  - No longer requires daily engineering support: ☐ Yes ☐ No
  - Date assessed: ________________

---

## Sign-Off

### Pre-Handoff Sign-Off

**Engineering Verification:**
- Name: ________________________________
- Title: ________________________________
- Signature: ____________________________
- Date: ________________________________

**Engineering Lead (if different):**
- Name: ________________________________
- Title: ________________________________
- Signature: ____________________________
- Date: ________________________________

### Handoff Meeting Sign-Off

**Engineering Representative:**
- Name: ________________________________
- Signature: ____________________________
- Date: ________________________________

**Operations Representative:**
- Name: ________________________________
- Signature: ____________________________
- Date: ________________________________

**Product Manager (if applicable):**
- Name: ________________________________
- Signature: ____________________________
- Date: ________________________________

### Post-Handoff Completion Sign-Off

**Operations Lead:**
- Name: ________________________________
- Signature: ____________________________
- Date: ________________________________

**Handoff Status:** ☐ Complete ☐ Partial ☐ Blockers remain

**Blockers (if any):**
- Blocker 1: ________________________________________________________________
  - Target resolution date: ________________
  - Owner: ________________

- Blocker 2: ________________________________________________________________
  - Target resolution date: ________________
  - Owner: ________________

---

## Appendix: Communication Plan

### Escalation Path
**Primary (Warning):** ________________ (Phone: _____________ Slack: ____________)  
**Secondary (Critical):** ________________ (Phone: _____________ Slack: ____________)  
**Manager:** ________________ (Phone: _____________ Slack: ____________)  

### Handoff Communication Template
To be sent to team at handoff completion:

```
Subject: Observability Stack Handoff - Operational Ownership Transfer

Hi team,

The observability stack (Prometheus, Grafana, Loki, AlertManager) has been successfully 
handed off to the Operations team effective [DATE].

Operations team is now the primary point of contact for:
- Incident response
- Dashboard and alert management
- Capacity planning
- Troubleshooting

Engineering will remain available for:
- Architecture changes
- Component upgrades
- Emergency escalations (≥Sev1)

SLO targets:
- Availability: [TARGET]
- Latency (p95): [TARGET]
- Error rate: [TARGET]

Key documentation:
- Quick start: infra/OPERATIONS_QUICK_START.md
- Runbooks: infra/RUNBOOK_OPERATIONS.md
- Troubleshooting: infra/TROUBLESHOOTING_QUICK_REF.md
- Architecture: infra/ARCHITECTURE_SUMMARY.md

On-call rotation: [SCHEDULE_LINK]

Questions? See FAQ: infra/FAQ.md or reach out to [CONTACT].

Thanks,
[ENGINEERING_LEAD]
```

---

## Notes

**Handoff Lessons Learned:**
- ________________________________________________________________
- ________________________________________________________________

**Action Items for Future Handoffs:**
- [ ] ________________________________________________________________
- [ ] ________________________________________________________________

**Contact Information for Post-Handoff Support:**
- Engineering Lead: ________________ | Slack: ________________
- Operations Lead: ________________ | Slack: ________________
- On-Call Primary: ________________ | Phone: ________________
