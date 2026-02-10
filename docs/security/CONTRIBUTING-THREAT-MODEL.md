# Contributing to the OpenClaw Threat Model（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Thanks for helping make OpenClaw more secure. This threat model is a living document and we welcome contributions from anyone - you don't need to be a security expert.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Ways to Contribute（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Add a Threat（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Spotted an attack vector or risk we haven't covered? Open an issue on [openclaw/trust](https://github.com/openclaw/trust/issues) and describe it in your own words. You don't need to know any frameworks or fill in every field - just describe the scenario.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Helpful to include (but not required):**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- The attack scenario and how it could be exploited（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Which parts of OpenClaw are affected (CLI, gateway, channels, ClawHub, MCP servers, etc.)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- How severe you think it is (low / medium / high / critical)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Any links to related research, CVEs, or real-world examples（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
We'll handle the ATLAS mapping, threat IDs, and risk assessment during review. If you want to include those details, great - but it's not expected.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
> **This is for adding to the threat model, not reporting live vulnerabilities.** If you've found an exploitable vulnerability, see our [Trust page](https://trust.openclaw.ai) for responsible disclosure instructions.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Suggest a Mitigation（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Have an idea for how to address an existing threat? Open an issue or PR referencing the threat. Useful mitigations are specific and actionable - for example, "per-sender rate limiting of 10 messages/minute at the gateway" is better than "implement rate limiting."（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Propose an Attack Chain（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Attack chains show how multiple threats combine into a realistic attack scenario. If you see a dangerous combination, describe the steps and how an attacker would chain them together. A short narrative of how the attack unfolds in practice is more valuable than a formal template.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Fix or Improve Existing Content（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Typos, clarifications, outdated info, better examples - PRs welcome, no issue needed.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## What We Use（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### MITRE ATLAS（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
This threat model is built on [MITRE ATLAS](https://atlas.mitre.org/) (Adversarial Threat Landscape for AI Systems), a framework designed specifically for AI/ML threats like prompt injection, tool misuse, and agent exploitation. You don't need to know ATLAS to contribute - we map submissions to the framework during review.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Threat IDs（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Each threat gets an ID like `T-EXEC-003`. The categories are:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Code    | Category                                   |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| ------- | ------------------------------------------ |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| RECON   | Reconnaissance - information gathering     |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| ACCESS  | Initial access - gaining entry             |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| EXEC    | Execution - running malicious actions      |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| PERSIST | Persistence - maintaining access           |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| EVADE   | Defense evasion - avoiding detection       |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| DISC    | Discovery - learning about the environment |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| EXFIL   | Exfiltration - stealing data               |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| IMPACT  | Impact - damage or disruption              |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
IDs are assigned by maintainers during review. You don't need to pick one.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Risk Levels（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Level        | Meaning                                                           |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| ------------ | ----------------------------------------------------------------- |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **Critical** | Full system compromise, or high likelihood + critical impact      |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **High**     | Significant damage likely, or medium likelihood + critical impact |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **Medium**   | Moderate risk, or low likelihood + high impact                    |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **Low**      | Unlikely and limited impact                                       |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If you're unsure about the risk level, just describe the impact and we'll assess it.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Review Process（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. **Triage** - We review new submissions within 48 hours（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. **Assessment** - We verify feasibility, assign ATLAS mapping and threat ID, validate risk level（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. **Documentation** - We ensure everything is formatted and complete（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
4. **Merge** - Added to the threat model and visualization（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Resources（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [ATLAS Website](https://atlas.mitre.org/)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [ATLAS Techniques](https://atlas.mitre.org/techniques/)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [ATLAS Case Studies](https://atlas.mitre.org/studies/)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [OpenClaw Threat Model](./THREAT-MODEL-ATLAS.md)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Contact（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Security vulnerabilities:** See our [Trust page](https://trust.openclaw.ai) for reporting instructions（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Threat model questions:** Open an issue on [openclaw/trust](https://github.com/openclaw/trust/issues)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **General chat:** Discord #security channel（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Recognition（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Contributors to the threat model are recognized in the threat model acknowledgments, release notes, and the OpenClaw security hall of fame for significant contributions.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
