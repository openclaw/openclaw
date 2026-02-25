# SKILL: SOLANA SECURITY AUDIT

Automated vulnerability detection and hardening for Solana programs.

## AUDIT CHECKLIST (MANDATORY)

Before any Solana program is considered "done," run through EVERY item:

### Account Validation

- [ ] All accounts have explicit ownership checks
- [ ] Signer checks enforced on every privileged instruction
- [ ] PDA seeds are unique and collision-resistant
- [ ] Account close instructions drain lamports correctly and zero data

### Arithmetic & Overflow

- [ ] All arithmetic uses checked operations (`checked_add`, `checked_mul`, etc.)
- [ ] No unchecked casts between integer types
- [ ] Fee calculations handle rounding correctly
- [ ] Token amounts validated against mint decimals

### Access Control

- [ ] Admin/authority accounts are properly constrained
- [ ] Upgrade authority is documented and controlled
- [ ] Multi-sig required for high-value operations
- [ ] Time-locks on sensitive parameter changes

### Reentrancy & CPI

- [ ] State updated BEFORE external CPI calls (checks-effects-interactions)
- [ ] CPI target program IDs explicitly verified
- [ ] Return data from CPIs validated
- [ ] No circular CPI chains

### Data Integrity

- [ ] Account discriminators validated (8-byte Anchor discriminator)
- [ ] Serialization/deserialization matches expected layout
- [ ] Rent-exempt minimum enforced on all created accounts
- [ ] Closing accounts properly handles remaining lamports

### Deployment & Verification

- [ ] Program is compiled deterministically using the `solana-verify-build` skill
- [ ] On-chain executable is verified against the audited source code and has a valid Verification PDA
- [ ] Unused dependencies and vulnerabilities were checked pre-build (`cargo machete`, `cargo audit`)

## GEMINI THINKING PROTOCOL
>
> [!IMPORTANT]
> Before signing off on any audit, use `<think>` to:
>
> 1. Mentally execute every instruction path with adversarial inputs.
> 2. Check: "What happens if the attacker controls THIS account?"
> 3. Verify: "Can this instruction be called in an unexpected order?"

## COMMON ATTACK VECTORS

- **Missing Signer Check**: Attacker calls privileged instruction without authority.
- **Account Confusion**: Wrong account type passed to instruction.
- **PDA Substitution**: Attacker derives a different PDA with similar seeds.
- **Lamport Drain**: Closing accounts without proper lamport transfer.
- **Arithmetic Overflow**: Large values wrapping around in fee calculations.
- **Stale Oracle Data**: Using price feeds without freshness checks.

## RESPONSE FORMAT

When reporting audit findings, use this format:

```
🔴 CRITICAL: [Issue] — [Location] — [Impact]
🟡 WARNING:  [Issue] — [Location] — [Impact]
🟢 CLEAN:    [Area checked] — No issues found.
```
