# module.yaml Conventions

**Purpose:** Defines how module.yaml works, including variables, templates, and how they provide context to agents and workflows.

---

## Overview

`module.yaml` is the configuration file for a BMAD module. It:

- Defines module metadata (code, name, description)
- Collects user input via prompts during installation
- Makes those inputs available to agents and workflows as variables
- Specifies which module should be selected by default

---

## Frontmatter Fields

### Required Fields

```yaml
code: { module-code } # kebab-case identifier
name: "Display Name" # Human-readable name
header: "Brief description" # One-line summary
subheader: "Additional context" # More detail
default_selected: false # Auto-select on install?
```

### `default_selected` Guidelines

| Module Type  | default_selected | Example                                    |
| ------------ | ---------------- | ------------------------------------------ |
| Core/Primary | `true`           | BMM (agile software delivery)              |
| Specialized  | `false`          | CIS (creative innovation), BMGD (game dev) |
| Experimental | `false`          | New modules in development                 |

---

## Variables System

### Core Config Variables (Always Available)

These variables are automatically available to ALL modules:

```yaml
# Variables from Core Config inserted:
## user_name                  # User's name
## communication_language     # Preferred language
## document_output_language    # Output document language
## output_folder             # Default output location
```

No need to define these — they're injected automatically.

---

### Custom Variables

Define custom variables for user input:

```yaml
variable_name:
  prompt: "Question to ask the user?"
  default: "{default_value}"
  result: "{template_for_final_value}"
```

**Example:**

```yaml
project_name:
  prompt: "What is the title of your project?"
  default: "{directory_name}"
  result: "{value}"
```

### Variable Templates

In `prompt` and `result`, you can use templates:

| Template           | Expands To                     |
| ------------------ | ------------------------------ |
| `{value}`          | The user's input               |
| `{directory_name}` | Current directory name         |
| `{output_folder}`  | Output folder from core config |
| `{project-root}`   | Project root path              |
| `{variable_name}`  | Another variable's value       |

---

## Variable Types

### 1. Simple Text Input

```yaml
project_name:
  prompt: "What is the title of your project?"
  default: "{directory_name}"
  result: "{value}"
```

---

### 2. Boolean/Flag

```yaml
enable_feature:
  prompt: "Enable this feature?"
  default: false
  result: "{value}"
```

---

### 3. Single Select

```yaml
skill_level:
  prompt: "What is your experience level?"
  default: "intermediate"
  result: "{value}"
  single-select:
    - value: "beginner"
      label: "Beginner - Explains concepts clearly"
    - value: "intermediate"
      label: "Intermediate - Balanced approach"
    - value: "expert"
      label: "Expert - Direct and technical"
```

---

### 4. Multi Select

```yaml
platforms:
  prompt: "Which platforms do you need?"
  default: ["unity", "unreal"]
  result: "{value}"
  multi-select:
    - value: "unity"
      label: "Unity"
    - value: "unreal"
      label: "Unreal Engine"
    - value: "godot"
      label: "Godot"
```

---

### 5. Multi-Line Prompt

```yaml
complex_variable:
  prompt:
    - "First question?"
    - "Second context?"
    - "Third detail?"
  default: "default_value"
  result: "{value}"
```

---

### 6. Required Variable

```yaml
critical_variable:
  prompt: "Required information:"
  required: true
  result: "{value}"
```

---

### 7. Path Variable

```yaml
artifacts_folder:
  prompt: "Where should artifacts be stored?"
  default: "{output_folder}/artifacts"
  result: "{project-root}/{value}"
```

---

## Variable Inheritance / Aliasing

Create an alias for another variable:

```yaml
primary_artifacts:
  prompt: "Where should primary artifacts be stored?"
  default: "{output_folder}/artifacts"
  result: "{project-root}/{value}"

# Alias for workflow compatibility
sprint_artifacts:
  inherit: "primary_artifacts"
```

Now `sprint_artifacts` and `primary_artifacts` reference the same value.

---

## How Variables Become Available

### To Agents

After installation, variables are available in agent frontmatter/context:

```yaml
# In agent.agent.yaml or workflow execution
{ variable_name } # Expands to the user's configured value
```

**Example:** If the user configured `project_name: "MyApp"`, agents can reference `{project_name}` and it will expand to `"MyApp"`.

### To Workflows

Workflows can reference module variables in their step files:

```yaml
---
outputFile: "{implementation_artifacts}/my-output.md"
---
```

This expands the `implementation_artifacts` variable from module.yaml.

---

## Real-World Examples

### BMM (BMad Method) — Complex Configuration

```yaml
code: bmm
name: "BMM: BMad Method Agile-AI Driven-Development"
header: "BMad Method™: Breakthrough Method of Agile-Ai Driven-Dev"
subheader: "Agent and Workflow Configuration for this module"
default_selected: true

# Variables from Core Config inserted:
## user_name
## communication_language
## document_output_language
## output_folder

project_name:
  prompt: "What is the title of your project?"
  default: "{directory_name}"
  result: "{value}"

user_skill_level:
  prompt:
    - "What is your development experience level?"
    - "This affects how agents explain concepts."
  default: "intermediate"
  result: "{value}"
  single-select:
    - value: "beginner"
      label: "Beginner - Explain concepts clearly"
    - value: "intermediate"
      label: "Intermediate - Balanced approach"
    - value: "expert"
      label: "Expert - Direct and technical"

planning_artifacts:
  prompt: "Where should planning artifacts be stored?"
  default: "{output_folder}/planning-artifacts"
  result: "{project-root}/{value}"

implementation_artifacts:
  prompt: "Where should implementation artifacts be stored?"
  default: "{output_folder}/implementation-artifacts"
  result: "{project-root}/{value}"

project_knowledge:
  prompt: "Where should project knowledge be stored?"
  default: "docs"
  result: "{project-root}/{value}"

tea_use_mcp_enhancements:
  prompt: "Enable MCP enhancements in Test Architect?"
  default: false
  result: "{value}"
```

---

### CIS (Creative Innovation Suite) — Minimal Configuration

```yaml
code: cis
name: "CIS: Creative Innovation Suite"
header: "Creative Innovation Suite (CIS) Module"
subheader: "No custom configuration - uses Core settings only"
default_selected: false

# Variables from Core Config inserted:
## user_name
## communication_language
## document_output_language
## output_folder
```

Some modules don't need custom variables — core config is enough!

---

### BMGD (Game Development) — Multi-Select Example

```yaml
code: bmgd
name: "BMGD: BMad Game Development"
header: "BMad Game Development Module"
subheader: "Configure game development settings"
default_selected: false

project_name:
  prompt: "What is the name of your game project?"
  default: "{directory_name}"
  result: "{value}"

primary_platform:
  prompt: "Which game engine do you use?"
  default: ["unity", "unreal"]
  required: true
  result: "{value}"
  multi-select:
    - value: "unity"
      label: "Unity"
    - value: "unreal"
      label: "Unreal Engine"
    - value: "godot"
      label: "Godot"
    - value: "other"
      label: "Custom / Other"
```

---

## Best Practices

### DO:

- Keep prompts clear and concise
- Provide sensible defaults
- Use `result: "{project-root}/{value}"` for paths
- Use single/multi-select for structured choices
- Group related variables logically

### DON'T:

- Overwhelm users with too many questions
- Ask for information that could be inferred
- Use technical jargon in prompts
- Create variables that are never used

---

## Variable Naming

- **kebab-case** (e.g., `planning_artifacts`, `user_skill_level`)
- Descriptive but concise
- Avoid conflicts with core variables

---

## Testing Your module.yaml

After creating module.yaml, test it:

1. Run `bmad install` in a test project
2. Verify prompts appear correctly
3. Check that variables expand in agents/workflows
4. Test default values
5. Validate path templates resolve correctly

---

## Quick Reference

| Pattern           | Use Case                          |
| ----------------- | --------------------------------- |
| Simple text input | Names, titles, descriptions       |
| Boolean/Flag      | Enable/disable features           |
| Single select     | Experience levels, categories     |
| Multi select      | Platforms, frameworks, options    |
| Multi-line prompt | Complex questions needing context |
| Required          | Must-have information             |
| Path variable     | Directory locations               |
| Inherit/Alias     | Compatibility, references         |
