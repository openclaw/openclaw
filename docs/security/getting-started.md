---
summary: "Getting started with OpenClaw for security operations and penetration testing"
read_when:
  - Setting up OpenClaw for security operations
  - Starting your first penetration test
  - Configuring security tool integrations
title: "Security Operations Getting Started"
---

# Security Operations Getting Started

This guide helps you get started with OpenClaw for security operations, penetration testing, and red/blue team workflows.

## Quick Start

### 1. Install OpenClaw

```bash
npm install -g openclaw@latest
```

### 2. Run Onboarding

```bash
openclaw onboard --install-daemon
```

The onboarding wizard will guide you through:
- Gateway configuration
- Authentication setup (Anthropic/OpenAI recommended)
- Initial workspace setup
- Security tool configuration (optional)

### 3. Start the Gateway

```bash
openclaw gateway --port 18789 --verbose
```

### 4. Verify Installation

```bash
# Check gateway status
openclaw gateway status

# Run security audit
openclaw security audit

# Test agent connection
openclaw agent --message "Hello, test security operations"
```

## Security Operations Setup

### Enable Security Features

Edit `~/.openclaw/openclaw.json`:

```json5
{
  cybersecurity: {
    threatIntelligence: {
      enabled: true,
      storagePath: "~/.openclaw/cybersecurity/threats/",
      autoUpdate: false
    },
    informationSharing: {
      enabled: true,
      format: "stix",
      exportPath: "~/.openclaw/cybersecurity/exports/"
    },
    vulnerabilityManagement: {
      enabled: true,
      nvdApiKey: "your-nvd-api-key" // Optional
    }
  },
  security: {
    pentest: {
      enabled: true,
      workspace: "~/.openclaw/security/pentest/"
    },
    defense: {
      enabled: true,
      siem: {
        provider: "splunk", // or "elastic", "sentinel", "crowdstrike"
        endpoint: "https://your-siem.example.com",
        apiKey: "your-api-key"
      }
    }
  }
}
```

### Configure Security Tool Integrations

#### Metasploit Framework

```bash
# Install Metasploit (if not already installed)
# On macOS: brew install metasploit
# On Linux: apt-get install metasploit-framework

# Configure Metasploit integration
openclaw agent --message "Configure Metasploit integration: set path to msfconsole and verify connection"
```

#### Burp Suite

```bash
# Configure Burp Suite integration
openclaw agent --message "Configure Burp Suite integration: set API endpoint and API key"
```

#### Nmap

```bash
# Nmap is typically pre-installed on most systems
# Verify installation
nmap --version

# Test Nmap integration
openclaw agent --message "Test Nmap integration: scan localhost"
```

#### SIEM Integration (Splunk Example)

```json5
{
  security: {
    defense: {
      siem: {
        provider: "splunk",
        endpoint: "https://splunk.example.com:8089",
        apiKey: "your-splunk-api-key",
        index: "security"
      }
    }
  }
}
```

## Your First Penetration Test

### 1. Define Scope

```bash
openclaw agent --message "Define penetration test scope: target example.com, scope includes web application and network infrastructure, exclude production databases"
```

### 2. Run Reconnaissance

```bash
openclaw agent --message "Perform reconnaissance on example.com: subdomain enumeration, port scanning, and service detection"
```

### 3. Vulnerability Assessment

```bash
openclaw agent --message "Assess vulnerabilities on example.com: run automated scans and manual testing"
```

### 4. Exploit Development

```bash
openclaw agent --message "Develop exploit for CVE-2024-XXXX on example.com:8080"
```

### 5. Generate Report

```bash
openclaw agent --message "Generate penetration test report: include executive summary, methodology, findings, risk ratings, and remediation recommendations"
```

## Your First Threat Hunt

### 1. Form Hypothesis

```bash
openclaw agent --message "Form threat hunting hypothesis: hunt for living-off-the-land techniques using certutil, bitsadmin, and regsvr32"
```

### 2. Collect Data

```bash
openclaw agent --message "Collect data for threat hunt: gather process execution logs, network traffic, and system logs from last 7 days"
```

### 3. Analyze Data

```bash
openclaw agent --message "Analyze collected data: search for indicators of living-off-the-land techniques"
```

### 4. Investigate Findings

```bash
openclaw agent --message "Investigate findings: correlate suspicious activity with threat intelligence and determine if incident response is needed"
```

## Your First Incident Response

### 1. Triage Alert

```bash
openclaw agent --message "Triage security alert ALERT-2024-001: assess severity, determine scope, and assign to analyst"
```

### 2. Investigate Incident

```bash
openclaw agent --message "Investigate incident INC-2024-001: analyze logs, check IOCs, and determine root cause"
```

### 3. Contain Threat

```bash
openclaw agent --message "Contain incident INC-2024-001: isolate affected systems, block malicious IPs, and revoke compromised credentials"
```

### 4. Remediate

```bash
openclaw agent --message "Remediate incident INC-2024-001: remove malware, patch vulnerabilities, and reset credentials"
```

### 5. Post-Incident

```bash
openclaw agent --message "Post-incident activities for INC-2024-001: root cause analysis, lessons learned, and update playbooks"
```

## Security Workflows

### Red Team Exercise

```bash
# Simulate APT attack
openclaw agent --message "Simulate Volt Typhoon attack: pre-positioning on critical infrastructure, living off the land techniques, and long-term persistence"

# Execute attack chain
openclaw agent --message "Execute attack chain: initial access via phishing, privilege escalation, lateral movement, and data exfiltration"
```

### Blue Team Operations

```bash
# Threat detection
openclaw agent --message "Detect threats: analyze security logs for suspicious activity and known IOCs"

# Incident response
openclaw agent --message "Respond to incident: triage, investigate, contain, and remediate security incident"

# Threat hunting
openclaw agent --message "Threat hunt: proactively search for threats and anomalies in network and endpoint data"
```

## Next Steps

- [Cyber Offense: Understanding the Attacker Mindset](/security/cyber-offense) - Learn how attackers think and operate
- [Penetration Testing Guide](/security/pen-testing) - Comprehensive pen testing workflows
- [Red Team Operations](/security/red-team) - Red team exercises and adversary simulation
- [Blue Team Operations](/security/blue-team) - Blue team workflows and SOC operations
- [Threat Intelligence](/cybersecurity/threat-intelligence) - Threat actor and IOC tracking
- [Security Audit](/cli/security) - Security configuration audit

## Troubleshooting

### Security Tools Not Found

```bash
# Check if security tools are installed
which nmap
which msfconsole
which burpsuite

# Install missing tools
# macOS: brew install nmap metasploit
# Linux: apt-get install nmap metasploit-framework
```

### SIEM Connection Issues

```bash
# Test SIEM connection
openclaw agent --message "Test SIEM connection: verify endpoint, API key, and network connectivity"

# Check SIEM configuration
cat ~/.openclaw/openclaw.json | jq '.security.defense.siem'
```

### Permission Issues

```bash
# Run security audit
openclaw security audit

# Fix permission issues
openclaw security audit --fix
```

## Best Practices

1. **Scope Definition**: Always define clear scope and rules of engagement
2. **Documentation**: Document all activities, findings, and methodologies
3. **Ethical Considerations**: Only test systems you own or have explicit permission to test
4. **Data Protection**: Encrypt sensitive data and findings
5. **Access Control**: Use strong authentication for security tools
6. **Audit Logging**: Maintain comprehensive audit logs of all activities

## Support

- [Security Documentation](/security) - Complete security documentation
- [Discord](https://discord.gg/clawd) - Community support
- [GitHub Issues](https://github.com/openclaw/openclaw/issues) - Report bugs and request features
