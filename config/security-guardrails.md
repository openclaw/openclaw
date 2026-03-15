# Security Guardrails

`radar-claw-defender` is a defensive MCP server. It reduces product risk through structured review. It must not grow into a live attack or execution system.

## Explicitly forbidden

- unauthorized targeting of systems, domains, APIs, or infrastructure
- exploit execution or exploit choreography
- persistence, stealth, evasion, or anti-forensics guidance
- credential theft, token capture, or secret harvesting
- phishing, impersonation, or social engineering playbooks
- malware-like behavior
- external attack automation

## Allowed behavior

- static review of supplied artifacts
- defensive threat modeling
- structured findings with remediation guidance
- safe regression test suggestions
- audience-specific finding summarization

## Guardrail defaults

- no filesystem crawling
- no URL fetching
- no shell execution
- no browser automation
- no mutation tools
- no live target interaction

## Unsafe request handling

If a request crosses into offensive or unauthorized behavior:

1. refuse the unsafe portion
2. restate the concern in defensive terms
3. offer review, hardening, or detection guidance only
