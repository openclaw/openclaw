# Memory Migration Plan: workspace/memory → myVault

## Overview
Merge the FrankOS Second Brain data from `workspace/memory/` into the existing `myVault/` structure while preserving data integrity and handling conflicts.

---

## Conflict Resolution Strategy

| Conflict Type | Resolution Rule |
|--------------|-----------------|
| **Exact Duplicates** | Skip (keep myVault version) |
| **Same Path, Different Content** | Append timestamp to workspace version: `filename-YYYYMMDD.md` |
| **Workspace has newer date** | Prompt user for decision |
| **Config files (.kilo, .codex, .openclaw)** | Merge configurations, keeping myVault as base |
| **Unique files (only in workspace)** | Move to myVault maintaining folder structure |

---

## Migration Steps

### Phase 1: Pre-Migration Analysis
1. **Inventory both directories**
   - List all files in `workspace/memory/` (source)
   - List all files in `myVault/` (target)
   - Identify overlapping paths

2. **Generate conflict report**
   - Files with identical names in both locations
   - Files with same path but different sizes
   - Config files that need merging

### Phase 2: Safe Migration (with backups)
3. **Create backup of myVault**
   - Copy `myVault/` to `myVault-backup-YYYYMMDD/`

4. **Process root-level files**
   - `README.md` → Compare, merge if different
   - `BOOT_MEMORY.md` → Move if not in myVault
   - `.kilo` → Merge with myVault/.kilo
   - `.codex` → Merge with myVault/.codex
   - `.openclaw` → Merge with myVault/.openclaw

5. **Process numbered folders (00-15)**
   For each folder (00_Inbox, 01_Projects, 02_Areas, etc.):
   - Ensure folder exists in myVault
   - For each file:
     - If doesn't exist: Move to myVault
     - If exists and identical: Skip
     - If exists and different: Rename with timestamp, then move

6. **Process scripts folder**
   - `memory/scripts/` → `myVault/scripts/`
   - Handle conflicts per resolution rules

7. **Process memory/ subfolder**
   - `memory/memory/*.md` → `myVault/memory/`
   - Merge daily log files

### Phase 3: Validation
8. **Verify migration completeness**
   - Count files in source vs. destination
   - Check for any files that failed to move

9. **Test configuration files**
   - Validate .kilo file syntax
   - Validate .codex file syntax

### Phase 4: Cleanup
10. **Add workspace/ to .gitignore**
    - Append `workspace/` to `.gitignore`
    - Commit the change

11. **Remove workspace/memory** (after verification)
    - Only after confirming all data migrated successfully
    - Keep backup until next successful repo refresh

---

## Post-Migration Structure

```
myVault/
├── .kilo                    # Merged config
├── .codex                   # Merged config
├── .openclaw                # Merged config
├── README.md                # Merged content
├── BOOT_MEMORY.md           # From workspace
├── 00_Inbox/                # Merged content
├── 01_Projects/             # Merged content
│   ├── Automated-Testing-Framework.md
│   ├── OpenClaw-Ollama-Integration-Test.md
│   └── OpenClaw-Ollama-Performance-Diagnosis.md
├── 02_Areas/                # Merged content
│   ├── Agent-Governance/
│   ├── AI-Infrastructure/
│   ├── Claude-Code/
│   ├── Cost-Optimization/
│   ├── Culinary-Experiments/
│   ├── Hardware-Lab/
│   ├── Ollama-Operations/
│   └── OpenClaw/
├── 10_Constitution/         # Merged content
├── 11_Agents/               # Merged content
├── 12_Ledger/               # Merged content
├── 13_Memory/               # Merged content
├── 14_Schemas/              # Merged content
├── 15_ChangeLogs/           # Merged content
├── memory/                  # Daily logs from workspace/memory
└── scripts/                 # PowerShell scripts
```

---

## Rollback Plan

If migration fails:
1. Restore from `myVault-backup-YYYYMMDD/`
2. Review conflict report
3. Address issues and retry

---

## Success Criteria

- [ ] All files from `workspace/memory/` migrated or accounted for
- [ ] No data loss (verified by file counts)
- [ ] Config files (.kilo, .codex, .openclaw) valid and merged
- [ ] `workspace/` added to `.gitignore`
- [ ] Backup retained for safety
