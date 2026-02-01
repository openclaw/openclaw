# 🛡️ OpenClaw Security Documentation

**Welcome to the OpenClaw Security Hub.**

This directory contains detailed technical documentation regarding the security hardening measures implemented in this fork of OpenClaw. Our goal is to provide a secure-by-default environment for self-hosters.

## 📚 Documentation Index

1.  [**Architecture & Design**](./ARCHITECTURE.md)
    *   Deep dive into **Rate Limiting**, **Password Hashing**, and **Visual Warnings**.
    *   Technical implementation details of the new security modules.

2.  [**Verification Guide**](./VERIFICATION.md)
    *   How to verify your installation is secure.
    *   Usage of the `security-verification.sh` script.
    *   Running the automated security test suite.

3.  [**Dependency Audit**](./DEPENDENCY_AUDIT.md)
    *   Details of the security audit performed in February 2026.
    *   List of patched vulnerabilities (Hono, Tar, etc.).
    *   Explanation of `package.json` overrides.

## 🚀 Quick Start: Verify Your Security

We have included a verified script to validate your system's security posture.

```bash
# Run from the project root
./security-verification.sh
```

**What this checks:**
- ✅ **Rate Limiting**: Ensures brute-force protection is active.
- ✅ **Configuration**: Validates secure defaults.
- ✅ **Dependencies**: Checks for known vulnerabilities.
- ✅ **Permissions**: Verifies file system permissions for sensitivity.

## 🔒 Key Security Features

*   **Anti-Brute Force**: IPs are blocked for 15 minutes after 5 failed login attempts.
*   **Secure Storage**: Passwords are hashed using `scrypt` (OWASP recommended).
*   **Startup Auditor**: The server scans its own config on startup and warns you of risks (e.g., HTTP exposure without auth).
*   **Hardened Deps**: Critical dependencies like `hono` and `tar` are pinned to secure versions.
