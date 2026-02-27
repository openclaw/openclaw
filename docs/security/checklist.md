---
title: Security Checklist
description: Pre-flight and ongoing security checklist for OpenClaw
---

# Security Checklist

## Before First Use

Run these checks before connecting OpenClaw to any real accounts or services.

- [ ] **All API keys stored in vault or .env** — never pasted into chat

  ```bash
  openclaw security credentials status
  ```

- [ ] **Log redaction enabled**

  ```bash
  openclaw config get logging.redactSensitive   # should be "on"
  openclaw config set logging.redactSensitive on
  ```

- [ ] **Gateway bound to loopback** (or auth configured if network access needed)

  ```bash
  openclaw doctor   # check "Security" section
  ```

- [ ] **Sandbox mode enabled**

  ```bash
  openclaw config get agents.defaults.sandbox.mode   # should be "all"
  ```

- [ ] **Security audit passes clean**

  ```bash
  openclaw security audit --deep
  ```

- [ ] **Security health shows GOOD**

  ```bash
  openclaw security health
  ```

- [ ] **Any installed skills scanned before use**

  ```bash
  openclaw skill scan /path/to/skill
  ```

---

## Weekly Checks

- [ ] **Review security events from the past week**

  ```bash
  openclaw security monitoring events --since 7d
  ```

- [ ] **Check for critical events**

  ```bash
  openclaw security monitoring events --severity critical
  ```

- [ ] **Verify no credentials in recent chat logs**

  ```bash
  grep -r "sk-ant-\|sk-\|xoxb-\|xapp-" ~/.openclaw/agents/*/sessions/ 2>/dev/null | wc -l
  ```

  If output is non-zero, rotate affected keys immediately.

- [ ] **Check monitor runner is active**

  ```bash
  openclaw security monitoring status
  ```

- [ ] **Review security posture**

  ```bash
  openclaw security health
  ```

---

## Monthly Checks

- [ ] **Rotate all provider API keys**

  ```bash
  openclaw security credentials status          # see which are due
  openclaw security credentials rotate --name <name> --scope provider
  # or rotate all overdue at once:
  openclaw security health --fix
  ```

- [ ] **Re-scan all installed skills**

  ```bash
  openclaw plugins list
  openclaw skill scan ~/.openclaw/extensions/<skill-name>
  ```

- [ ] **Prune old session logs** (30+ days)

  ```bash
  openclaw logs prune --older-than 30d
  ```

- [ ] **Run full security audit**

  ```bash
  openclaw security audit --deep
  ```

- [ ] **Run doctor**

  ```bash
  openclaw doctor
  ```

- [ ] **Update OpenClaw**

  ```bash
  openclaw update
  ```

- [ ] **Review channel allowlists** — remove users who should no longer have access

  ```bash
  openclaw doctor   # check channel DM policy warnings
  ```

---

## After a Suspected Incident

If you suspect a credential was exposed or unusual activity occurred:

1. **Rotate all API keys immediately**

   ```bash
   openclaw security health --fix
   ```

   Then manually rotate provider keys at their respective consoles.

2. **Review security events for the incident window**

   ```bash
   openclaw security monitoring events --since 24h --severity critical
   openclaw security monitoring events --since 24h --severity warn
   ```

3. **Check session files for exposed credentials**

   ```bash
   grep -r "sk-ant-\|sk-\|xoxb-\|xapp-" ~/.openclaw/agents/*/sessions/ 2>/dev/null
   ```

4. **Purge affected sessions**

   ```bash
   # After backing up anything needed
   rm ~/.openclaw/agents/*/sessions/<affected-session>.jsonl
   ```

5. **Run a full security audit**

   ```bash
   openclaw security audit --deep --fix
   ```

6. **Re-scan all skills** — an injection or exfiltration attempt may have come through a skill

   ```bash
   openclaw plugins list
   openclaw skill scan ~/.openclaw/extensions/
   ```

7. **Check audit log integrity**

   ```bash
   openclaw security health   # look for "BROKEN" in audit integrity row
   ```

---

## Quick Reference

| Command                                | What it checks                                          |
| -------------------------------------- | ------------------------------------------------------- |
| `openclaw security health`             | Unified posture: vault + monitoring + injection defense |
| `openclaw security audit`              | Config foot-guns, filesystem permissions                |
| `openclaw security audit --deep`       | Full audit including live gateway probe                 |
| `openclaw security credentials status` | Vault contents, rotation due dates                      |
| `openclaw security monitoring status`  | Runner, event counts, session risk                      |
| `openclaw security monitoring events`  | Recent security events                                  |
| `openclaw doctor`                      | Full system health including security                   |
| `openclaw doctor --fix`                | Auto-repair common issues                               |
