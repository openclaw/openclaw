---
summary: "Penetration testing workflows and offensive security operations with OpenClaw"
read_when:
  - Running penetration tests
  - Automating red team exercises
  - Developing exploits and payloads
title: "Penetration Testing"
---

# Penetration Testing with OpenClaw

OpenClaw provides AI-powered automation for penetration testing and offensive security operations. Use AI agents to automate reconnaissance, exploit development, payload generation, and post-exploitation workflows.

## Overview

OpenClaw's penetration testing capabilities enable:

- **Automated Reconnaissance**: Subdomain enumeration, port scanning, service detection
- **Exploit Development**: AI-assisted exploit creation and testing
- **Payload Generation**: Reverse shells, web shells, and custom payloads
- **Post-Exploitation**: Automated post-exploitation workflows
- **Report Generation**: Comprehensive penetration test reports
- **Tool Integration**: Metasploit, Burp Suite, Nmap, Shodan, Censys, and more

## Quick Start

### Basic Pen Test Workflow

```bash
# Start OpenClaw gateway
openclaw gateway --port 18789

# Run reconnaissance
openclaw agent --message "Perform reconnaissance on example.com: subdomain enumeration, port scanning, and service detection"

# Develop exploit
openclaw agent --message "Analyze the vulnerability at example.com:8080 and develop an exploit"

# Generate payload
openclaw agent --message "Generate a reverse shell payload for Linux x64"

# Post-exploitation
openclaw agent --message "After gaining access, enumerate the system and identify privilege escalation paths"
```

## Penetration Testing Tools

### Reconnaissance

**Subdomain Enumeration**

```json
pentest_recon({
  target: "example.com",
  type: "subdomain",
  tools: ["amass", "subfinder", "dnsrecon"]
})
```

**Port Scanning**

```json
pentest_recon({
  target: "192.0.2.1",
  type: "port_scan",
  ports: "1-65535",
  tools: ["nmap"]
})
```

**Service Detection**

```json
pentest_recon({
  target: "192.0.2.1",
  type: "service_detection",
  ports: [80, 443, 8080]
})
```

### Exploit Development

**Vulnerability Analysis**

```json
pentest_exploit({
  target: "http://example.com:8080",
  vulnerability: "CVE-2024-XXXX",
  action: "analyze"
})
```

**Exploit Development**

```json
pentest_exploit({
  target: "http://example.com:8080",
  vulnerability: "CVE-2024-XXXX",
  action: "develop",
  language: "python"
})
```

**Exploit Testing**

```json
pentest_exploit({
  target: "http://example.com:8080",
  exploit: "exploit.py",
  action: "test"
})
```

### Payload Generation

**Reverse Shell**

```json
pentest_payload({
  type: "reverse_shell",
  platform: "linux",
  architecture: "x64",
  lhost: "192.0.2.100",
  lport: 4444,
  format: "python"
})
```

**Web Shell**

```json
pentest_payload({
  type: "web_shell",
  language: "php",
  features: ["file_upload", "command_execution"]
})
```

**Custom Payload**

```json
pentest_payload({
  type: "custom",
  template: "meterpreter",
  encoder: "shikata_ga_nai",
  iterations: 5
})
```

### Post-Exploitation

**System Enumeration**

```json
pentest_post_exploit({
  session: "session_123",
  action: "enumerate",
  scope: ["system", "network", "users"]
})
```

**Privilege Escalation**

```json
pentest_post_exploit({
  session: "session_123",
  action: "privilege_escalation",
  platform: "linux"
})
```

**Persistence**

```json
pentest_post_exploit({
  session: "session_123",
  action: "persistence",
  method: "cron"
})
```

## Tool Integrations

### Metasploit Framework

```bash
# Metasploit integration
openclaw agent --message "Use Metasploit to exploit CVE-2024-XXXX on 192.0.2.1"
```

### Burp Suite

```bash
# Burp Suite integration for web application testing
openclaw agent --message "Use Burp Suite to scan http://example.com for vulnerabilities"
```

### Nmap

```bash
# Nmap integration for network scanning
openclaw agent --message "Run Nmap scan on 192.0.2.0/24 with service detection"
```

### Shodan / Censys

```bash
# Shodan integration for internet-wide scanning
openclaw agent --message "Search Shodan for Apache servers running on port 443"
```

## Workflow Templates

### Standard Pen Test Workflow

1. **Reconnaissance**
   - Subdomain enumeration
   - Port scanning
   - Service detection
   - Technology stack identification

2. **Vulnerability Assessment**
   - Automated vulnerability scanning
   - Manual testing
   - Exploit development

3. **Exploitation**
   - Exploit execution
   - Payload delivery
   - Initial access

4. **Post-Exploitation**
   - System enumeration
   - Privilege escalation
   - Lateral movement
   - Data exfiltration simulation

5. **Reporting**
   - Vulnerability documentation
   - Exploit proof-of-concept
   - Risk assessment
   - Remediation recommendations

### Web Application Pen Test

```bash
# Web application penetration test
openclaw agent --message "Perform a comprehensive web application penetration test on https://example.com. Include OWASP Top 10 testing, authentication bypass attempts, and API security testing."
```

### Network Pen Test

```bash
# Network penetration test
openclaw agent --message "Perform a network penetration test on 192.0.2.0/24. Include port scanning, service enumeration, and vulnerability assessment."
```

## Report Generation

Generate comprehensive penetration test reports:

```bash
openclaw agent --message "Generate a penetration test report for the assessment of example.com. Include executive summary, methodology, findings, risk ratings, and remediation recommendations."
```

Report includes:

- Executive summary
- Methodology and scope
- Vulnerability findings with CVSS scores
- Exploit proof-of-concepts
- Risk assessment
- Remediation recommendations
- Appendices (logs, screenshots, etc.)

## Best Practices

1. **Scope Definition**: Always define clear scope and rules of engagement
2. **Documentation**: Document all findings, exploits, and methodologies
3. **Ethical Considerations**: Only test systems you own or have explicit permission to test
4. **Data Handling**: Securely handle sensitive data discovered during testing
5. **Reporting**: Provide clear, actionable remediation recommendations

## Security Considerations

- **Isolation**: Run pen testing agents in isolated environments
- **Data Protection**: Encrypt sensitive data and findings
- **Access Control**: Use strong authentication for pen testing tools
- **Audit Logging**: Maintain comprehensive audit logs of all activities

## Related Documentation

- [Cyber Offense: Understanding the Attacker Mindset](/security/cyber-offense) - Learn how attackers think and operate
- [Red Team Workflows](/security/red-team)
- [Threat Intelligence](/cybersecurity/threat-intelligence)
- [Security Audit](/cli/security)
- [Tool Integrations](/security/integrations)
