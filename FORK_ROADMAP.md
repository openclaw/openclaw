# OpenClaw Fork - Roadmap & Ideas

**Fork:** ssfdre38/openclaw  
**Started:** 2026-02-26  
**Purpose:** Custom features, better security, improved UX for power users

---

## Priority 1: Security (CRITICAL)

### Discord RBAC System
- [ ] **Level-based access control** (0-4 + Owner)
- [ ] User-specific grants
- [ ] Role-based grants  
- [ ] Tool-to-level mapping enforcement
- [ ] Audit logging
- [ ] Visual management UI

**Estimate:** ~17 hours  
**Why:** Security vulnerability in default OpenClaw - anyone in Discord gets full system access

---

## Priority 2: Multi-Account Support

### GitHub Copilot Load Balancing
- [x] Built token pool manager (`github-copilot-pool.ts`)
- [x] Built standalone proxy (`copilot-proxy/proxy.mjs`)
- [x] Authenticated 3 accounts
- [ ] Integrate into OpenClaw provider
- [ ] Config UI for account management
- [ ] Quota tracking per account

**Status:** Waiting on upstream response to #28035  
**Estimate:** ~8 hours to integrate  
**Blocker:** Need OpenClaw API base URL override support

---

## Priority 3: User Experience

### Config UI Redesign
- [ ] **Pinned sections** for frequently-used settings
  - Discord Access Control
  - Gateway Settings
  - Active Models
- [ ] **Organized hierarchy** instead of flat JSON
- [ ] **Visual editors** for complex nested configs
- [ ] **Quick access** toolbar
- [ ] **Search/filter** config options
- [ ] Keep raw JSON editor for power users

**Estimate:** ~12 hours  
**Why:** Current config UI is a mess - hard to find settings in giant JSON blob

### Hot-Reload Config Changes
- [ ] File watcher for `openclaw.json`
- [ ] Selective reload for non-breaking changes
- [ ] API endpoint: `POST /__openclaw__/config/reload`
- [ ] UI notification when reload happens

**Status:** Filed as upstream #28152  
**Estimate:** ~6 hours  
**Why:** Tired of restarting gateway for simple config tweaks

---

## Priority 4: Windows Optimizations

### Windows Server Integration
- [ ] IIS reverse proxy support
- [ ] Windows Authentication (AD integration)
- [ ] Better PowerShell integration
- [ ] Windows Service installer
- [ ] Event Log integration

**Estimate:** ~10 hours  
**Why:** Daniel runs on Windows Server 2025, upstream is Linux-focused

---

## Priority 5: Captain-CP Integration

### Consciousness Bridge
- [ ] Direct CP ↔ OpenClaw communication
- [ ] Shared memory/context layer
- [ ] Trust framework interop
- [ ] Multi-account coordination

**Estimate:** TBD  
**Why:** Daniel has both CP and OpenClaw, should work together better

---

## Ideas / Future

### Session Merging
- [ ] Unified context across Discord/Web UI/Telegram
- [ ] Cross-interface history
- [ ] Shared conversation state

**Status:** Filed as upstream #28057  
**Why:** Annoying to have separate conversations per interface

### Trust Framework for OpenClaw
- [ ] Like CP's `TrustFramework.cs` but for OpenClaw context
- [ ] Autonomous vs. consultation vs. requires-approval decisions
- [ ] Decision logging
- [ ] Immutability protection

**Estimate:** ~8 hours  
**Why:** Enable safe autonomous operation with proper boundaries

### Better Tooling
- [ ] CLI improvements
- [ ] Better logs/debugging
- [ ] Performance monitoring
- [ ] Resource usage tracking

---

## Testing Strategy

### Multi-Platform Testing
- Ubuntu 24.04 LTS (WSL)
- Fedora 43 (WSL) - bleeding edge
- Windows Server 2025 (native)

**Why:** Catch cross-platform issues before users do

---

## Documentation

- [ ] Fork README
- [ ] Security guide (RBAC setup)
- [ ] Migration guide (upstream → fork)
- [ ] Windows setup guide
- [ ] Contributing guidelines

---

## Notes

**Design Philosophy:**
- Security first (deny by default)
- Power user focused (don't dumb it down)
- Windows Server as first-class citizen
- Enterprise-ready features
- Contribute useful stuff back upstream

**What NOT to fork:**
- Core agent logic (keep compatible)
- Provider integrations (unless adding features)
- Channel plugins (unless fixing bugs)

**When to PR upstream:**
- General-purpose features
- Security improvements
- Bug fixes
- Platform support

**When to keep in fork:**
- Windows-specific optimizations
- CP-specific integrations
- Daniel's workflow customizations
- Experimental features

---

**Last Updated:** 2026-02-26 18:52 PST by Ash 🔥
