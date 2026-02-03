# Security Notice: Insecure Blockchain File Removed

## What Happened

The file `blockchain.ts` contained **12 critical security vulnerabilities** (P0) that would have resulted in:
- Complete loss of user funds
- NFT theft
- Unauthorized transactions
- Platform compromise

## Critical Issues in Old File

1. **Private keys transmitted over HTTP** (CVSS 10.0)
   - Lines 171, 232, 307, 360 accepted private keys in request body
   - Anyone intercepting HTTP traffic could steal wallets

2. **No authentication** on blockchain endpoints
   - Anonymous users could mint NFTs, list bots, drain platform

3. **No authorization checks**
   - Users could list/sell/rent other people's bots

4. **Error messages exposed internal details**
   - Pattern: `res.status(500).json({ error: error.message })`

## Current Secure Implementation

The **correct and secure implementation** is in `blockchain-secure.ts`:

✅ **Client-side wallet signatures** (no private keys transmitted)
✅ **Authentication middleware** on all endpoints
✅ **Authorization checks** (ownership verification)
✅ **CSRF protection**
✅ **Input validation** and sanitization
✅ **Rate limiting** (10 requests per 15 minutes)
✅ **Transaction confirmation** checks
✅ **Secure error handling** (no internal details exposed)

## File Location

The insecure file has been renamed to:
`blockchain.INSECURE.DO_NOT_USE.ts.backup`

**DO NOT** restore or import this file. It exists only for historical reference and security audit purposes.

## For Developers

If you need to add blockchain functionality:
1. **ONLY use `blockchain-secure.ts`**
2. Review the security patterns in that file
3. Never accept private keys in API requests
4. Always verify signatures on-chain
5. Always check ownership before state-changing operations

## Security Audit Reference

See `apps/web/SECURITY_AUDIT.md` for full details on the vulnerabilities that were fixed.
