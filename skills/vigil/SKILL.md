---
name: vigil
description: "Onchain security scanner for DeFi traders on Base. Scan approvals, detect honeypots, score contracts, generate wallet reports."
metadata:
  {
    "openclaw":
      {
        "emoji": "🛡️",
        "requires": { "bins": ["curl"] },
        "install":
          [
            {
              "id": "curl",
              "kind": "system",
              "label": "curl (usually pre-installed)",
              "bins": ["curl"],
            },
          ],
      },
  }
---

# VIGIL Security Scanner

Onchain security scanner for DeFi traders on Base. Provides 5 read-only security tools via MCP protocol.

## Tools

### 1. Scan Approvals

Scan all token approvals for a wallet. Flags unlimited allowances.

```bash
curl -s -X POST https://mcp.vigil.codes/tools/call \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"vigil_scan_approvals","arguments":{"wallet":"WALLET_ADDRESS","chain":"base"}}}'
```

### 2. Scan Token

Analyze token contract for rugpull indicators (hidden mint, proxy, tax, blacklist).

```bash
curl -s -X POST https://mcp.vigil.codes/tools/call \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"vigil_scan_token","arguments":{"token":"TOKEN_ADDRESS","chain":"base"}}}'
```

### 3. Detect Honeypot

Simulate buy/sell to detect trap tokens.

```bash
curl -s -X POST https://mcp.vigil.codes/tools/call \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"vigil_detect_honeypot","arguments":{"token":"TOKEN_ADDRESS","chain":"base"}}}'
```

### 4. Safety Score

Get 0-100 composite safety rating.

```bash
curl -s -X POST https://mcp.vigil.codes/tools/call \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"vigil_safety_score","arguments":{"contract":"CONTRACT_ADDRESS","chain":"base"}}}'
```

### 5. Wallet Report

Full security posture assessment.

```bash
curl -s -X POST https://mcp.vigil.codes/tools/call \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"vigil_wallet_report","arguments":{"wallet":"WALLET_ADDRESS","chain":"base"}}}'
```

## Risk Levels

| Level | Meaning |
|-------|---------|
| SAFE | No issues detected |
| LOW | Minor concern |
| MEDIUM | Suspicious — proceed with caution |
| HIGH | Dangerous pattern |
| CRITICAL | Active threat — revoke immediately |

## Links

- Website: https://vigil.codes
- GitHub: https://github.com/vigilcodes/vigil-mcp
- MCP Endpoint: https://mcp.vigil.codes
