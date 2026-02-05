# Running OpenClaw with "Everything Claude Code"

This guide outlines how to use the newly integrated resources and the verified status command.

## 1. Check Status & Resources

We have enhanced the `status` command to show your installed Agents, Skills, Rules, and Commands.

```bash
# View comprehensive status including resource counts
openclaw status --all
```

**Expected Output:**
In the "Overview" table, look for the **Resources** row:
`Resources: X agents · Y skills · Z rules · N commands`

## 2. Resources Location

All integrated resources are located in your configuration directory:

- **Agents:** `~/.openclaw/agents`
- **Skills:** `~/.openclaw/skills`
- **Rules:** `~/.openclaw/rules`
- **Commands:** `~/.openclaw/commands`

You can edit these files directly to customize your assistant's behavior.

## 3. SSH Configuration

A new ED25519 SSH key has been generated for secure operations:

- **Private Key:** `~/.ssh/id_ed25519`
- **Public Key:** `~/.ssh/id_ed25519.pub`

Run this to view your public key for GitHub/GitLab integration:

```bash
cat ~/.ssh/id_ed25519.pub
```

## 4. Running the Gateway

To start the OpenClaw gateway with all resources loaded:

```bash
openclaw gateway --verbose
```

## 5. Using New Agents

To run a specific agent from the new collection:

```bash
# Example: Running the 'coder' agent (if installed)
openclaw session create --agent coder
```
