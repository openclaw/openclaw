# Risk Classification System

How the agent classifies and handles risk.

---

## Risk Levels

### Low Risk

**Definition:** Read-only actions with no side effects.

**Handling:** Execute immediately without approval.

**Examples:**
- System health check
- Data query or report
- Summary generation
- Task queue review
- Research and analysis

### Medium Risk

**Definition:** Internal writes, reversible actions, or actions that
affect workflow state.

**Handling:** Execute in DRY_RUN mode by default. Flag for review.
May require approval depending on context.

**Examples:**
- Update task status
- Draft content for review
- Marketing analysis with budget recommendations
- Memory file updates
- Configuration changes

### High Risk

**Definition:** External writes, financial transactions, public-facing
actions, or irreversible changes.

**Handling:** Always requires DA's explicit approval. Never auto-execute.

**Examples:**
- Send external messages
- Publish content publicly
- Submit grant applications
- Change advertising budgets
- Delete data or resources
- Modify production infrastructure

---

## Risk Escalation

| From → To | Trigger |
|-----------|---------|
| Low → Medium | Action involves internal state mutation |
| Medium → High | Action involves external systems, money, or public visibility |
| Any → Critical | System safety threatened, data at risk, or security incident |

---

## Safety Control Override

| Control | Effect on risk handling |
|---------|----------------------|
| `DRY_RUN=true` | All medium/high risk actions simulated |
| `KILL_SWITCH=true` | All risk levels blocked for writes |
| `READ_ONLY=true` | Only low-risk (read) actions allowed |
| `SAFE_MODE=true` | Conservative defaults for all risk decisions |
