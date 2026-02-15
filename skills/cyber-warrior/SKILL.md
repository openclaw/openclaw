---
name: cyber-warrior
description: "Advanced cybersecurity and network diagnostic tools. Use for vulnerability assessments, network mapping, DNS troubleshooting, and security hardening. Provides access to nmap, dig, curl, and custom security scripts."
---

# Cyber-Warrior Skill

Equip yourself with the tools of the trade for offensive and defensive security.

## Network Mapping (nmap)

- **Standard Scan**: `nmap <target>`
- **Deep Scan (Service detection + OS detection + Scripts)**: `nmap -A <target>`
- **Stealth Scan**: `nmap -sS <target>` (Requires elevated permissions)
- **Aggressive Scan**: `nmap -T4 -A <target>`

## DNS Investigation (dig)

- **Lookup all records**: `dig <domain> ANY`
- **Trace DNS delegation**: `dig <domain> +trace`
- **Reverse DNS lookup**: `dig -x <IP>`

## Web Analysis (curl)

- **Inspect Headers**: `curl -I <url>`
- **Check Security Headers**: `curl -s -I <url> | grep -iE 'Content-Security-Policy|Strict-Transport-Security|X-Frame-Options'`

## Security Best Practices

1. **Least Privilege**: Only run what you need.
2. **Stealth**: Avoid noisy scans unless authorized.
3. **Data Integrity**: Never modify target systems without explicit consent.

---
_SECURE. ANALYZE. EXECUTE._
