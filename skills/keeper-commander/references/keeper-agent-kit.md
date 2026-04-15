# Keeper Agent Kit

Repository: https://github.com/Keeper-Security/keeper-agent-kit

Use this repository as the primary design reference for how Keeper skills are split.

## Main skill families

- `keeper-secrets`
  - for Keeper Secrets Manager / app-secret workflows
  - use for injection, templates, CI/CD, and runtime secrets
- `keeper-admin`
  - for Keeper Commander / admin workflows
  - use for users, teams, PAM, enterprise vault operations
- `keeper-setup`
  - for installation, profiles, and first-time setup

## Key takeaway

Do not force every Keeper task through one command style.

First classify the request:
- app/runtime secret handling → KSM path
- admin or interactive vault operations → Commander path
- installation or first-run configuration → setup path

## Installation note from repo

The repo documents two broad adoption paths:
- marketplace / skills add flow
- cloning and copying plugin skill directories into an agent skills folder

For OpenClaw workspace usage here, keep the custom skill in the workspace `skills/` directory unless the user asks for a different location.
