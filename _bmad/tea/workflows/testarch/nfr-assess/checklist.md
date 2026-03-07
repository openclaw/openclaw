# Non-Functional Requirements Assessment - Validation Checklist

**Workflow:** `testarch-nfr`
**Purpose:** Ensure comprehensive and evidence-based NFR assessment with actionable recommendations

---

Note: `nfr-assess` evaluates existing evidence; it does not run tests or CI workflows.

## Prerequisites Validation

- [ ] Implementation is deployed and accessible for evaluation
- [ ] Evidence sources are available (test results, metrics, logs, CI results)
- [ ] NFR categories are determined (performance, security, reliability, maintainability, custom)
- [ ] Evidence directories exist and are accessible (`test_results_dir`, `metrics_dir`, `logs_dir`)
- [ ] Knowledge base is loaded (nfr-criteria, ci-burn-in, test-quality)

---

## Context Loading

- [ ] Tech-spec.md loaded successfully (if available)
- [ ] PRD.md loaded (if available)
- [ ] Story file loaded (if applicable)
- [ ] Relevant knowledge fragments loaded from `tea-index.csv`:
  - [ ] `nfr-criteria.md`
  - [ ] `ci-burn-in.md`
  - [ ] `test-quality.md`
  - [ ] `playwright-config.md` (if using Playwright)

---

## NFR Categories and Thresholds

### Performance

- [ ] Response time threshold defined or marked as UNKNOWN
- [ ] Throughput threshold defined or marked as UNKNOWN
- [ ] Resource usage thresholds defined or marked as UNKNOWN
- [ ] Scalability requirements defined or marked as UNKNOWN

### Security

- [ ] Authentication requirements defined or marked as UNKNOWN
- [ ] Authorization requirements defined or marked as UNKNOWN
- [ ] Data protection requirements defined or marked as UNKNOWN
- [ ] Vulnerability management thresholds defined or marked as UNKNOWN
- [ ] Compliance requirements identified (GDPR, HIPAA, PCI-DSS, etc.)

### Reliability

- [ ] Availability (uptime) threshold defined or marked as UNKNOWN
- [ ] Error rate threshold defined or marked as UNKNOWN
- [ ] MTTR (Mean Time To Recovery) threshold defined or marked as UNKNOWN
- [ ] Fault tolerance requirements defined or marked as UNKNOWN
- [ ] Disaster recovery requirements defined (RTO, RPO) or marked as UNKNOWN

### Maintainability

- [ ] Test coverage threshold defined or marked as UNKNOWN
- [ ] Code quality threshold defined or marked as UNKNOWN
- [ ] Technical debt threshold defined or marked as UNKNOWN
- [ ] Documentation completeness threshold defined or marked as UNKNOWN

### Custom NFR Categories (if applicable)

- [ ] Custom NFR category 1: Thresholds defined or marked as UNKNOWN
- [ ] Custom NFR category 2: Thresholds defined or marked as UNKNOWN
- [ ] Custom NFR category 3: Thresholds defined or marked as UNKNOWN

---

## Evidence Gathering

### Performance Evidence

- [ ] Load test results collected (JMeter, k6, Gatling, etc.)
- [ ] Application metrics collected (response times, throughput, resource usage)
- [ ] APM data collected (New Relic, Datadog, Dynatrace, etc.)
- [ ] Lighthouse reports collected (if web app)
- [ ] Playwright performance traces collected (if applicable)

### Security Evidence

- [ ] SAST results collected (SonarQube, Checkmarx, Veracode, etc.)
- [ ] DAST results collected (OWASP ZAP, Burp Suite, etc.)
- [ ] Dependency scanning results collected (Snyk, Dependabot, npm audit)
- [ ] Penetration test reports collected (if available)
- [ ] Security audit logs collected
- [ ] Compliance audit results collected (if applicable)

### Reliability Evidence

- [ ] Uptime monitoring data collected (Pingdom, UptimeRobot, StatusCake)
- [ ] Error logs collected
- [ ] Error rate metrics collected
- [ ] CI burn-in results collected (stability over time)
- [ ] Chaos engineering test results collected (if available)
- [ ] Failover/recovery test results collected (if available)
- [ ] Incident reports and postmortems collected (if applicable)

### Maintainability Evidence

- [ ] Code coverage reports collected (Istanbul, NYC, c8, JaCoCo)
- [ ] Static analysis results collected (ESLint, SonarQube, CodeClimate)
- [ ] Technical debt metrics collected
- [ ] Documentation audit results collected
- [ ] Test review report collected (from test-review workflow, if available)
- [ ] Git metrics collected (code churn, commit frequency, etc.)

---

## NFR Assessment with Deterministic Rules

### Performance Assessment

- [ ] Response time assessed against threshold
- [ ] Throughput assessed against threshold
- [ ] Resource usage assessed against threshold
- [ ] Scalability assessed against requirements
- [ ] Status classified (PASS/CONCERNS/FAIL) with justification
- [ ] Evidence source documented (file path, metric name)

### Security Assessment

- [ ] Authentication strength assessed against requirements
- [ ] Authorization controls assessed against requirements
- [ ] Data protection assessed against requirements
- [ ] Vulnerability management assessed against thresholds
- [ ] Compliance assessed against requirements
- [ ] Status classified (PASS/CONCERNS/FAIL) with justification
- [ ] Evidence source documented (file path, scan result)

### Reliability Assessment

- [ ] Availability (uptime) assessed against threshold
- [ ] Error rate assessed against threshold
- [ ] MTTR assessed against threshold
- [ ] Fault tolerance assessed against requirements
- [ ] Disaster recovery assessed against requirements (RTO, RPO)
- [ ] CI burn-in assessed (stability over time)
- [ ] Status classified (PASS/CONCERNS/FAIL) with justification
- [ ] Evidence source documented (file path, monitoring data)

### Maintainability Assessment

- [ ] Test coverage assessed against threshold
- [ ] Code quality assessed against threshold
- [ ] Technical debt assessed against threshold
- [ ] Documentation completeness assessed against threshold
- [ ] Test quality assessed (from test-review, if available)
- [ ] Status classified (PASS/CONCERNS/FAIL) with justification
- [ ] Evidence source documented (file path, coverage report)

### Custom NFR Assessment (if applicable)

- [ ] Custom NFR 1 assessed against threshold with justification
- [ ] Custom NFR 2 assessed against threshold with justification
- [ ] Custom NFR 3 assessed against threshold with justification

---

## Status Classification Validation

### PASS Criteria Verified

- [ ] Evidence exists for PASS status
- [ ] Evidence meets or exceeds threshold
- [ ] No concerns flagged in evidence
- [ ] Quality is acceptable

### CONCERNS Criteria Verified

- [ ] Threshold is UNKNOWN (documented) OR
- [ ] Evidence is MISSING or INCOMPLETE (documented) OR
- [ ] Evidence is close to threshold (within 10%, documented) OR
- [ ] Evidence shows intermittent issues (documented)

### FAIL Criteria Verified

- [ ] Evidence exists BUT does not meet threshold (documented) OR
- [ ] Critical evidence is MISSING (documented) OR
- [ ] Evidence shows consistent failures (documented) OR
- [ ] Quality is unacceptable (documented)

### No Threshold Guessing

- [ ] All thresholds are either defined or marked as UNKNOWN
- [ ] No thresholds were guessed or inferred
- [ ] All UNKNOWN thresholds result in CONCERNS status

---

## Quick Wins and Recommended Actions

### Quick Wins Identified

- [ ] Low-effort, high-impact improvements identified for CONCERNS/FAIL
- [ ] Configuration changes (no code changes) identified
- [ ] Optimization opportunities identified (caching, indexing, compression)
- [ ] Monitoring additions identified (detect issues before failures)

### Recommended Actions

- [ ] Specific remediation steps provided (not generic advice)
- [ ] Priority assigned (CRITICAL, HIGH, MEDIUM, LOW)
- [ ] Estimated effort provided (hours, days)
- [ ] Owner suggestions provided (dev, ops, security)

### Monitoring Hooks

- [ ] Performance monitoring suggested (APM, synthetic monitoring)
- [ ] Error tracking suggested (Sentry, Rollbar, error logs)
- [ ] Security monitoring suggested (intrusion detection, audit logs)
- [ ] Alerting thresholds suggested (notify before breach)

### Fail-Fast Mechanisms

- [ ] Circuit breakers suggested for reliability
- [ ] Rate limiting suggested for performance
- [ ] Validation gates suggested for security
- [ ] Smoke tests suggested for maintainability

---

## Deliverables Generated

### NFR Assessment Report

- [ ] File created at `{test_artifacts}/nfr-assessment.md`
- [ ] Template from `nfr-report-template.md` used
- [ ] Executive summary included (overall status, critical issues)
- [ ] Assessment by category included (performance, security, reliability, maintainability)
- [ ] Evidence for each NFR documented
- [ ] Status classifications documented (PASS/CONCERNS/FAIL)
- [ ] Findings summary included (PASS count, CONCERNS count, FAIL count)
- [ ] Quick wins section included
- [ ] Recommended actions section included
- [ ] Evidence gaps checklist included

### Gate YAML Snippet (if enabled)

- [ ] YAML snippet generated
- [ ] Date included
- [ ] Categories status included (performance, security, reliability, maintainability)
- [ ] Overall status included (PASS/CONCERNS/FAIL)
- [ ] Issue counts included (critical, high, medium, concerns)
- [ ] Blockers flag included (true/false)
- [ ] Recommendations included

### Evidence Checklist (if enabled)

- [ ] All NFRs with MISSING or INCOMPLETE evidence listed
- [ ] Owners assigned for evidence collection
- [ ] Suggested evidence sources provided
- [ ] Deadlines set for evidence collection

### Updated Story File (if enabled and requested)

- [ ] "NFR Assessment" section added to story markdown
- [ ] Link to NFR assessment report included
- [ ] Overall status and critical issues included
- [ ] Gate status included

---

## Quality Assurance

### Accuracy Checks

- [ ] All NFR categories assessed (none skipped)
- [ ] All thresholds documented (defined or UNKNOWN)
- [ ] All evidence sources documented (file paths, metric names)
- [ ] Status classifications are deterministic and consistent
- [ ] No false positives (status correctly assigned)
- [ ] No false negatives (all issues identified)

### Completeness Checks

- [ ] All NFR categories covered (performance, security, reliability, maintainability, custom)
- [ ] All evidence sources checked (test results, metrics, logs, CI results)
- [ ] All status types used appropriately (PASS, CONCERNS, FAIL)
- [ ] All NFRs with CONCERNS/FAIL have recommendations
- [ ] All evidence gaps have owners and deadlines

### Actionability Checks

- [ ] Recommendations are specific (not generic)
- [ ] Remediation steps are clear and actionable
- [ ] Priorities are assigned (CRITICAL, HIGH, MEDIUM, LOW)
- [ ] Effort estimates are provided (hours, days)
- [ ] Owners are suggested (dev, ops, security)

---

## Integration with BMad Artifacts

### With tech-spec.md

- [ ] Tech spec loaded for NFR requirements and thresholds
- [ ] Performance targets extracted
- [ ] Security requirements extracted
- [ ] Reliability SLAs extracted
- [ ] Architectural decisions considered

### With test-design.md

- [ ] Test design loaded for NFR test plan
- [ ] Test priorities referenced (P0/P1/P2/P3)
- [ ] Assessment aligned with planned NFR validation

### With PRD.md

- [ ] PRD loaded for product-level NFR context
- [ ] User experience goals considered
- [ ] Unstated requirements checked
- [ ] Product-level SLAs referenced

---

## Quality Gates Validation

### Release Blocker (FAIL)

- [ ] Critical NFR status checked (security, reliability)
- [ ] Performance failures assessed for user impact
- [ ] Release blocker flagged if critical NFR has FAIL status

### PR Blocker (HIGH CONCERNS)

- [ ] High-priority NFR status checked
- [ ] Multiple CONCERNS assessed
- [ ] PR blocker flagged if HIGH priority issues exist

### Warning (CONCERNS)

- [ ] Any NFR with CONCERNS status flagged
- [ ] Missing or incomplete evidence documented
- [ ] Warning issued to address before next release

### Pass (PASS)

- [ ] All NFRs have PASS status
- [ ] No blockers or concerns exist
- [ ] Ready for release confirmed

---

## Non-Prescriptive Validation

- [ ] NFR categories adapted to team needs
- [ ] Thresholds appropriate for project context
- [ ] Assessment criteria customized as needed
- [ ] Teams can extend with custom NFR categories
- [ ] Integration with external tools supported (New Relic, Datadog, SonarQube, JIRA)

---

## Documentation and Communication

- [ ] NFR assessment report is readable and well-formatted
- [ ] Tables render correctly in markdown
- [ ] Code blocks have proper syntax highlighting
- [ ] Links are valid and accessible
- [ ] Recommendations are clear and prioritized
- [ ] Overall status is prominent and unambiguous
- [ ] Executive summary provides quick understanding

---

## Final Validation

- [ ] All prerequisites met
- [ ] All NFR categories assessed with evidence (or gaps documented)
- [ ] No thresholds were guessed (all defined or UNKNOWN)
- [ ] Status classifications are deterministic and justified
- [ ] Quick wins identified for all CONCERNS/FAIL
- [ ] Recommended actions are specific and actionable
- [ ] Evidence gaps documented with owners and deadlines
- [ ] NFR assessment report generated and saved
- [ ] Gate YAML snippet generated (if enabled)
- [ ] Evidence checklist generated (if enabled)
- [ ] Workflow completed successfully

---

## Sign-Off

**NFR Assessment Status:**

- [ ] ✅ PASS - All NFRs meet requirements, ready for release
- [ ] ⚠️ CONCERNS - Some NFRs have concerns, address before next release
- [ ] ❌ FAIL - Critical NFRs not met, BLOCKER for release

**Next Actions:**

- If PASS ✅: Proceed to `*gate` workflow or release
- If CONCERNS ⚠️: Address HIGH/CRITICAL issues, re-run `*nfr-assess`
- If FAIL ❌: Resolve FAIL status NFRs, re-run `*nfr-assess`

**Critical Issues:** {COUNT}
**High Priority Issues:** {COUNT}
**Concerns:** {COUNT}

---

<!-- Powered by BMAD-CORE™ -->
