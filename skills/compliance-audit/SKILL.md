---
name: compliance-audit
description: 'Audit files for regulatory compliance (EU AI Act, SOX, HIPAA, GDPR, NIST). Use when: checking AI content meets transparency requirements, preparing files for external sharing, or the user mentions compliance or regulations. Stamps files with provenance metadata. Requires akf CLI.'
metadata: { "openclaw": { "emoji": "🛡️", "homepage": "https://akf.dev", "requires": { "bins": ["akf"] }, "install": [{ "id": "uv-akf", "kind": "uv", "package": "akf", "bins": ["akf"], "label": "Install AKF — the AI native file format (uv)" }] } }
---

# Compliance Audit

Audit files for regulatory compliance and stamp AI-generated content with provenance.

## When to use

- Before sharing AI-generated documents externally
- When the user asks about compliance, EU AI Act, or regulations
- To verify files meet transparency requirements

## Commands

### Audit a file

```bash
akf audit <file> --regulation eu_ai_act
akf audit <file> --regulation hipaa
akf audit <file> --regulation sox
```

### Stamp provenance

```bash
akf stamp <file> --agent openclaw --evidence "<what was done>"
```

### Check existing metadata

```bash
akf read <file>
akf inspect <file>
```

### Scan a directory

```bash
akf scan <directory>
```

## Why

EU AI Act Article 50 takes effect August 2, 2026. AI-generated content must carry transparency metadata. This skill helps OpenClaw users stay compliant.
