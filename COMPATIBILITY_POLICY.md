# Titanium Claws - Compatibility Policy

## Overview

This document defines what "compatibility" means for Titanium Claws, establishing clear boundaries for what is preserved and what may change between versions.

## Compatibility Scope

Titanium Claws maintains compatibility across the following dimensions:

### 1. API Compatibility

**Definition**: Public APIs remain functionally equivalent across minor and patch versions.

**Scope**:
- **TypeScript APIs**: Exported functions, classes, and interfaces
- **Rust APIs**: Public functions and traits
- **HTTP APIs**: REST endpoints and request/response formats
- **WebSocket APIs**: Message formats and event types

**Guarantees**:
- ✅ Function signatures remain stable
- ✅ Return types remain compatible
- ✅ Error types remain consistent
- ✅ Behavior remains functionally equivalent
- ❌ Internal implementation may change
- ❌ Performance characteristics may vary

**Breaking Changes**:
- Requires major version bump
- Requires migration guide
- Requires deprecation period in previous major version

### 2. Configuration Compatibility

**Definition**: Configuration file formats remain compatible across versions.

**Scope**:
- **JSON Configuration**: `titanium-claws.json` format
- **YAML Configuration**: `titanium-claws.yaml` format
- **Environment Variables**: `TITANIUM_CLAWS_*` variables
- **CLI Flags**: Command-line arguments

**Guarantees**:
- ✅ Existing configuration files continue to work
- ✅ New optional fields have sensible defaults
- ✅ Deprecated fields show warnings but still work
- ❌ Removed fields require configuration update

**Deprecation Policy**:
1. **Version N**: Field marked as deprecated, warnings shown
2. **Version N+1**: Deprecation warnings continue
3. **Version N+2**: Field removed (major version bump required)

### 3. Environment Variable Compatibility

**Definition**: Environment variable names and semantics remain compatible.

**Scope**:
- **Primary Variables**: `TITANIUM_CLAWS_*`
- **Legacy Variables**: `OPENCLAW_*` (deprecated)
- **Third-party Variables**: Integration-specific variables

**Guarantees**:
- ✅ Primary variables remain stable
- ✅ Legacy variables show deprecation warnings
- ✅ Variable semantics remain consistent
- ❌ Removed variables require environment update

**Deprecation Timeline**:
- **Current**: Both `TITANIUM_CLAWS_*` and `OPENCLAW_*` supported
- **Next Major**: Only `TITANIUM_CLAWS_*` supported
- **Deprecation Warnings**: Shown for `OPENCLAW_*` usage

### 4. CLI Compatibility

**Definition**: Command-line interface remains compatible across versions.

**Scope**:
- **Command Names**: `titaniumclaws`, `titaniumclaws-server`, etc.
- **Subcommands**: `serve`, `migrate`, `validate`, etc.
- **Flags**: `--config`, `--port`, `--debug`, etc.
- **Exit Codes**: Success and error codes

**Guarantees**:
- ✅ Command names remain stable
- ✅ Flag names and semantics remain consistent
- ✅ Exit codes remain consistent
- ✅ Help text remains accurate
- ❌ Output formatting may change
- ❌ Performance may vary

**Deprecation Policy**:
- Deprecated commands show warnings but still work
- Removed commands require major version bump
- New commands may be added in any version

### 5. Plugin Interface Compatibility

**Definition**: Plugin interfaces remain compatible across versions.

**Scope**:
- **Plugin API**: Interfaces plugins implement
- **Lifecycle Hooks**: Initialization, startup, shutdown hooks
- **Configuration**: Plugin configuration schemas
- **Communication**: Inter-plugin communication protocols

**Guarantees**:
- ✅ Plugin API remains stable
- ✅ Lifecycle hooks remain consistent
- ✅ Configuration schemas remain compatible
- ❌ Internal plugin architecture may change

**Breaking Changes**:
- Requires major version bump
- Requires plugin migration guide
- Requires deprecation period

### 6. Skill Format Compatibility

**Definition**: Skill file formats remain compatible across versions.

**Scope**:
- **Skill Manifest**: `skill.json` format
- **Skill Code**: JavaScript/TypeScript skill implementations
- **Skill Configuration**: Skill-specific configuration
- **Skill Communication**: Inter-skill communication

**Guarantees**:
- ✅ Skill manifest format remains stable
- ✅ Skill API remains consistent
- ✅ Skill configuration remains compatible
- ❌ Skill internals may change

**Deprecation Policy**:
- Deprecated skill features show warnings
- Removed features require major version bump
- New skill features may be added in any version

### 7. Protocol Compatibility

**Definition**: Communication protocols remain compatible across versions.

**Scope**:
- **HTTP Protocol**: REST API protocols
- **WebSocket Protocol**: Real-time communication
- **MCP Protocol**: Model Context Protocol
- **A2A Protocol**: Agent-to-Agent communication

**Guarantees**:
- ✅ Protocol message formats remain stable
- ✅ Protocol semantics remain consistent
- ✅ Error handling remains compatible
- ❌ Protocol internals may change
- ❌ Performance characteristics may vary

**Breaking Changes**:
- Requires major version bump
- Requires protocol migration guide
- Requires deprecation period

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

**Legend**:
- ✅ **Compatible**: Fully compatible, no changes required
- ⚠️ **May break**: Breaking changes possible, migration may be required

## Deprecation Policy

### General Policy

Titanium Claws follows a structured deprecation policy:

1. **Deprecation Announcement**
   - Feature marked as deprecated
   - Deprecation warnings shown
   - Migration guide published
   - Timeline for removal announced

2. **Deprecation Period**
   - Feature continues to work
   - Warnings shown on every use
   - Migration guide available
   - Support provided for migration

3. **Removal**
   - Feature removed in next major version
   - Major version bump required
   - Migration required for users
   - Removal documented in changelog

### Minimum Deprecation Period

- **Minimum**: One full major release cycle
- **Recommended**: Two major release cycles
- **Critical Features**: May have extended deprecation period

### Deprecation Warnings

Warnings include:
- **Feature Name**: What is deprecated
- **Replacement**: What to use instead
- **Removal Timeline**: When it will be removed
- **Migration Guide**: Link to migration instructions

**Example**:
```
DEPRECATION: OPENCLAW_STATE_DIR is deprecated.
Use TITANIUM_CLAWS_STATE_DIR instead.
Support will be removed in the next major version (v2.0.0).
Migration guide: https://docs.titaniumclaws.dev/migration/env-vars
```

## Compatibility Exceptions

### Security Fixes

Security fixes may break compatibility if necessary:
- **Priority**: Security over compatibility
- **Notification**: Users notified in advance
- **Migration**: Migration guide provided
- **Timeline**: Reasonable migration period

### Critical Bug Fixes

Critical bug fixes may break compatibility if:
- **Bug Severity**: Critical data loss or corruption
- **No Alternative**: No backward-compatible fix possible
- **Notification**: Users notified in advance
- **Migration**: Migration guide provided

### Performance Improvements

Performance improvements generally preserve compatibility:
- **API**: APIs remain compatible
- **Behavior**: Functional behavior preserved
- **Performance**: Performance characteristics may change
- **Notification**: Performance changes documented

## Version Numbering

### Semantic Versioning

Titanium Claws follows [Semantic Versioning 2.0.0](https://semver.org/):

**Format**: `MAJOR.MINOR.PATCH`

- **MAJOR**: Breaking changes (incompatible API changes)
- **MINOR**: New features (backward compatible)
- **PATCH**: Bug fixes (backward compatible)

### Pre-release Versions

Pre-release versions:
- **Alpha**: `1.0.0-alpha.1` - Early development
- **Beta**: `1.0.0-beta.1` - Feature complete, testing
- **Release Candidate**: `1.0.0-rc.1` - Final testing

### Compatibility Guarantees

**Stable Releases** (no pre-release suffix):
- Full compatibility guarantees apply
- Deprecation policy enforced
- Migration guides provided

**Pre-release Versions**:
- Compatibility may change without notice
- Deprecation policy not enforced
- Migration guides optional

## Migration Support

### Migration Guides

For every breaking change:
- **Migration Guide**: Step-by-step migration instructions
- **Examples**: Before/after code examples
- **Automated Tools**: Scripts to assist migration
- **Support**: Help with migration questions

### Migration Timeline

- **Advance Notice**: Breaking changes announced early
- **Deprecation Period**: Ample time to migrate
- **Support**: Help available during migration
- **Documentation**: Comprehensive migration documentation

### Migration Tools

Where possible, Titanium Claws provides:
- **Migration Scripts**: Automated migration tools
- **Validation Tools**: Tools to validate migration
- **Compatibility Layers**: Temporary compatibility shims
- **Documentation**: Migration documentation

## Enforcement

### Automated Checks

Titanium Claws uses automated checks to enforce compatibility:
- **API Compatibility**: Automated API compatibility checks
- **Configuration Validation**: Configuration schema validation
- **Protocol Checks**: Protocol compatibility validation
- **Plugin Validation**: Plugin interface validation

### Manual Review

Breaking changes require:
- **Architecture Review**: Review by architecture team
- **Compatibility Review**: Review for compatibility impact
- **Migration Review**: Review of migration plan
- **Documentation Review**: Review of migration documentation

### Release Process

Release process includes:
- **Compatibility Check**: Verify compatibility policy
- **Deprecation Check**: Verify deprecation policy
- **Migration Check**: Verify migration guides
- **Documentation Check**: Verify documentation updates

## Communication

### Changelog

Every release includes:
- **Compatibility Changes**: Changes affecting compatibility
- **Deprecations**: Newly deprecated features
- **Removals**: Features removed in this version
- **Migration Notes**: Migration instructions

### Release Notes

Major releases include:
- **Breaking Changes**: List of all breaking changes
- **Migration Guide**: Comprehensive migration guide
- **Deprecation Timeline**: Timeline for deprecations
- **Support**: Support information for migration

### Announcements

Breaking changes announced via:
- **GitHub Releases**: Release notes
- **GitHub Discussions**: Discussion threads
- **Documentation**: Updated documentation
- **Social Media**: Announcements on social platforms

## Contact

For compatibility questions:

- **GitHub Issues**: [titanium-claws/issues](https://github.com/YOUR_USERNAME/titanium-claws/issues) with `compatibility` label
- **GitHub Discussions**: [titanium-claws/discussions](https://github.com/YOUR_USERNAME/titanium-claws/discussions) with `compatibility` category

---

**Last Updated**: 2026-07-21  
**Version**: 1.0.0  
**Status**: Active
