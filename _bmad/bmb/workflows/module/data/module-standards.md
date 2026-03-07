# Module Standards

**Purpose:** Defines what a BMAD module is, its structure, and the three types of modules.

---

## What is a BMAD Module?

A **BMAD module** is a self-contained package of functionality that extends the BMAD framework. Modules provide:

- **Agents** — AI personas with specialized expertise and menu-driven commands
- **Workflows** — Structured processes for accomplishing complex tasks
- **Configuration** — module.yaml for user customization

---

## Module Types

### 1. Standalone Module

A new, independent module focused on a specific domain.

**Characteristics:**

- Own module code (e.g., `healthcare-ai`, `legal-assist`)
- Independent of other modules
- Can be installed alongside any other modules
- Has its own agents, workflows, configuration

**Location:** `src/modules/{module-code}/`

**Example:** CIS (Creative Innovation Suite) — a standalone module for innovation workflows

---

### 2. Extension Module

Extends an existing BMAD module with additional functionality.

**Characteristics:**

- Builds upon an existing module's agents and workflows
- May add new agents or workflows that complement the base module
- Shares configuration context with the extended module
- Typically installed alongside the module it extends

**Location:** `src/modules/{base-module}/extensions/{extension-code}/`

**Example:** An extension to BMM that adds specialized security review workflows

---

### Extension Module: Override & Merge Pattern

When an extension module is installed, its files merge with the base module following these rules:

#### Code Matching

The extension's `module.yaml` `code:` field matches the base module's code:

```yaml
# Base module: src/modules/bmm/module.yaml
code: bmm

# Extension: src/modules/bmm/extensions/security/module.yaml
code: bmm  # SAME CODE — extends BMM
```

The **folder name** is unique (e.g., `bmm-security`) but the `code:` matches the base module.

#### File Merge Rules

| File Type       | Same Name                                 | Different Name               |
| --------------- | ----------------------------------------- | ---------------------------- |
| Agent file      | **OVERRIDE** — replaces the base agent    | **ADD** — new agent added    |
| Workflow folder | **OVERRIDE** — replaces the base workflow | **ADD** — new workflow added |
| Other files     | **OVERRIDE** — replaces base file         | **ADD** — new file added     |

#### Examples

**Override scenario:**

```
Base module (BMM):
├── agents/
│   └── pm.agent.yaml          # Original PM agent

Extension (bmm-security):
├── agents/
│   └── pm.agent.yaml          # Security-focused PM — REPLACES original

Result after installation:
├── agents/
│   └── pm.agent.yaml          # Now the security version
```

**Add scenario:**

```
Base module (BMM):
├── agents/
│   ├── pm.agent.yaml
│   └── architect.agent.yaml

Extension (bmm-security):
├── agents/
│   └── security-auditor.agent.yaml  # NEW agent

Result after installation:
├── agents/
│   ├── pm.agent.yaml
│   ├── architect.agent.yaml
│   └── security-auditor.agent.yaml  # ADDED
```

**Mixed scenario:**

```
Extension contains both overrides and new files — applies rules per file
```

---

### 3. Global Module

Affects the entire BMAD framework and all modules.

**Characteristics:**

- Core functionality that impacts all modules
- Often provides foundational services or utilities
- Installed at the framework level
- Use sparingly — only for truly global concerns

**Location:** `src/modules/{module-code}/` with `global: true` in module.yaml

**Example:** A module that provides universal logging or telemetry across BMAD

---

## Required Module Structure

```
{module-code}/
├── module.yaml                 # Module configuration (REQUIRED)
├── README.md                   # Module documentation (REQUIRED)
├── agents/                     # Agent definitions (if any)
│   └── {agent-name}.agent.yaml
├── workflows/                  # Workflow definitions (if any)
│   └── {workflow-name}/
│       └── workflow.md
└── {other folders}             # Tasks, templates, data as needed
```

---

## Required Files

### module.yaml (REQUIRED)

Every module MUST have a `module.yaml` file with at minimum:

```yaml
code: { module-code }
name: "Module Display Name"
header: "Brief module description"
subheader: "Additional context"
default_selected: false
```

See: `module-yaml-conventions.md` for full specification.

---

### README.md (REQUIRED)

Every module MUST have a README.md with:

- Module name and purpose
- Installation instructions
- Components section (agents, workflows)
- Quick start guide
- Module structure diagram
- Configuration section
- Usage examples
- Author information

---

## Optional Components

### Agents

Agents are AI personas with:

- Metadata (id, name, title, icon, module)
- Persona (role, identity, communication_style, principles)
- Menu (trigger → workflow/exec mappings)

See: `agent-architecture.md` for design guidance.

---

### Workflows

Workflows are structured processes with:

- workflow.md (entry point)
- steps/ folder with step files
- data/ folder with shared reference
- templates/ folder if needed

---

---

## Module Type Decision Tree

```
START: Creating a module
│
├─ Is this a brand new independent domain?
│  └─ YES → Standalone Module
│
├─ Does this extend an existing module?
│  └─ YES → Extension Module
│
└─ Does this affect all modules globally?
   └─ YES → Global Module (use sparingly)
```

---

## Naming Conventions

### Module Code

- **kebab-case** (e.g., `bmm`, `cis`, `bmgd`, `healthcare-ai`)
- Short, memorable, descriptive
- 2-20 characters
- Lowercase letters, numbers, hyphens only

### Agent Files

- Format: `{role-name}.agent.yaml`
- Example: `pm.agent.yaml`, `architect.agent.yaml`

### Workflow Folders

- Format: `{workflow-name}/`
- Example: `prd/`, `create-architecture/`

---

## Module Dependencies

Modules can depend on:

- **Core BMAD** — Always available
- **Other modules** — Specify in module.yaml as `dependencies:`
- **External tools** — Document in README

---

## Quick Reference

| Question                    | Answer                                              |
| --------------------------- | --------------------------------------------------- |
| What's a module?            | Self-contained package of agents, workflows, config |
| What are the types?         | Standalone, Extension, Global                       |
| What's required?            | module.yaml, README.md                              |
| Where do modules live?      | `src/modules/{code}/`                               |
| How do agents work?         | Menu triggers → workflow/exec                       |
| How does installation work? | module.yaml prompts                                 |
