# exec-denylist

A lightweight command execution gatekeeper that blocks high-risk commands by pattern matching against a configurable denylist.

## Features

- Pattern-based command blocking using regex
- Configurable denylist via YAML config
- Severity levels (critical, high, medium) with corresponding actions
- Dry-run mode for testing rules
- Detailed denial reasons in structured output
- Extensible: add custom patterns without code changes

## Installation

bash
pip install -e .


## Usage

### CLI

bash
# Check a command against the denylist
exec-denylist check "rm -rf /"

# Check with dry-run (log but don't block)
exec-denylist check --dry-run "DROP TABLE users"

# Validate your config
exec-denylist validate

# List all configured rules
exec-denylist list-rules


### Python API

python
from exec_denylist import DenylistEngine

engine = DenylistEngine.from_config("denylist.yaml")
result = engine.evaluate("rm -rf /")

if result.denied:
    print(f"Blocked: {result.reason}")
else:
    print("Approved")


## Configuration

Edit denylist.yaml to add/modify rules:

yaml
rules:
  - id: no-recursive-force-delete
    pattern: "rm\\s+(-[a-zA-Z]*f[a-zA-Z]*\\s+-[a-zA-Z]*r|--force.*-r|-rf|-fr)\\s"
    severity: critical
    description: "Blocks recursive force delete"


### Severity Levels

| Level    | Behavior         |
|----------|------------------|
| critical | Always denied    |
| high     | Denied by default, can be overridden with --allow-high |
| medium   | Logged as warning, denied in strict mode |

## Testing

bash
pytest