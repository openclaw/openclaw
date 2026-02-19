---
summary: "Practical examples of automating threat model extension and red team pen testing"
read_when:
  - Setting up automated security testing
  - Implementing continuous threat model updates
  - Automating red team exercises
title: "Security Automation Examples"
---

# Security Automation Examples

Practical examples of automating threat model extension and red team penetration testing workflows.

## Example 1: Automated Threat Model Updates

### Weekly Threat Model Update Workflow

**Goal**: Automatically extend threat model every week with new threat intelligence and CVEs.

```bash
# Schedule weekly threat model update
openclaw cron add \
  --name "Weekly Threat Model Update" \
  --cron "0 2 * * 1" \
  --session isolated \
  --agent-turn "Run continuous threat model update: monitor threat intelligence for new actors, analyze new CVEs affecting our stack, extend threat model with attack scenarios and defensive controls, generate test cases" \
  --delivery announce
```

**What it does**:

1. Runs every Monday at 2 AM
2. Queries threat intelligence for new actors
3. Monitors CVE database for relevant vulnerabilities
4. Extends threat model with new entries
5. Generates attack scenarios
6. Creates test cases
7. Sends summary to chat

### CVE-Driven Threat Model Extension

```bash
# Automatically extend threat model when new CVE is discovered
openclaw agent --message "Monitor NVD for new critical CVEs affecting Apache, Nginx, and Node.js: when found, automatically extend threat model with attack vectors and defensive controls"
```

**Workflow**:

```bash
# 1. Track vulnerability
vuln_track({
  cve: "CVE-2024-XXXX",
  severity: "critical",
  affected_systems: ["web-server-01", "web-server-02"]
})

# 2. Extend threat model
threat_model_extend({
  source: "cve",
  cve: "CVE-2024-XXXX"
})

# 3. Generate attack scenario
attack_scenario_generate({
  threat_model_id: "cve-2024-xxxx-threat-model"
})

# 4. Create test case
pentest_exploit({
  target: "http://example.com:8080",
  vulnerability: "CVE-2024-XXXX",
  action: "develop"
})
```

## Example 2: Automated Red Team Exercises

### Weekly Red Team Exercise

**Goal**: Run automated red team exercise every week simulating different threat actors.

```bash
# Schedule weekly red team exercise
openclaw cron add \
  --name "Weekly Red Team Exercise" \
  --cron "0 3 * * 1" \
  --session isolated \
  --agent-turn "Run automated red team exercise: rotate through threat actors (Volt Typhoon, Scattered Spider, APT29), generate attack scenario, execute attack chain, generate report, update threat model" \
  --delivery announce
```

**Attack Chain Execution**:

```bash
# 1. Generate attack scenario from threat actor
red_team_automate({
  actor_id: "volt-typhoon",
  scenario: "weekly_exercise_2024_02_19"
})

# 2. Execute reconnaissance
pentest_recon({
  target: "example.com",
  type: "comprehensive"
})

# 3. Vulnerability assessment
pentest_exploit({
  target: "http://example.com:8080",
  action: "analyze"
})

# 4. Post-exploitation
pentest_post_exploit({
  session: "session_123",
  action: "enumerate",
  scope: ["system", "network", "users"]
})

# 5. Generate report
pentest_report({
  target: "example.com",
  format: "markdown"
})
```

### Threat Intelligence-Driven Red Team

```bash
# Use threat intelligence to drive red team exercises
openclaw agent --message "Query threat intelligence for active campaigns: for each campaign, generate red team exercise plan, execute attack scenario, and validate detection capabilities"
```

**Workflow**:

```bash
# 1. Query threat intelligence
threat_list_campaigns({
  status: "active"
})

# 2. For each campaign, generate exercise
red_team_automate({
  actor_id: "volt-typhoon",
  scenario: "campaign_simulation"
})

# 3. Execute attack chain
# (uses pentest tools)

# 4. Validate detection
defense_siem_query({
  provider: "splunk",
  query: "search index=security | search campaign=\"volt-typhoon\""
})
```

## Example 3: Continuous Vulnerability Testing

### Automated CVE Testing

**Goal**: Automatically test new CVEs against our systems.

```bash
# Schedule CVE monitoring and testing
openclaw cron add \
  --name "CVE Monitoring and Testing" \
  --cron "0 */6 * * *" \
  --session isolated \
  --agent-turn "Monitor CVE database for new critical vulnerabilities affecting our technology stack: for each relevant CVE, generate exploit attempt, test against our systems, validate patches if deployed" \
  --delivery announce
```

**Workflow**:

```bash
# 1. Monitor CVEs
vulnerability_driven_test({
  product: "apache",
  version: "2.4.50",
  schedule: "0 */6 * * *"
})

# 2. Check if vulnerable
vuln_check({
  cve: "CVE-2024-XXXX",
  system: "web-server-01"
})

# 3. Generate exploit
pentest_exploit({
  target: "http://example.com:8080",
  vulnerability: "CVE-2024-XXXX",
  action: "develop"
})

# 4. Test exploit
pentest_exploit({
  target: "http://example.com:8080",
  exploit: "exploit.py",
  action: "test"
})

# 5. Validate patch
vuln_patch_status({
  cve: "CVE-2024-XXXX",
  systems: ["web-server-01"]
})
```

## Example 4: Threat Model Generation

### Comprehensive Threat Model for New System

**Goal**: Generate comprehensive threat model when deploying new system.

```bash
# Generate threat model for new system
openclaw agent --message "Generate comprehensive threat model for new web application at app.example.com: analyze attack surface, identify threats from OWASP Top 10 and MITRE ATT&CK, create attack scenarios, recommend defensive controls"
```

**Workflow**:

```bash
# 1. Generate threat model
threat_model_generate({
  target: "app.example.com",
  scope: "web_application",
  sources: ["owasp_top_10", "mitre_attack", "threat_intelligence"]
})

# 2. Extend with threat intelligence
threat_model_extend({
  source: "threat_intelligence",
  actor_id: "scattered-spider"
})

# 3. Generate attack scenarios
attack_scenario_generate({
  threat_model_id: "app-example-com-threat-model"
})

# 4. Create test cases
# (uses pentest tools for each scenario)
```

## Example 5: Multi-Stage Automation

### Complete Security Testing Pipeline

**Goal**: End-to-end automation from threat intelligence to testing to reporting.

```bash
# Complete automation pipeline
openclaw agent --message "Run complete security testing pipeline: 1) Monitor threat intelligence for new actors, 2) Extend threat model, 3) Generate attack scenarios, 4) Execute red team exercises, 5) Validate detection, 6) Generate comprehensive report"
```

**Pipeline Steps**:

```bash
# Step 1: Threat Intelligence Monitoring
threat_track_actor({
  id: "apt-new",
  name: "APT-New",
  ttps: ["T1055", "T1078"]
})

# Step 2: Threat Model Extension
threat_model_extend({
  source: "threat_intelligence",
  actor_id: "apt-new"
})

# Step 3: Attack Scenario Generation
attack_scenario_generate({
  actor_id: "apt-new",
  technique_ids: ["T1055", "T1078"]
})

# Step 4: Red Team Exercise
red_team_automate({
  actor_id: "apt-new",
  scenario: "apt-new-exercise"
})

# Step 5: Detection Validation
defense_siem_query({
  provider: "splunk",
  query: "search index=security | search actor=\"apt-new\""
})

# Step 6: Reporting
pentest_report({
  target: "example.com",
  format: "markdown"
})
```

## Example 6: Scheduled Automation with Cron

### Daily Security Operations

```json5
{
  cron: {
    schedules: [
      {
        name: "daily-threat-intelligence-update",
        schedule: "0 2 * * *",  // Daily at 2 AM
        payload: {
          kind: "agentTurn",
          message: "Update threat intelligence: query for new actors, IOCs, and campaigns, extend threat model"
        },
        sessionTarget: "isolated",
        delivery: { mode: "announce" }
      },
      {
        name: "weekly-red-team-exercise",
        schedule: "0 3 * * 1",  // Monday at 3 AM
        payload: {
          kind: "agentTurn",
          message: "Run weekly red team exercise: rotate threat actors, execute attack chain, generate report"
        },
        sessionTarget: "isolated",
        delivery: { mode: "announce" }
      },
      {
        name: "cve-monitoring",
        schedule: "0 */6 * * *",  // Every 6 hours
        payload: {
          kind: "agentTurn",
          message: "Monitor CVE database for new vulnerabilities, test against our systems"
        },
        sessionTarget: "isolated",
        delivery: { mode: "announce" }
      }
    ]
  }
}
```

## Example 7: Integration with Existing Tools

### Combining OpenClaw Tools with External Security Tools

```bash
# Use OpenClaw to orchestrate external security tools
openclaw agent --message "Orchestrate comprehensive security testing: use Nmap for network scanning, Metasploit for exploitation, Burp Suite for web app testing, and Splunk for log analysis. Coordinate all tools and generate unified report."
```

**Workflow**:

```bash
# 1. Network scanning with Nmap
pentest_nmap({
  target: "192.0.2.0/24",
  scan_type: "comprehensive"
})

# 2. Web app testing with Burp
pentest_burp({
  action: "scan",
  target: "https://example.com"
})

# 3. Exploitation with Metasploit
pentest_metasploit({
  action: "search",
  module: "exploit/windows/smb/ms17_010_eternalblue"
})

# 4. Log analysis with Splunk
defense_splunk({
  action: "query",
  query: "search index=security | stats count by source"
})

# 5. Unified reporting
pentest_report({
  target: "example.com",
  format: "markdown"
})
```

## Best Practices

### 1. Start Small

Begin with simple automations and gradually increase complexity:

```bash
# Start with weekly threat model update
openclaw cron add \
  --name "Simple Threat Model Update" \
  --cron "0 2 * * 1" \
  --session isolated \
  --agent-turn "Extend threat model with new threat intelligence"
```

### 2. Validate Before Automation

Test automation workflows manually before scheduling:

```bash
# Test workflow manually first
openclaw agent --message "Test threat model extension workflow: extend threat model from Volt Typhoon, verify output"
```

### 3. Monitor and Adjust

Regularly review automation results and adjust:

```bash
# Review automation results
openclaw agent --message "Review last week's automated security testing: analyze results, identify improvements, update automation workflows"
```

### 4. Safety Controls

Implement safety controls to prevent production impact:

```bash
# Safety check before execution
openclaw agent --message "Before running red team exercise, verify: 1) Scope is correct, 2) Safety controls are in place, 3) Monitoring is enabled"
```

## Related Documentation

- [Security Automation](/security/automation) - Complete automation guide
- [Penetration Testing](/security/pen-testing) - Pen testing workflows
- [Red Team Operations](/security/red-team) - Red team exercises
- [Threat Intelligence](/cybersecurity/threat-intelligence) - Threat actor tracking
- [Cron Jobs](/automation/cron-jobs) - Scheduling automation
