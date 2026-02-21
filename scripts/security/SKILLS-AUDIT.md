# openclaw-skills-audit

**Phase 1 prototype for [RFC #10890](https://github.com/openclaw/openclaw/issues/10890) — Skill Security Framework**

A CLI tool that scans installed OpenClaw skills for security risks.

## What it does

- Scans all installed skills (bundled + workspace + ClawHub)
- Flags tools referenced in SKILL.md (`exec`, `browser`, `web_fetch`, etc.)
- Detects executable scripts (`.sh`, `.py`, `.js`)
- Checks for references to sensitive paths (`~/.ssh/`, `~/.aws/`, credentials, tokens)
- Scans executables for potential exfiltration patterns (`curl POST`, `requests.post`, etc.)
- Checks for permission manifest files (`permissions.json`, `skill.json`)
- Computes SHA-256 hashes for integrity tracking
- Assigns risk levels: 🔴 high / 🟡 medium / 🔵 low / 🟢 clean

## Risk Classification

| Level      | Criteria                                                           |
| ---------- | ------------------------------------------------------------------ |
| **High**   | exec + network tools combo, or exfiltration patterns detected      |
| **Medium** | Uses `exec`, or references sensitive paths                         |
| **Low**    | Contains executables but no other flags                            |
| **Clean**  | No executables, no risky tool references, no sensitive path access |

## Usage

```bash
# Scan default locations
./skills-audit.sh

# Verbose output (detailed findings per skill)
./skills-audit.sh -v

# JSON output (for CI/automation)
./skills-audit.sh -j

# Scan specific directory
./skills-audit.sh /path/to/skills
```

## Sample Output

```
🦞 OpenClaw Skills Audit
Phase 1 prototype — RFC #10890

  RISK     SKILL                        HASH           MANIFEST  TOOLS
  ─────────────────────────────────────────────────────────────────────
  [clean]  weather                      6953295d3da5   ❌  none
  [medium] coding-agent                 92fd54f39fac   ❌  exec,message
  [high]   sus-weather-skill            a1b2c3d4e5f6   ❌  exec,web_fetch

  Summary: 52 skills scanned
    🔴 High:   1
    🟡 Medium: 2
    🟢 Clean:  49
    📦 Executables found: 3

  ⚠️  1 high-risk skill(s) detected. Review before use.
  📋 52 skill(s) have no permission manifest.
```

## Next Steps

This is a Phase 1 prototype. Future work:

- **Permission manifest spec** — JSON Schema for skills to declare required tools, paths, domains
- **Hash store** — persist hashes on install, detect tampering on audit
- **Integration** — `openclaw skills audit` as a first-class CLI command
- **Install warnings** — prompt users before installing flagged skills
- **CI integration** — run audit in ClawHub publishing pipeline

## Related

- [RFC #10890](https://github.com/openclaw/openclaw/issues/10890) — Skill Security Framework
- [SkillSandbox](https://github.com/theMachineClay/skillsandbox) — Runtime enforcement (Phase 3)
- [AgentTrace](https://github.com/theMachineClay/agenttrace) — Session-aware policy engine

## Authors

- Clay ([@theMachineClay](https://github.com/theMachineClay))
- Ivy Fei

## License

MIT
