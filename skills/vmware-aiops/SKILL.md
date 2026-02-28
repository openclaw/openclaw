---
name: vmware-aiops
description: "VMware vCenter/ESXi AI-powered monitoring and operations via `vmware-aiops` CLI: inventory queries, health/alarms/logs, VM lifecycle (create, delete, power, snapshot, clone, migrate), vSAN management, and scheduled log scanning. Use when: (1) querying VMs, hosts, datastores, clusters, (2) checking alarms, events, hardware sensors, (3) managing VM power/snapshots/cloning, (4) monitoring vSAN health and capacity. NOT for: vSphere Web Client UI operations, NSX networking, or Horizon VDI management."
metadata:
  {
    "openclaw":
      {
        "emoji": "🖥️",
        "requires": { "bins": ["vmware-aiops"] },
        "install":
          [
            {
              "id": "pip",
              "kind": "pip",
              "package": "vmware-aiops",
              "bins": ["vmware-aiops"],
              "label": "Install VMware AIops (pip)",
            },
          ],
      },
  }
---

# VMware AIops

AI-powered VMware vCenter and ESXi operations tool. Manage your entire VMware infrastructure using natural language.

## Setup

```bash
git clone https://github.com/zw008/VMware-AIops.git
cd VMware-AIops
python3 -m venv .venv && source .venv/bin/activate
pip install -e .

# Configure
mkdir -p ~/.vmware-aiops
cp config.example.yaml ~/.vmware-aiops/config.yaml
cp .env.example ~/.vmware-aiops/.env
chmod 600 ~/.vmware-aiops/.env
```

## Commands

```bash
# Inventory
vmware-aiops inventory vms [--target <name>]
vmware-aiops inventory hosts [--target <name>]
vmware-aiops inventory datastores [--target <name>]
vmware-aiops inventory clusters [--target <name>]

# Health
vmware-aiops health alarms [--target <name>]
vmware-aiops health events [--hours 24] [--severity warning]

# VM Operations
vmware-aiops vm info <vm-name>
vmware-aiops vm power-on <vm-name>
vmware-aiops vm power-off <vm-name> [--force]
vmware-aiops vm create <name> [--cpu <n>] [--memory <mb>] [--disk <gb>]
vmware-aiops vm delete <vm-name> [--confirm]
vmware-aiops vm snapshot-create <vm-name> --name <snap-name>
vmware-aiops vm snapshot-list <vm-name>
vmware-aiops vm clone <vm-name> --new-name <name>
vmware-aiops vm migrate <vm-name> --to-host <host>

# vSAN
vmware-aiops vsan health [--target <name>]
vmware-aiops vsan capacity [--target <name>]

# Scanning
vmware-aiops scan now [--target <name>]
vmware-aiops daemon start|stop|status
```

## Security

- **NEVER** hardcode passwords — use `~/.vmware-aiops/.env` with `chmod 600`
- **ALWAYS** use `ConnectionManager.from_config()` for connections
- Destructive operations (power-off, delete) require double confirmation
