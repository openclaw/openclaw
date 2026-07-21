# Titanium Claws - Independence Workflow

## Complete Guide to Creating an Independent Project

This is the definitive workflow for transitioning from OpenClaw-derived work to an independent Titanium Claws project, incorporating all architectural, legal, and technical best practices.

---

## Architectural Foundation

### Identity Platform

The Identity Platform is the foundation layer that owns all identity-related concerns:

```
Identity Platform
├── Technical Identity
│   ├── project_id              # Unique project identifier
│   ├── namespace               # Package namespace (@titaniumclaws)
│   ├── config_dir              # Configuration directory (.titanium-claws)
│   ├── state_dir               # State directory (.titanium-claws/state)
│   ├── protocol_prefix         # Protocol identifier (titaniumclaws://)
│   ├── env_prefix              # Environment variable prefix (TITANIUM_CLAWS_)
│   ├── package_prefix          # Package prefix (@titaniumclaws)
│   ├── binary_prefix           # Binary prefix (titaniumclaws-)
│   ├── default_ports           # Default ports (3000, 3001, etc.)
│   └── protocol_version        # Protocol version (1.0.0)
│
├── Branding
│   ├── product_name            # Product name (Titanium Claws)
│   ├── display_name            # Display name (Titanium Claws)
│   ├── short_name              # Short name (Titanium)
│   ├── tagline                 # Tagline
│   ├── logo                    # Logo assets
│   ├── colors                  # Color scheme
│   ├── typography              # Typography
│   ├── website                 # Website URL
│   ├── documentation           # Documentation URL
│   └── organization            # Organization name
│
├── Compatibility
│   ├── legacy_aliases          # OpenClaw compatibility aliases
│   ├── migration_mappings      # Migration mappings
│   ├── deprecation_timeline    # Deprecation timeline
│   └── compatibility_version   # Compatibility version
│
└── Metadata
    ├── version                 # Project version
    ├── license                 # License (MIT)
    ├── copyright               # Copyright notices
    ├── provenance              # Project provenance
    └── telemetry_id            # Telemetry identifier
```

### Platform Contract

The Identity Platform serves as a **platform contract** that all other components depend on:

**Guarantees**:
- ✅ All branding flows through Identity Platform
- ✅ No hard-coded identifiers scattered in code
- ✅ Single source of truth for all identity concerns
- ✅ Clear separation between technical identity and branding
- ✅ Compatibility layer for legacy support

**Dependencies**:
```
Identity Platform
       ↓
Compatibility Layer
       ↓
Repository Independence
       ↓
Runtime Architecture
       ↓
Rust Engines
       ↓
Protocols
       ↓
Documentation & Migration
       ↓
Independent Releases
```

---

## Phase 1: Identity Platform Implementation

### 1.1 Technical Identity vs Branding

**Separation Principle**: Technical identifiers are immutable; branding can change.

```typescript
// src/identity/platform.ts

/**
 * Technical Identity - Immutable technical identifiers
 * These should NEVER change as they affect compatibility
 */
export const TECHNICAL_IDENTITY = {
  projectId: 'titanium-claws',
  namespace: '@titaniumclaws',
  configDir: '.titanium-claws',
  stateDir: '.titanium-claws/state',
  protocolPrefix: 'titaniumclaws://',
  envPrefix: 'TITANIUM_CLAWS_',
  packagePrefix: '@titaniumclaws',
  binaryPrefix: 'titaniumclaws-',
  defaultPorts: {
    http: 3000,
    https: 3001,
    websocket: 3002,
  },
  protocolVersion: '1.0.0',
} as const;

/**
 * Branding - User-facing branding
 * These CAN change for rebranding or white-label builds
 */
export const BRANDING = {
  productName: 'Titanium Claws',
  displayName: 'Titanium Claws',
  shortName: 'Titanium',
  tagline: 'High-Performance AI Agent Framework',
  logo: {
    light: 'assets/logo-light.svg',
    dark: 'assets/logo-dark.svg',
    icon: 'assets/icon.svg',
  },
  colors: {
    primary: '#4A5568',
    secondary: '#2C5282',
    accent: '#E53E3E',
  },
  typography: {
    fontFamily: 'Inter, system-ui, sans-serif',
    fontFamilyMono: 'JetBrains Mono, monospace',
  },
  website: 'https://titaniumclaws.dev',
  documentation: 'https://docs.titaniumclaws.dev',
  organization: 'Titanium Claws Project',
} as const;
```

### 1.2 Compatibility Layer

```typescript
// src/identity/compatibility.ts

/**
 * Compatibility Layer - Legacy support and migration
 */
export const COMPATIBILITY = {
  /**
   * Legacy aliases for OpenClaw compatibility
   */
  legacyAliases: {
    '@openclaw': '@titaniumclaws',
    'openclaw-': 'titaniumclaws-',
    'OPENCLAW_': 'TITANIUM_CLAWS_',
    '.openclaw': '.titanium-claws',
  },

  /**
   * Migration mappings
   */
  migrationMappings: {
    environmentVariables: {
      'OPENCLAW_STATE_DIR': 'TITANIUM_CLAWS_STATE_DIR',
      'OPENCLAW_CONFIG_PATH': 'TITANIUM_CLAWS_CONFIG_PATH',
      'OPENCLAW_DEBUG': 'TITANIUM_CLAWS_DEBUG',
    },
    packages: {
      '@openclaw/core': '@titaniumclaws/core',
      '@openclaw/identity': '@titaniumclaws/identity',
    },
    binaries: {
      'openclaw': 'titaniumclaws',
      'openclaw-server': 'titaniumclaws-server',
    },
  },

  /**
   * Deprecation timeline
   */
  deprecationTimeline: {
    legacyEnvironmentVariables: {
      deprecated: '1.0.0',
      warnings: '1.x.x',
      removed: '2.0.0',
    },
    legacyPackages: {
      deprecated: '1.0.0',
      warnings: '1.x.x',
      removed: '2.0.0',
    },
  },
} as const;
```

### 1.3 Identity Service

```typescript
// src/identity/service.ts

import { TECHNICAL_IDENTITY, BRANDING, COMPATIBILITY } from './platform.js';

/**
 * Identity Service - Central access to identity platform
 */
export class IdentityService {
  /**
   * Get technical identity
   */
  getTechnicalIdentity() {
    return TECHNICAL_IDENTITY;
  }

  /**
   * Get branding
   */
  getBranding() {
    return BRANDING;
  }

  /**
   * Get compatibility layer
   */
  getCompatibility() {
    return COMPATIBILITY;
  }

  /**
   * Resolve package name
   */
  resolvePackage(name: string): string {
    for (const [legacy, current] of Object.entries(COMPATIBILITY.migrationMappings.packages)) {
      if (name.startsWith(legacy)) {
        return name.replace(legacy, current);
      }
    }
    return name;
  }

  /**
   * Resolve environment variable
   */
  resolveEnvVar(name: string): string {
    return COMPATIBILITY.migrationMappings.environmentVariables[name] || name;
  }

  /**
   * Resolve binary name
   */
  resolveBinary(name: string): string {
    return COMPATIBILITY.migrationMappings.binaries[name] || name;
  }

  /**
   * Get config directory
   */
  getConfigDir(): string {
    return TECHNICAL_IDENTITY.configDir;
  }

  /**
   * Get state directory
   */
  getStateDir(): string {
    return TECHNICAL_IDENTITY.stateDir;
  }

  /**
   * Get environment variable with legacy support
   */
  getEnvVarWithLegacy<T>(newName: string, legacyName: string, defaultValue?: T): T | undefined {
    const value = process.env[newName];
    if (value !== undefined) {
      return value as unknown as T;
    }

    const legacyValue = process.env[legacyName];
    if (legacyValue !== undefined) {
      console.warn(
        `DEPRECATION: ${legacyName} is deprecated. ` +
        `Use ${newName} instead. ` +
        `Support will be removed in version ${COMPATIBILITY.deprecationTimeline.legacyEnvironmentVariables.removed}.`
      );
      return legacyValue as unknown as T;
    }

    return defaultValue;
  }
}
```

---

## Phase 2: Repository Independence

### 2.1 Create Orphan Branch

```bash
# Ensure all work is committed
cd /home/user/openclaw
git checkout arena/019f8084-openclaw

# Run tests
pnpm test
cargo test --workspace

# Create orphan branch
git checkout --orphan titanium-claws

# Commit with provenance statement
git add -A
git commit -m "feat: Titanium Claws - Independent AI Agent Framework

Independent implementation and architecture based on work developed 
from the original OpenClaw project.

This project originated from OpenClaw and has evolved into an 
independent implementation with substantial original architecture.

See PROVENANCE.md and COMPATIBILITY_POLICY.md for details."

# Rename to main
git branch -M main
```

### 2.2 Create New GitHub Repository

**Critical**: Do NOT use GitHub's "Fork" button.

1. Go to https://github.com/new
2. Repository name: `titanium-claws`
3. Description: "Independent AI Agent Framework"
4. **DO NOT** initialize with README, .gitignore, or license
5. Click "Create repository"

```bash
# Add new remote
git remote add titanium-claws https://github.com/YOUR_USERNAME/titanium-claws.git

# Push to new repository
git push -u titanium-claws main

# Verify on GitHub
# Repository should NOT show "forked from openclaw/openclaw"

# Rename remote
git remote rename titanium-claws origin
```

---

## Phase 3: Legal Compliance

### 3.1 LICENSE File

**Critical**: Preserve original license exactly.

```bash
# Scenario 1: Original uses "Contributors"
if original license has "Copyright (c) 2024 OpenClaw Contributors"; then
  cat > LICENSE << 'EOF'
MIT License

Copyright (c) 2024 OpenClaw Contributors
Copyright (c) 2026 Titanium Claws Contributors

[Full MIT license text]
EOF

# Scenario 2: Original names individuals
elif original license names individuals; then
  # Preserve original LICENSE exactly
  cp original-license LICENSE
  
  # Add your copyright in separate file
  cat >> CONTRIBUTING.md << 'EOF'
# Copyright and License

## Original Work

This project originated from OpenClaw, Copyright (c) 2024 [Original Authors].
Licensed under the MIT License. See LICENSE file for details.

## New Contributions

New contributions are Copyright (c) 2026 Your Name.
Also licensed under the MIT License.
EOF
fi
```

### 3.2 PROVENANCE.md

```bash
cat > PROVENANCE.md << 'EOF'
# Titanium Claws - Project Provenance

## Origins

Titanium Claws originated from work developed from the OpenClaw project.
Since version 1.0.0, development has proceeded independently under its own
roadmap, architecture, governance, and release process while complying with
applicable open-source license obligations.

See COMPATIBILITY_POLICY.md for compatibility guarantees.
EOF
```

### 3.3 COMPATIBILITY_POLICY.md

```bash
cat > COMPATIBILITY_POLICY.md << 'EOF'
# Titanium Claws - Compatibility Policy

## Compatibility Scope

Titanium Claws maintains compatibility across:

1. **API Compatibility**: Public APIs remain functionally equivalent
2. **Configuration Compatibility**: Configuration formats remain compatible
3. **Environment Variables**: Both new and legacy names supported
4. **CLI Compatibility**: Command-line interface remains compatible
5. **Plugin Interface**: Plugin interfaces remain compatible
6. **Skill Format**: Skill file formats remain compatible
7. **Protocol Compatibility**: Communication protocols remain compatible

## Deprecation Policy

1. **Deprecation**: Feature marked as deprecated in a major release
2. **Warning Phase**: Deprecation warnings shown throughout that release
3. **Removal**: Feature removed in the next major release

This provides users ample time to migrate.
EOF
```

---

## Phase 4: Rebranding

### 4.1 Update Package Metadata

```json
// package.json
{
  "name": "@titaniumclaws/core",
  "description": "Titanium Claws - Independent AI Agent Framework",
  "author": "Your Name <your.email@example.com>",
  "contributors": [
    "OpenClaw Contributors (original project)"
  ],
  "repository": {
    "type": "git",
    "url": "https://github.com/YOUR_USERNAME/titanium-claws.git"
  }
}
```

### 4.2 Update Rust Crates

```toml
# crates/identity/Cargo.toml
[package]
name = "titaniumclaws-identity"
version = "1.0.0"
authors = ["Your Name <your.email@example.com>"]
description = "Titanium Claws identity layer"
repository = "https://github.com/YOUR_USERNAME/titanium-claws"
```

### 4.3 Update All References

```typescript
// Before: Hard-coded
const configPath = '~/.titanium-claws/config.json';

// After: From Identity Platform
import { IdentityService } from '@titaniumclaws/identity';

const identity = new IdentityService();
const configPath = path.join(
  os.homedir(),
  identity.getConfigDir(),
  'config.json'
);
```

---

## Phase 5: Documentation

### 5.1 README.md

```markdown
# Titanium Claws

> Independent AI Agent Framework with Rust-Powered Performance

## About

Titanium Claws is an independent AI agent framework that provides
high-performance, type-safe infrastructure for building intelligent
agent systems.

### Project History

This project originated from work developed from the OpenClaw project
and has evolved into an independent implementation with substantial
original architecture.

See [PROVENANCE.md](./PROVENANCE.md) for details.

## Compatibility

Titanium Claws maintains compatibility with OpenClaw where practical.
See [COMPATIBILITY_POLICY.md](./COMPATIBILITY_POLICY.md) for details.

## Migration

If you're migrating from OpenClaw, see our
[Migration Guide](./docs/MIGRATION.md) for step-by-step instructions.

## License

MIT License - see [LICENSE](./LICENSE) for details.
```

### 5.2 Migration Guide

```markdown
# Migration Guide: OpenClaw → Titanium Claws

## Overview

This guide helps you migrate from OpenClaw to Titanium Claws.
Titanium Claws aims to maintain a high level of source compatibility
where practical.

## Compatibility Matrix

| Dimension | Patch (1.0.x) | Minor (1.x.0) | Major (x.0.0) |
|-----------|---------------|---------------|---------------|
| **API** | ✅ Compatible | ✅ Compatible | ⚠️ May break |
| **Configuration** | ✅ Compatible | ✅ Compatible | ⚠️ May break |
| **Environment Variables** | ✅ Compatible | ✅ Compatible | ⚠️ May break |
| **CLI** | ✅ Compatible | ✅ Compatible | ⚠️ May break |
| **Plugin Interface** | ✅ Compatible | ✅ Compatible | ⚠️ May break |
| **Skill Format** | ✅ Compatible | ✅ Compatible | ⚠️ May break |
| **Protocol** | ✅ Compatible | ✅ Compatible | ⚠️ May break |

## Deprecation Policy

1. **Deprecation**: Feature marked as deprecated in a major release
2. **Warning Phase**: Warnings shown throughout that release
3. **Removal**: Feature removed in next major release

## Environment Variables

Both old and new names are supported:

| OpenClaw (Deprecated) | Titanium Claws (New) | Status |
|----------------------|---------------------|---------|
| `OPENCLAW_STATE_DIR` | `TITANIUM_CLAWS_STATE_DIR` | Both work |
| `OPENCLAW_CONFIG_PATH` | `TITANIUM_CLAWS_CONFIG_PATH` | Both work |

## Package Renames

| OpenClaw | Titanium Claws |
|----------|----------------|
| `@openclaw/core` | `@titaniumclaws/core` |
| `@openclaw/identity` | `@titaniumclaws/identity` |
```

---

## Phase 6: Independent Development

### 6.1 Update Remote

```bash
# Remove old remote
git remote remove origin

# Set new remote
git remote add origin https://github.com/YOUR_USERNAME/titanium-claws.git

# Verify
git remote -v
```

### 6.2 Continue Development

```bash
# Create feature branch
git checkout -b feature/new-feature

# Make changes
# ...

# Commit
git add -A
git commit -m "feat: add new feature"

# Push
git push origin feature/new-feature
```

---

## Architecture Progression

The complete architecture follows this progression:

```
┌─────────────────────────────────────┐
│  Identity Platform                   │
│  (Technical Identity + Branding)    │
└─────────────────────────────────────┘
                 ↓
┌─────────────────────────────────────┐
│  Compatibility Layer                 │
│  (Legacy Support + Migration)       │
└─────────────────────────────────────┘
                 ↓
┌─────────────────────────────────────┐
│  Repository Independence             │
│  (New Repository + Fresh History)   │
└─────────────────────────────────────┘
                 ↓
┌─────────────────────────────────────┐
│  Runtime Architecture                │
│  (Identity Layer + Core Services)   │
└─────────────────────────────────────┘
                 ↓
┌─────────────────────────────────────┐
│  Rust Engines                        │
│  (7 High-Performance Engines)       │
└─────────────────────────────────────┘
                 ↓
┌─────────────────────────────────────┐
│  Protocols                           │
│  (MCP + A2A + Custom)               │
└─────────────────────────────────────┘
                 ↓
┌─────────────────────────────────────┐
│  Documentation & Migration           │
│  (Guides + Compatibility Policy)    │
└─────────────────────────────────────┘
                 ↓
┌─────────────────────────────────────┐
│  Independent Releases                │
│  (Own Roadmap + Governance)         │
└─────────────────────────────────────┘
```

---

## Legal Compliance Checklist

### License Compliance

- [ ] ✅ Preserved original LICENSE file exactly
- [ ] ✅ Did NOT invent copyright holders
- [ ] ✅ Added your copyright only for code you authored
- [ ] ✅ Created PROVENANCE.md
- [ ] ✅ Created COMPATIBILITY_POLICY.md
- [ ] ✅ Documented project origins honestly

### Documentation

- [ ] ✅ Created PROVENANCE.md with timeline
- [ ] ✅ Created COMPATIBILITY_POLICY.md with scope
- [ ] ✅ Updated README.md with honest origins
- [ ] ✅ Created MIGRATION.md with tables
- [ ] ✅ Provided clear migration path

### Identity Platform

- [ ] ✅ Separated technical identity from branding
- [ ] ✅ All branding flows through Identity Platform
- [ ] ✅ No hard-coded identifiers in code
- [ ] ✅ Environment variables support both old and new
- [ ] ✅ Deprecation warnings shown for old names

### Repository

- [ ] ✅ Created new GitHub repository (not a fork)
- [ ] ✅ Verified no "forked from" metadata
- [ ] ✅ Created orphan branch (fresh history)
- [ ] ✅ All tests passing
- [ ] ✅ Comprehensive documentation

---

## Final Assessment

This workflow achieves:

1. ✅ **Legal Compliance** - Proper license handling, honest attribution
2. ✅ **Technical Independence** - New repository, fresh history
3. ✅ **User-Friendly Migration** - Dual-support, deprecation warnings
4. ✅ **Maintainability** - Centralized branding via Identity Platform
5. ✅ **Transparency** - Honest about origins, clear migration path
6. ✅ **Architecture** - Clear separation of concerns
7. ✅ **Compatibility** - Defined scope and policy
8. ✅ **Provenance** - Clear project history and timeline

The result is an independent, legally compliant, architecturally sound project that respects the original work while establishing its own identity and direction.

---

## Key Takeaways

### Do

- ✅ Document the relationship honestly
- ✅ Preserve original licenses exactly
- ✅ Add your copyright only for your code
- ✅ Provide migration paths
- ✅ Create independent repository
- ✅ Separate technical identity from branding
- ✅ Define compatibility scope
- ✅ Version deprecation policy

### Don't

- ❌ Claim "built from ground up" if derived
- ❌ Erase attribution
- ❌ Simply replace copyrights
- ❌ Make abrupt breaking changes
- ❌ Use GitHub's "Fork" button
- ❌ Hard-code identifiers scattered in code
- ❌ Leave compatibility ambiguous
- ❌ Promise specific version removal dates

---

**🦞 Titanium Claws: Independent, compliant, transparent, and ready for the future!**
