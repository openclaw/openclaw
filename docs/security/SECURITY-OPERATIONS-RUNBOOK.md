# OpenClaw Security Operations Runbook

**Version**: 1.0
**Last Updated**: 2026-02-16
**Classification**: CONFIDENTIAL - INTERNAL USE ONLY

---

## Table of Contents

1. [Daily Operations](#daily-operations)
2. [Security Monitoring](#security-monitoring)
3. [Incident Response](#incident-response)
4. [Common Security Scenarios](#common-security-scenarios)
5. [Emergency Procedures](#emergency-procedures)
6. [Security Maintenance](#security-maintenance)

---

## Daily Operations

### Morning Security Checklist

**Time Required**: 15 minutes
**Frequency**: Daily at start of business

```bash
# 1. Check security event logs
tail -n 1000 /var/log/openclaw/security.log | grep -E "ERROR|CRITICAL|WARNING"

# 2. Review failed authentication attempts
grep "authentication_failure" /var/log/openclaw/security.log | wc -l

# 3. Check sandbox violations
grep "sandbox_violation" /var/log/openclaw/security.log

# 4. Review rate limiting triggers
grep "rate_limit_exceeded" /var/log/openclaw/security.log | tail -n 50

# 5. Check signature verification failures
grep "signature_verification_failure" /var/log/openclaw/security.log

# 6. Monitor plugin load failures
grep "plugin_load_error" /var/log/openclaw/application.log

# 7. Check system health
curl -s http://localhost:3000/health | jq
```

**Action Items**:

- [ ] Any errors logged? → Investigate immediately
- [ ] Unusual authentication failures? → Check for brute force
- [ ] Sandbox violations? → Review plugin behavior
- [ ] High rate limiting? → Possible DoS attack

---

### Weekly Security Tasks

**Time Required**: 1 hour
**Frequency**: Every Monday morning

1. **Run Security Audit**

   ```bash
   cd openclaw
   node --import tsx scripts/check-http-security.ts
   pnpm test test/security/
   ```

2. **Review Security Metrics**
   - Plugin sandbox violations: Target < 5/week
   - Rate limit triggers: Target < 100/week
   - Authentication failures: Target < 50/week
   - Signature verification failures: Target 0/week

3. **Update Security Dashboard**
   - Screenshot key metrics
   - Update trend analysis
   - Report to security team

4. **Review Plugin Marketplace**
   - Check new plugin submissions
   - Verify all plugins are signed
   - Review plugin permissions

5. **Dependency Updates**
   ```bash
   pnpm outdated
   # Review security advisories
   pnpm audit
   ```

---

### Monthly Security Tasks

**Time Required**: 4 hours
**Frequency**: First week of month

1. **Comprehensive Security Audit**
   - Run full penetration test
   - Review all security configurations
   - Update threat model

2. **Key Rotation Review**
   - Check CSRF secret age (rotate if > 90 days)
   - Review API keys and tokens
   - Audit plugin signing keys

3. **Security Training**
   - Review security incidents from past month
   - Update team on new threats
   - Practice incident response

4. **Documentation Update**
   - Update security procedures
   - Review and update runbook
   - Update incident response playbook

---

## Security Monitoring

### Key Metrics to Monitor

#### 1. Plugin Security Metrics

**Sandbox Violations**

```bash
# Count violations in last 24 hours
grep "sandbox_violation" /var/log/openclaw/security.log | \
  grep "$(date -d '24 hours ago' '+%Y-%m-%d')" | wc -l
```

**Thresholds**:

- < 5/day: Normal
- 5-20/day: Warning - investigate
- > 20/day: Critical - disable affected plugins

**Actions**:

- Review plugin causing violations
- Check if legitimate use case
- Contact plugin developer
- Disable plugin if malicious

---

**Signature Verification Failures**

```bash
# Check signature failures
grep "signature_verification_failure" /var/log/openclaw/security.log | \
  tail -n 20
```

**Thresholds**:

- 0/week: Good
- 1-5/week: Warning - users may have old plugins
- > 5/week: Critical - possible attack

**Actions**:

- Identify which plugins failing
- Check if expired signatures
- Look for tampering attempts
- Alert security team if systematic

---

#### 2. HTTP Security Metrics

**Rate Limiting Triggers**

```bash
# Count rate limit hits
grep "rate_limit_exceeded" /var/log/openclaw/security.log | \
  grep "$(date '+%Y-%m-%d')" | wc -l
```

**Thresholds**:

- < 50/day: Normal
- 50-200/day: Warning - possible bot activity
- > 200/day: Critical - likely DDoS attempt

**Actions**:

- Check if legitimate spike (product launch, viral post)
- Identify attacking IPs
- Implement IP blocking
- Scale up infrastructure if needed

---

**CSRF Protection Triggers**

```bash
# Check CSRF failures
grep "csrf_protection_triggered" /var/log/openclaw/security.log
```

**Threshold**: Should be rare (< 10/day)

**Actions**:

- Check if legitimate user errors (expired tokens)
- Look for systematic attempts
- Review application flow for CSRF token issues

---

#### 3. Authentication Metrics

**Failed Login Attempts**

```bash
# Count failed auth attempts
grep "authentication_failure" /var/log/openclaw/security.log | \
  grep "$(date '+%Y-%m-%d')" | wc -l
```

**Thresholds**:

- < 20/day: Normal user errors
- 20-100/day: Warning - possible brute force
- > 100/day: Critical - active attack

**Actions**:

- Check if attacks from single IP
- Implement temporary IP blocks
- Add CAPTCHA if widespread
- Alert affected users

---

### Automated Monitoring Queries

**Create monitoring script**: `/scripts/security-monitor.sh`

```bash
#!/bin/bash
# Run every hour via cron

LOG_FILE="/var/log/openclaw/security.log"
ALERT_EMAIL="security-team@example.com"
TODAY=$(date '+%Y-%m-%d')

# Check for critical events
CRITICAL=$(grep "$TODAY" "$LOG_FILE" | grep -c "CRITICAL")
if [ "$CRITICAL" -gt 0 ]; then
  echo "CRITICAL: $CRITICAL critical events detected" | \
    mail -s "OpenClaw Security Alert" "$ALERT_EMAIL"
fi

# Check sandbox violations
VIOLATIONS=$(grep "$TODAY" "$LOG_FILE" | grep -c "sandbox_violation")
if [ "$VIOLATIONS" -gt 20 ]; then
  echo "WARNING: $VIOLATIONS sandbox violations today" | \
    mail -s "OpenClaw Sandbox Alert" "$ALERT_EMAIL"
fi

# Check rate limiting
RATE_LIMITS=$(grep "$TODAY" "$LOG_FILE" | grep -c "rate_limit_exceeded")
if [ "$RATE_LIMITS" -gt 200 ]; then
  echo "WARNING: Possible DDoS - $RATE_LIMITS rate limit triggers" | \
    mail -s "OpenClaw Rate Limit Alert" "$ALERT_EMAIL"
fi
```

---

## Incident Response

### Incident Severity Levels

| Level             | Response Time | Escalation          | Examples                               |
| ----------------- | ------------- | ------------------- | -------------------------------------- |
| **P0 - Critical** | < 15 min      | CTO + Security Lead | Active data breach, RCE exploit        |
| **P1 - High**     | < 1 hour      | Security Lead       | Privilege escalation, auth bypass      |
| **P2 - Medium**   | < 4 hours     | Security Team       | XSS, CSRF, suspicious activity         |
| **P3 - Low**      | < 1 day       | On-call Engineer    | Minor vulnerabilities, false positives |

---

### Incident Response Playbook

#### Step 1: Detection & Triage (5-10 minutes)

**Questions to Answer**:

- What type of security event occurred?
- Is it still ongoing?
- What systems are affected?
- How many users are impacted?
- Is data compromised?

**Actions**:

```bash
# 1. Check if still active
tail -f /var/log/openclaw/security.log

# 2. Identify affected components
grep "<incident-signature>" /var/log/openclaw/security.log | \
  awk '{print $5}' | sort | uniq -c

# 3. Check user impact
grep "<incident-signature>" /var/log/openclaw/security.log | \
  grep "user_id" | wc -l

# 4. Assess data exposure
# Review what data the affected component accesses
```

**Determine Severity**: Use table above

---

#### Step 2: Containment (10-30 minutes)

**Immediate Actions**:

**For Plugin Compromise**:

```bash
# 1. Disable affected plugin
echo "plugins:
  disabled:
    - <plugin-id>" >> ~/.openclaw/config.yaml

# 2. Restart service
systemctl restart openclaw

# 3. Verify plugin disabled
curl -s http://localhost:3000/api/plugins | jq '.disabled'
```

**For Authentication Bypass**:

```bash
# 1. Invalidate all sessions
redis-cli FLUSHDB  # If using Redis for sessions

# 2. Force logout all users
# Implementation specific to your auth system

# 3. Temporarily disable registration
echo "auth:
  registrationEnabled: false" >> ~/.openclaw/config.yaml
```

**For DDoS Attack**:

```bash
# 1. Enable aggressive rate limiting
echo "security:
  http:
    rateLimit: 20  # Reduce to 20/15min
    rateLimitWindow: 900000" >> ~/.openclaw/config.yaml

# 2. Block attacking IPs
iptables -A INPUT -s <attacker-ip> -j DROP

# 3. Enable Cloudflare DDoS protection
# Or other CDN/WAF service
```

---

#### Step 3: Investigation (30 minutes - 2 hours)

**Evidence Collection**:

```bash
# 1. Create incident directory
INCIDENT_ID="INC-$(date +%Y%m%d-%H%M%S)"
mkdir -p "/var/log/openclaw/incidents/$INCIDENT_ID"
cd "/var/log/openclaw/incidents/$INCIDENT_ID"

# 2. Collect logs
cp /var/log/openclaw/security.log "security-$(date +%Y%m%d).log"
cp /var/log/openclaw/application.log "application-$(date +%Y%m%d).log"
cp /var/log/openclaw/access.log "access-$(date +%Y%m%d).log"

# 3. Get system snapshot
df -h > system-state.txt
free -m >> system-state.txt
ps aux >> system-state.txt

# 4. Dump current config
cp ~/.openclaw/config.yaml config-snapshot.yaml

# 5. Create incident report template
cat > incident-report.md <<EOF
# Incident Report: $INCIDENT_ID

## Summary
- **Date**: $(date)
- **Severity**:
- **Status**: Under Investigation
- **Reporter**:

## Timeline
- $(date '+%H:%M'): Incident detected

## Impact
- Users affected:
- Systems affected:
- Data exposed:

## Root Cause
TBD

## Resolution
TBD

## Prevention
TBD
EOF
```

**Analysis Steps**:

1. Timeline reconstruction
2. Attack vector identification
3. Scope determination
4. Root cause analysis

---

#### Step 4: Eradication (1-4 hours)

**Remove Threat**:

- Delete malicious plugins
- Patch vulnerabilities
- Remove backdoors
- Clean compromised data

**Verify Clean State**:

```bash
# Run full security audit
pnpm test test/security/
node --import tsx scripts/check-http-security.ts

# Check for remaining artifacts
find . -name "*malicious*" -o -name "*backdoor*"

# Verify configuration
diff ~/.openclaw/config.yaml ~/.openclaw/config.yaml.backup
```

---

#### Step 5: Recovery (1-2 hours)

**Restore Normal Operations**:

1. Re-enable affected services
2. Restore from clean backups if needed
3. Gradually restore user access
4. Monitor closely for 24 hours

**Verification**:

```bash
# 1. Health check
curl http://localhost:3000/health

# 2. Smoke tests
pnpm test:smoke

# 3. Monitor logs
tail -f /var/log/openclaw/security.log

# 4. Check metrics return to normal
```

---

#### Step 6: Post-Incident (1-2 days)

**Required Actions**:

1. Complete incident report
2. Post-mortem meeting
3. Update security procedures
4. Implement preventive measures
5. User notification (if required)

**Incident Report Template**: See `/docs/security/incident-report-template.md`

---

## Common Security Scenarios

### Scenario 1: Malicious Plugin Detected

**Symptoms**:

- Sandbox violations from specific plugin
- Unexpected network requests
- High CPU/memory usage
- User reports suspicious behavior

**Response**:

```bash
# 1. Identify plugin
PLUGIN_ID="<malicious-plugin-id>"

# 2. Immediate disable
echo "plugins:
  disabled:
    - $PLUGIN_ID" >> ~/.openclaw/config.yaml

# 3. Collect evidence
grep "$PLUGIN_ID" /var/log/openclaw/security.log > "/tmp/evidence-$PLUGIN_ID.log"

# 4. Analyze plugin code
cat "plugins/$PLUGIN_ID/index.ts"

# 5. Remove plugin
rm -rf "plugins/$PLUGIN_ID"

# 6. Ban from marketplace
# Update plugin registry to blacklist plugin

# 7. Notify users who installed it
# Send security advisory email
```

**Prevention**:

- Require plugin signing
- Automated security scanning
- Community reporting system

---

### Scenario 2: Unsigned Plugin Attempt

**Symptoms**:

- Signature verification failures in logs
- Users unable to load plugins

**Response**:

```bash
# 1. Check if legitimate (expired signature) or attack
grep "signature_verification_failure" /var/log/openclaw/security.log | tail -n 20

# 2. If expired signatures
# Contact plugin developer to re-sign

# 3. If tampering attempt
# Block the source
# Investigate how tampered plugin was distributed

# 4. Verify production config enforces signing
grep "requireSignature" ~/.openclaw/config.yaml
# Should show: requireSignature: true
```

---

### Scenario 3: Rate Limiting Spike

**Symptoms**:

- Many "rate_limit_exceeded" log entries
- Slow response times
- Legitimate users affected

**Response**:

```bash
# 1. Identify attacking IPs
grep "rate_limit_exceeded" /var/log/openclaw/security.log | \
  grep "$(date '+%Y-%m-%d')" | \
  awk '{print $8}' | sort | uniq -c | sort -rn | head -n 20

# 2. Check if legitimate traffic spike
# (e.g., product launch, viral post)

# 3. If attack, block IPs
for ip in $(cat attacking-ips.txt); do
  iptables -A INPUT -s "$ip" -j DROP
done

# 4. If legitimate, scale up
# Increase rate limits temporarily
echo "security:
  http:
    rateLimit: 200" >> ~/.openclaw/config.yaml

# 5. Monitor
watch -n 5 'tail -n 20 /var/log/openclaw/security.log | grep rate_limit'
```

---

### Scenario 4: Sandbox Escape Attempt

**Symptoms**:

- Sandbox violation logs
- Unexpected file access attempts
- Process spawning failures

**Response**:

```bash
# CRITICAL - Immediate action required

# 1. Disable all untrusted plugins immediately
echo "plugins:
  trustedOnly: true" >> ~/.openclaw/config.yaml
systemctl restart openclaw

# 2. Identify attacking plugin
grep "sandbox_violation" /var/log/openclaw/security.log | tail -n 50

# 3. Collect full evidence
mkdir -p /tmp/sandbox-incident-$(date +%Y%m%d)
grep "sandbox_violation" /var/log/openclaw/security.log > /tmp/sandbox-incident-$(date +%Y%m%d)/violations.log

# 4. Review sandbox configuration
cat src/plugins/plugin-sandbox.ts

# 5. Check isolated-vm version (ensure latest)
pnpm list isolated-vm

# 6. Escalate to security team immediately
# This could indicate a 0-day in isolated-vm

# 7. Do NOT re-enable untrusted plugins until root cause found
```

---

## Emergency Procedures

### Emergency Shutdown

**When to Use**: Active exploitation in progress, data breach confirmed

```bash
#!/bin/bash
# Emergency shutdown script

echo "EMERGENCY SHUTDOWN INITIATED"
echo "Timestamp: $(date)"

# 1. Stop all services
systemctl stop openclaw
systemctl stop openclaw-gateway
systemctl stop openclaw-worker

# 2. Block all external traffic
iptables -P INPUT DROP
iptables -P FORWARD DROP
iptables -A INPUT -i lo -j ACCEPT  # Keep localhost

# 3. Create incident snapshot
INCIDENT_DIR="/var/log/openclaw/incidents/EMERGENCY-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$INCIDENT_DIR"
cp -r /var/log/openclaw/* "$INCIDENT_DIR/"
cp ~/.openclaw/config.yaml "$INCIDENT_DIR/"

# 4. Notify team
echo "EMERGENCY SHUTDOWN - See $INCIDENT_DIR" | \
  mail -s "OpenClaw Emergency Shutdown" security-team@example.com

echo "Services stopped. System isolated. Logs preserved at $INCIDENT_DIR"
echo "Manual intervention required to restart."
```

---

### Emergency Recovery

**After resolving critical incident**:

```bash
#!/bin/bash
# Emergency recovery script

echo "EMERGENCY RECOVERY INITIATED"

# 1. Verify threat eliminated
echo "Checklist:"
echo "- [ ] Root cause identified?"
echo "- [ ] Vulnerability patched?"
echo "- [ ] Malicious code removed?"
echo "- [ ] Clean backup available?"
read -p "All checks passed? (yes/NO) " -r
if [[ ! $REPLY = "yes" ]]; then
  echo "Recovery cancelled - complete checklist first"
  exit 1
fi

# 2. Restore from clean backup if needed
# read -p "Restore from backup? (y/N) " -r
# if [[ $REPLY =~ ^[Yy]$ ]]; then
#   ./scripts/restore-backup.sh latest-clean
# fi

# 3. Update security configuration
# Implement additional protections based on incident

# 4. Re-enable services in stages
systemctl start openclaw-worker
sleep 10
systemctl start openclaw-gateway
sleep 10
systemctl start openclaw

# 5. Monitor closely
tail -f /var/log/openclaw/security.log &
TAIL_PID=$!

# 6. Restore network access
iptables -F  # Clear all rules
iptables -P INPUT ACCEPT
iptables -P FORWARD ACCEPT

echo "Recovery complete. Monitoring logs (PID: $TAIL_PID)"
echo "Monitor for 1 hour before declaring all-clear"
```

---

## Security Maintenance

### Daily Maintenance

- [ ] Review security logs
- [ ] Check metrics dashboard
- [ ] Verify backups completed
- [ ] Monitor system resources

### Weekly Maintenance

- [ ] Run security test suite
- [ ] Review plugin submissions
- [ ] Check for dependency updates
- [ ] Update security dashboard

### Monthly Maintenance

- [ ] Rotate CSRF secrets
- [ ] Review all security configs
- [ ] Run penetration tests
- [ ] Update documentation

### Quarterly Maintenance

- [ ] External security audit
- [ ] Disaster recovery drill
- [ ] Update threat model
- [ ] Security training for team

---

## Appendices

### A. Log Locations

- Security logs: `/var/log/openclaw/security.log`
- Application logs: `/var/log/openclaw/application.log`
- Access logs: `/var/log/openclaw/access.log`
- Audit logs: `/var/log/openclaw/audit.log`

### B. Configuration Files

- Main config: `~/.openclaw/config.yaml`
- Plugin config: `~/.openclaw/plugins.yaml`
- Security config: `~/.openclaw/security.yaml`

### C. Important Scripts

- Deployment: `/scripts/deploy-production.sh`
- Security audit: `/scripts/check-http-security.ts`
- Monitoring: `/scripts/security-monitor.sh`
- Backup: `/scripts/backup.sh`

### D. Emergency Contacts

```
Security Lead: [Name] - [Email] - [Phone]
On-Call Engineer: [Rotation] - [Email] - [Phone]
CTO: [Name] - [Email] - [Phone]
External Security Consultant: [Company] - [Email] - [Phone]
```

### E. Escalation Matrix

| Severity | First Contact | Escalate To   | Escalate After |
| -------- | ------------- | ------------- | -------------- |
| P0       | Security Lead | CTO           | 15 minutes     |
| P1       | On-Call       | Security Lead | 1 hour         |
| P2       | Security Team | Security Lead | 4 hours        |
| P3       | Ticket System | Security Team | 1 day          |

---

**Last Reviewed**: 2026-02-16
**Next Review Due**: 2026-03-16
**Owner**: Security Team
