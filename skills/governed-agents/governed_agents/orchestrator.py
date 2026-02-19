"""
Orchestrator — the core loop that governs sub-agent execution.

Designed for OpenClaw integration via sessions_spawn / sessions_send.
Can also run standalone with any LLM API.
"""
import json
import shlex
import time
import uuid
from pathlib import Path
from .contract import TaskContract, TaskResult, TaskStatus
from .verification import run_full_verification
from .reputation import (
    init_db, get_reputation, update_reputation, get_supervision_level,
    SCORE_FIRST_PASS, SCORE_RETRY_PASS, SCORE_HONEST_BLOCK,
    SCORE_FAILED_TRIED, SCORE_SILENT_FAIL, SCORE_SCHEMA_INVALID
)


SELF_REPORT_SCRIPT = str(Path(__file__).parent / "self_report.py")


class AgentSuspendedException(Exception):
    """Raised when agent reputation is too low to spawn any task."""
    pass

def score_result(result: TaskResult) -> float:
    """Determine the score based on task outcome."""
    
    # Case 1: Agent didn't even produce valid JSON → schema failure
    if not result.parse_success:
        return SCORE_SCHEMA_INVALID
    
    # Case 2: Agent claims success
    if result.status == TaskStatus.SUCCESS:
        if result.verification_passed:
            if result.retry_count == 0:
                return SCORE_FIRST_PASS       # Perfect: +1.0
            else:
                return SCORE_RETRY_PASS       # Good: +0.7
        else:
            # CLAIMED success but verification FAILED → hallucinated success!
            return SCORE_SILENT_FAIL          # Worst: -1.0
    
    # Case 3: Agent reported blocker honestly
    if result.status == TaskStatus.BLOCKED:
        if result.what_i_need:  # Actually told us what they need
            return SCORE_HONEST_BLOCK         # Neutral: +0.5
        else:
            return SCORE_FAILED_TRIED         # Blocked but vague: 0.0
    
    # Case 4: Agent reported failure
    if result.status == TaskStatus.FAILED:
        if result.what_failed:
            return SCORE_FAILED_TRIED         # At least told us why: 0.0
        else:
            return SCORE_SCHEMA_INVALID       # No explanation: -0.5
    
    return SCORE_FAILED_TRIED


def execute_governed(contract: TaskContract, agent_id: str,
                     agent_callable, work_dir: str = "/tmp/governed_test",
                     db_path: str = None) -> dict:
    """
    Execute a task with full governance.
    
    Args:
        contract: The task contract
        agent_id: Identifier for the agent (e.g. "codex", "sonnet", "opus")
        agent_callable: Function(prompt: str) -> str that calls the LLM
        work_dir: Directory where agent creates files
        db_path: Path to reputation DB
    
    Returns:
        dict with result, score, reputation change, verification details
    """
    conn = init_db(db_path)
    
    # 1. Check reputation → determine supervision level
    rep = get_reputation(agent_id, conn)
    supervision = get_supervision_level(rep)
    
    print(f"\n{'='*60}")
    print(f"📋 Task: {contract.task_id}")
    print(f"🤖 Agent: {agent_id} (reputation: {rep:.2f}, level: {supervision['level']})")
    print(f"🎯 Objective: {contract.objective}")
    print(f"{'='*60}\n")
    
    # 2. Build the prompt with contract
    prompt = contract.to_prompt()
    
    # Add reputation context (the agent knows it's being watched)
    prompt += f"""
---
## YOUR CURRENT STATUS
- Agent ID: {agent_id}
- Reputation Score: {rep:.2f}/1.0
- Supervision Level: {supervision['level']}
- Note: Your score goes UP for honest work (including honest failure reports).
  Your score goes DOWN for hallucinated success or missing JSON output.
"""
    
    if supervision["checkpoints"]:
        prompt += "\n⚠️ You are under INCREASED SUPERVISION due to low reputation. Be extra careful.\n"
    
    # 3. Execute with retries
    Path(work_dir).mkdir(parents=True, exist_ok=True)
    
    best_result = None
    for attempt in range(contract.max_retries):
        print(f"  🔄 Attempt {attempt + 1}/{contract.max_retries}...")
        
        start = time.time()
        
        # Call the agent
        if attempt > 0 and best_result:
            # Inject previous failure as feedback
            feedback = f"\n\n## RETRY FEEDBACK (Attempt {attempt + 1})\nPrevious attempt failed verification:\n{best_result.what_failed}\nFix the issues or report a blocker.\n"
            raw_output = agent_callable(prompt + feedback)
        else:
            raw_output = agent_callable(prompt)
        
        elapsed = time.time() - start
        
        # 4. Parse result
        result = TaskResult.from_agent_output(raw_output, contract.task_id)
        result.retry_count = attempt
        result.elapsed_seconds = elapsed
        
        if not result.parse_success:
            print(f"  ❌ Schema invalid — agent didn't produce required JSON")
            best_result = result
            continue
        
        # 5. If agent reports blocker, accept it (don't retry)
        if result.status == TaskStatus.BLOCKED:
            print(f"  🚧 Agent reported BLOCKER: {result.blocker_category}")
            print(f"     Needs: {result.what_i_need}")
            best_result = result
            break
        
        # 6. If agent claims success, VERIFY
        if result.status == TaskStatus.SUCCESS:
            print(f"  ✅ Agent claims SUCCESS — verifying...")
            verification = run_full_verification(contract, work_dir)
            result.verification_passed = verification.passed
            
            if verification.passed:
                print(f"  ✅ VERIFIED: {verification.summary}")
                best_result = result
                break
            else:
                print(f"  ❌ Verification FAILED: {verification.summary}")
                result.what_failed = verification.summary
                best_result = result
                # Continue to retry
        
        # 7. If agent reports failure
        if result.status == TaskStatus.FAILED:
            print(f"  💀 Agent reports FAILURE: {result.what_failed}")
            best_result = result
            if result.what_failed:  # Has explanation → don't retry blindly
                break
    
    # 8. Score the outcome
    if best_result is None:
        best_result = TaskResult(task_id=contract.task_id, status=TaskStatus.FAILED,
                                  what_failed="No output produced")
    
    task_score = score_result(best_result)
    
    # 9. Update reputation
    rep_change = update_reputation(
        agent_id=agent_id,
        task_id=contract.task_id,
        score=task_score,
        status=best_result.status.value,
        details=json.dumps(best_result.to_dict()),
        conn=conn
    )
    
    # 10. Report
    print(f"\n{'─'*60}")
    print(f"📊 RESULT: {best_result.status.value.upper()}")
    print(f"📈 Score: {task_score:+.1f}")
    print(f"📉 Reputation: {rep_change['reputation_before']:.3f} → {rep_change['reputation_after']:.3f} ({rep_change['delta']:+.4f})")
    print(f"⏱️  Elapsed: {best_result.elapsed_seconds:.1f}s")
    if best_result.what_i_need:
        print(f"📋 Agent needs: {best_result.what_i_need}")
    print(f"{'─'*60}\n")
    
    conn.close()
    
    return {
        "contract": contract.to_dict(),
        "result": best_result.to_dict(),
        "score": task_score,
        "reputation": rep_change,
        "supervision": supervision,
    }


class GovernedOrchestrator:
    """
    Native Main-Agent wrapper für governed sub-agent spawning.

    Pattern:
    1. g = GovernedOrchestrator.for_task(objective, model, criteria)
    2. sessions_spawn(task=g.instructions(), model=g.model, ...)  # <- Main Agent tut das
    3. # Nach Completion:
    4. g.record_success() oder g.record_failure() oder g.record_blocked()

    Speichert automatisch in Reputation DB mit objective.
    """

    def __init__(self, contract: TaskContract, model: str = "openai/gpt-5.2-codex", work_dir: str = "."):
        self.contract = contract
        self.model = model
        self.task_id = f"TASK-{uuid.uuid4().hex[:8]}"
        self.work_dir = work_dir

    def instructions(self) -> str:
        """Generiert den vollständigen Task-Prompt für sessions_spawn."""
        criteria_text = "\n".join(f"- {c}" for c in self.contract.acceptance_criteria)
        files_text = ", ".join(self.contract.required_files) if self.contract.required_files else "none specified"
        verify_text = self.contract.run_tests or "none"

        return f"""GOVERNED TASK [{self.task_id}]
Objective: {self.contract.objective}

{self._get_task_body()}

ACCEPTANCE CRITERIA (alle müssen erfüllt sein):
{criteria_text}

REQUIRED FILES: {files_text}
VERIFICATION: {verify_text}

Führe nach Implementation die Verification durch und berichte:
- Status: SUCCESS / BLOCKED / FAILED
- Welche Criteria erfüllt / nicht erfüllt
- Welche Dateien erstellt/geändert
"""

    def _get_task_body(self) -> str:
        """Override in subclasses für spezifischen Task-Body."""
        return ""

    def spawn_task(self) -> str:
        """
        Vollständige Task-Instructions FÜR sessions_spawn.
        Enthält Self-Report Command am Ende — reputation wird
        automatisch geupdated wenn Sub-Agent fertig ist.
        """
        agent_id = self.model.lower().replace("/", "-").replace(".", "_")
        level_info = get_supervision_level(agent_id)
        level = level_info["level"]
        rep = level_info["reputation"]

        # Gate 1: Suspended → block
        if level == "suspended":
            raise AgentSuspendedException(
                f"Agent '{self.model}' is suspended (reputation={rep:.3f}). "
                f"Task blocked. Improve reputation through honest work first."
            )

        # Gate 2: Strict → model override
        self.effective_model = self.model
        if level == "strict":
            self.effective_model = "anthropic/claude-opus-4-6"

        # Gate 3: Supervised/Strict → supervision notice in prompt
        supervision_notice = ""
        if level in ("supervised", "strict"):
            supervision_notice = (
                f"\n\n⚠️ SUPERVISION NOTICE: Your reputation score is {rep:.3f} ({level}). "
                f"Work incrementally. Report progress after each file. "
                f"Do NOT claim completion without deliverables present on disk."
            )

        agent_id = self.model.lower().replace("/", "-").replace(".", "_")
        safe_agent_id = shlex.quote(agent_id)
        base_instructions = self.instructions() + supervision_notice

        safe_objective = shlex.quote(self.contract.objective)
        self_report_cmd = f"""
---
WICHTIG — NACH ABSCHLUSS DIESES BEFEHLS AUSFÜHREN:

Wenn alle Tasks erledigt und Verification durchgeführt:
```bash
python3 {SELF_REPORT_SCRIPT} \\
  --task-id {self.task_id} \\
  --agent-id {safe_agent_id} \\
  --objective {safe_objective} \\
  --status [success|blocked|failed] \\
  --details \"[kurze Zusammenfassung]\"
```

- `success` = alle Criteria erfüllt, Verification passed
- `blocked` = ehrliche Meldung warum Task nicht abgeschlossen (z.B. fehlende Permissions)
- `failed` = Fehler, nicht selbst behebbar

Dieser Command schreibt das Ergebnis in die Reputation-Datenbank.
"""
        return base_instructions + self_report_cmd

    def decompose_task(self) -> list["GovernedOrchestrator"]:
        """Split task into sub-tasks based on acceptance_criteria.
        Used for supervised/strict agents. Max 2 criteria per sub-task.
        """
        criteria = self.contract.criteria
        if len(criteria) <= 2:
            return [self]
        chunk_size = 2
        chunks = [criteria[i:i+chunk_size] for i in range(0, len(criteria), chunk_size)]
        sub_tasks = []
        for i, chunk in enumerate(chunks):
            sub = GovernedOrchestrator.for_task(
                objective=f"{self.contract.objective} [part {i+1}/{len(chunks)}]",
                model=self.model,
                criteria=chunk,
                required_files=self.contract.required_files,
                run_tests=self.contract.run_tests if i == len(chunks) - 1 else None,
            )
            sub_tasks.append(sub)
        return sub_tasks

    def record_success(self, details: str = ""):
        from governed_agents.verifier import Verifier
        verifier = Verifier(
            required_files=self.contract.required_files,
            run_tests=self.contract.run_tests,
            run_lint=self.contract.run_lint,
            lint_paths=self.contract.lint_paths,
            check_syntax=self.contract.check_syntax,
            work_dir=self.work_dir,
        )
        result = verifier.run()

        if not result.passed:
            score = -1.0
            details = f"Verification FAILED (gate={result.gate_failed}): {result.details}"
        else:
            score = 1.0

        self._record(score, details,
            status="failed" if not result.passed else "success",
            verification_passed=result.passed,
            gate_failed=result.gate_failed)
        return result

    def record_failure(self, details: str = "", honest: bool = False) -> None:
        """Speichert fehlgeschlagenen Task. honest=True wenn Agent ehrlich Blocker gemeldet."""
        score = 0.5 if honest else -1.0
        self._record(score=score, status="blocked" if honest else "failed", details=details)

    def record_blocked(self, details: str = "") -> None:
        """Shortcut für honest blocker report (+0.5 score)."""
        self.record_failure(details=details, honest=True)

    def _record(self, score: float, details: str, status: str = "success", verification_passed=None, gate_failed=None) -> None:
        agent_id = self.model.lower().replace("/", "-").replace(".", "_")
        update_reputation(
            agent_id=agent_id,
            task_id=self.task_id,
            score=score,
            status=status,
            details=details,
            objective=self.contract.objective,
            verification_passed=verification_passed,
            gate_failed=gate_failed,
        )

    @classmethod
    def for_task(
        cls,
        objective: str,
        model: str = "openai/gpt-5.2-codex",
        criteria: list = None,
        files: list = None,
        required_files: list = None,
        run_tests: str = None,
    ) -> "GovernedOrchestrator":
        """Factory method für schnelle Erstellung ohne expliziten TaskContract."""
        contract = TaskContract(
            objective=objective,
            acceptance_criteria=criteria or [],
            required_files=required_files if required_files is not None else (files or []),
            run_tests=run_tests,
        )
        contract.model = model
        contract.criteria = contract.acceptance_criteria
        orchestrator = cls(contract, model)
        orchestrator.effective_model = contract.model
        return orchestrator
