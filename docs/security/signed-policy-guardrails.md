# Signed Policy Guardrails (fail-closed)

Signed Policy Guardrails are optional hardening controls for runtime self-escalation paths.

When enabled, OpenClaw enforces policy in code (not prompt text) and:

- Blocks dangerous tools unless explicitly allowlisted by signed policy.
- Blocks skill installs unless explicitly allowlisted by signed policy.
- Blocks config mutation actions unless explicitly allowlisted by signed policy.

If `policy.failClosed=true` and signature verification fails, OpenClaw enters lockdown mode and denies dangerous tool actions, installs, and config mutation actions.

## Configure

Add this to `~/.openclaw/openclaw.json`:

```json
{
  "policy": {
    "enabled": true,
    "policyPath": "~/.openclaw/POLICY.json",
    "sigPath": "~/.openclaw/POLICY.sig",
    "publicKey": "<base64-ed25519-public-key>",
    "failClosed": true
  }
}
```

Defaults:

- `enabled`: `false`
- `policyPath`: `~/.openclaw/POLICY.json`
- `sigPath`: `~/.openclaw/POLICY.sig`
- `failClosed`: `true`

## Generate Keys

Create an ed25519 keypair (base64 raw key material):

```bash
node -e 'const c=require("node:crypto");const {publicKey,privateKey}=c.generateKeyPairSync("ed25519");const spki=publicKey.export({type:"spki",format:"der"});const pkcs8=privateKey.export({type:"pkcs8",format:"der"});console.log("PUBLIC_BASE64="+spki.subarray(-32).toString("base64"));console.log("PRIVATE_BASE64="+pkcs8.subarray(-32).toString("base64"));'
```

## Sign

Write your private key (base64 or PEM) to a file, then:

```bash
openclaw policy sign --in ~/.openclaw/POLICY.json --out ~/.openclaw/POLICY.sig --private-key ~/.openclaw/policy-private.key
```

`openclaw policy sign` canonicalizes policy JSON before signing (stable key ordering + Unicode NFC normalization). Use the CLI signer to avoid non-canonical signature mismatches.

## Verify

```bash
openclaw policy verify --in ~/.openclaw/POLICY.json --sig ~/.openclaw/POLICY.sig --public-key "<base64-ed25519-public-key>"
```

`openclaw policy verify` verifies the canonicalized policy payload. Detached signatures created from non-canonical payload bytes are rejected.

## Example Policy

See `docs/security/examples/POLICY.example.json`.
