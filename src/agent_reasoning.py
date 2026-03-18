"""
Brigade: OpenClaw
Role: Agent Reasoning Architectures

Implements improvements from multiple research papers for structured
reasoning, self-reflection, multi-agent collaboration, safety guardrails,
and tool-use learning.

Research sources:
- ReAct: Synergizing Reasoning and Acting in Language Models (arXiv:2210.03629)
- Reflexion: Language Agents with Verbal Reinforcement Learning (arXiv:2303.11366)
- Mixture-of-Agents Enhances Large Language Model Capabilities (arXiv:2406.04692)
- Constitutional AI: Harmlessness from AI Feedback (arXiv:2212.08073)
- Toolformer: Language Models Can Teach Themselves to Use Tools (arXiv:2302.04761)
- Gorilla: Large Language Model Connected with Massive APIs (arXiv:2305.15334)

Design principles:
- Zero extra VRAM: all orchestration is CPU-side; LLM calls go through vLLM
- Sequential model loading: one inference at a time (16 GB VRAM constraint)
- aiohttp for async HTTP, structlog for structured logging
- Dataclass results for clean pipeline integration with PipelineExecutor
"""

import asyncio
import time
from collections import defaultdict
from dataclasses import asdict, dataclass, field
from typing import Any, Dict, List, Optional, Tuple

import aiohttp
import structlog

logger = structlog.get_logger(__name__)

# ---------------------------------------------------------------------------
# Default vLLM config
# ---------------------------------------------------------------------------
_DEFAULT_VLLM_URL = "http://localhost:8000/v1"
_DEFAULT_TIMEOUT_SEC = 450


# ===================================================================
# Dataclasses
# ===================================================================


@dataclass
class ReActStep:
    """A single Thought → Action → Observation cycle.

    Reference: ReAct (arXiv:2210.03629), Section 3.
    """

    step: int
    thought: str
    action: str
    action_input: str
    observation: str
    timestamp: float = field(default_factory=time.time)


@dataclass
class ReActResult:
    """Final result from a ReAct reasoning loop."""

    answer: str
    steps: List[ReActStep]
    total_steps: int
    finished: bool
    elapsed_sec: float


@dataclass
class EvaluationResult:
    """Self-evaluation output used by Reflexion.

    Reference: Reflexion (arXiv:2303.11366), Section 3.1.
    """

    success: bool
    score: float  # [0.0, 1.0]
    reasoning: str
    issues: List[str] = field(default_factory=list)


@dataclass
class ReflexionResult:
    """Aggregate result after reflection loop."""

    final_response: str
    attempts: int
    reflections: List[str]
    evaluations: List[EvaluationResult]
    success: bool
    elapsed_sec: float


@dataclass
class MoAResult:
    """Result from Mixture-of-Agents generation.

    Reference: arXiv:2406.04692.
    """

    aggregated_response: str
    proposals: List[str]
    num_proposers: int
    elapsed_sec: float


@dataclass
class ConstitutionalResult:
    """Result of constitutional safety check."""

    safe: bool
    violations: List[str]
    revised_response: Optional[str]
    principle_scores: Dict[str, float] = field(default_factory=dict)


@dataclass
class ToolStats:
    """Accumulated statistics for a single tool.

    Reference: Toolformer (arXiv:2302.04761), Gorilla (arXiv:2305.15334).
    """

    tool_name: str
    total_calls: int = 0
    successes: int = 0
    failures: int = 0
    total_latency_ms: int = 0
    recent_errors: List[str] = field(default_factory=list)

    @property
    def success_rate(self) -> float:
        return self.successes / self.total_calls if self.total_calls > 0 else 0.0

    @property
    def avg_latency_ms(self) -> float:
        return self.total_latency_ms / self.total_calls if self.total_calls > 0 else 0.0

    def to_dict(self) -> Dict[str, Any]:
        return {
            **asdict(self),
            "success_rate": self.success_rate,
            "avg_latency_ms": self.avg_latency_ms,
        }


# ===================================================================
# Shared helper: call vLLM (OpenAI-compatible)
# ===================================================================


async def _call_vllm(
    url: str,
    model: str,
    messages: List[Dict[str, str]],
    *,
    temperature: float = 0.3,
    max_tokens: int = 2048,
    timeout_sec: int = _DEFAULT_TIMEOUT_SEC,
) -> str:
    """POST to vLLM /chat/completions and return assistant content.

    Raises ``aiohttp.ClientError`` or ``RuntimeError`` on failure.
    """
    payload: Dict[str, Any] = {
        "model": model,
        "messages": messages,
        "stream": False,
        "temperature": temperature,
        "max_tokens": max_tokens,
    }
    timeout = aiohttp.ClientTimeout(total=timeout_sec)
    async with aiohttp.ClientSession() as session:
        async with session.post(
            f"{url}/chat/completions", json=payload, timeout=timeout
        ) as resp:
            if resp.status != 200:
                body = await resp.text()
                raise RuntimeError(
                    f"vLLM returned {resp.status}: {body[:500]}"
                )
            data = await resp.json()
            choices = data.get("choices", [])
            if not choices:
                raise RuntimeError("vLLM returned empty choices")
            return choices[0]["message"]["content"]


# ===================================================================
# 1. ReActReasoner
# ===================================================================


class ReActReasoner:
    """Structured reasoning following the ReAct pattern.

    Instead of a single direct LLM call, forces an iterative
    Thought → Action → Observation cycle so the model can plan,
    act, and incorporate feedback before answering.

    Reference: Yao et al., "ReAct: Synergizing Reasoning and Acting
    in Language Models", arXiv:2210.03629.
    """

    # Sentinel the model emits when it has a final answer
    _FINISH_ACTION = "Finish"

    def __init__(self, vllm_url: str = _DEFAULT_VLLM_URL, model: str = ""):
        self.vllm_url = vllm_url.rstrip("/")
        self.model = model

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    async def reason(
        self,
        prompt: str,
        tools: Optional[List[Dict[str, Any]]] = None,
        max_steps: int = 5,
    ) -> ReActResult:
        """Execute the ReAct reasoning loop.

        Args:
            prompt: User question or task description.
            tools: Available tools (name + description dicts).
            max_steps: Safety cap on reasoning iterations.

        Returns:
            ``ReActResult`` with final answer and full trace.
        """
        tools = tools or []
        history: List[ReActStep] = []
        start = time.monotonic()

        for step_idx in range(1, max_steps + 1):
            react_prompt = self.format_react_prompt(prompt, history, tools)
            raw = await _call_vllm(
                self.vllm_url,
                self.model,
                [
                    {"role": "system", "content": self._system_prompt(tools)},
                    {"role": "user", "content": react_prompt},
                ],
                temperature=0.2,
            )

            thought, action, action_input = self._parse_react_output(raw)

            if action == self._FINISH_ACTION:
                history.append(
                    ReActStep(
                        step=step_idx,
                        thought=thought,
                        action=action,
                        action_input=action_input,
                        observation="[Done]",
                    )
                )
                return ReActResult(
                    answer=action_input,
                    steps=history,
                    total_steps=step_idx,
                    finished=True,
                    elapsed_sec=time.monotonic() - start,
                )

            # Simulate observation (tool execution is the caller's responsibility)
            observation = f"[Tool '{action}' called with input: {action_input}]"
            history.append(
                ReActStep(
                    step=step_idx,
                    thought=thought,
                    action=action,
                    action_input=action_input,
                    observation=observation,
                )
            )
            logger.info(
                "react_step",
                step=step_idx,
                action=action,
                thought=thought[:120],
            )

        # Exhausted steps — return best-effort answer
        elapsed = time.monotonic() - start
        logger.warning("react_max_steps_reached", max_steps=max_steps)
        return ReActResult(
            answer=history[-1].thought if history else "",
            steps=history,
            total_steps=max_steps,
            finished=False,
            elapsed_sec=elapsed,
        )

    # ------------------------------------------------------------------
    # Prompt formatting
    # ------------------------------------------------------------------

    def format_react_prompt(
        self,
        question: str,
        history: List[ReActStep],
        tools: Optional[List[Dict[str, Any]]] = None,
    ) -> str:
        """Build prompt containing the question and Thought/Action/Observation history."""
        parts = [f"Question: {question}"]
        for s in history:
            parts.append(f"Thought: {s.thought}")
            parts.append(f"Action: {s.action}")
            parts.append(f"Action Input: {s.action_input}")
            parts.append(f"Observation: {s.observation}")
        # Ask for the next step
        parts.append("Thought:")
        return "\n".join(parts)

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    @staticmethod
    def _system_prompt(tools: List[Dict[str, Any]]) -> str:
        tool_desc = "\n".join(
            f"- {t.get('name', '?')}: {t.get('description', '')}"
            for t in tools
        )
        return (
            "You are a reasoning agent. Follow the ReAct format strictly.\n"
            "On each turn output exactly:\n"
            "Thought: <your reasoning>\n"
            "Action: <tool name or Finish>\n"
            "Action Input: <input for the tool, or final answer if Action is Finish>\n\n"
            f"Available tools:\n{tool_desc}\n"
            "Use 'Finish' as the Action when you have the final answer."
        )

    @staticmethod
    def _parse_react_output(raw: str) -> Tuple[str, str, str]:
        """Extract Thought / Action / Action Input from model output."""
        thought = ""
        action = ""
        action_input = ""
        for line in raw.splitlines():
            stripped = line.strip()
            if stripped.lower().startswith("thought:"):
                thought = stripped.split(":", 1)[1].strip()
            elif stripped.lower().startswith("action:"):
                action = stripped.split(":", 1)[1].strip()
            elif stripped.lower().startswith("action input:"):
                action_input = stripped.split(":", 1)[1].strip()
        # Normalise finish variants
        if action.lower() in ("finish", "final answer", "done"):
            action = ReActReasoner._FINISH_ACTION
        return thought, action, action_input


# ===================================================================
# 2. ReflexionAgent
# ===================================================================


class ReflexionAgent:
    """Self-reflecting agent that learns from verbal feedback.

    After each attempt the agent:
    1. Evaluates — was the result correct/good?
    2. Reflects — what went wrong and what could be improved?
    3. Stores the reflection in short-term memory
    4. Retries with reflection context appended

    Reference: Shinn et al., "Reflexion: Language Agents with Verbal
    Reinforcement Learning", arXiv:2303.11366.
    """

    # Threshold above which a response is considered acceptable
    _SUCCESS_THRESHOLD = 0.7

    def __init__(self, vllm_url: str = _DEFAULT_VLLM_URL, model: str = ""):
        self.vllm_url = vllm_url.rstrip("/")
        self.model = model

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    async def solve_with_reflection(
        self, task: str, max_attempts: int = 3
    ) -> ReflexionResult:
        """Solve *task* with a self-reflection loop.

        The agent generates a response, evaluates it, and if the evaluation
        score is below ``_SUCCESS_THRESHOLD`` it reflects on the failure and
        retries with the accumulated reflections.

        Args:
            task: The user task / question.
            max_attempts: Maximum number of generate-evaluate-reflect cycles.

        Returns:
            ``ReflexionResult`` with final response, reflections, and evaluations.
        """
        reflections: List[str] = []
        evaluations: List[EvaluationResult] = []
        start = time.monotonic()
        last_response = ""

        for attempt in range(1, max_attempts + 1):
            # Generate --------------------------------------------------------
            gen_prompt = self._build_generation_prompt(task, reflections)
            last_response = await _call_vllm(
                self.vllm_url,
                self.model,
                [
                    {"role": "system", "content": "You are a helpful assistant. Answer concisely and accurately."},
                    {"role": "user", "content": gen_prompt},
                ],
                temperature=0.3,
            )
            logger.info("reflexion_attempt", attempt=attempt, response_len=len(last_response))

            # Evaluate --------------------------------------------------------
            evaluation = await self._evaluate(task, last_response)
            evaluations.append(evaluation)

            if evaluation.success:
                return ReflexionResult(
                    final_response=last_response,
                    attempts=attempt,
                    reflections=reflections,
                    evaluations=evaluations,
                    success=True,
                    elapsed_sec=time.monotonic() - start,
                )

            # Reflect ---------------------------------------------------------
            if attempt < max_attempts:
                reflection = await self._reflect(task, last_response, evaluation)
                reflections.append(reflection)
                logger.info("reflexion_reflection", attempt=attempt, reflection=reflection[:200])

        return ReflexionResult(
            final_response=last_response,
            attempts=max_attempts,
            reflections=reflections,
            evaluations=evaluations,
            success=False,
            elapsed_sec=time.monotonic() - start,
        )

    # ------------------------------------------------------------------
    # Evaluate
    # ------------------------------------------------------------------

    async def _evaluate(self, task: str, response: str) -> EvaluationResult:
        """Self-evaluate a response for correctness and quality.

        The model is asked to rate the response on a 0–1 scale and list
        specific issues found.
        """
        eval_prompt = (
            "Evaluate the following response to a task.\n\n"
            f"Task: {task}\n\n"
            f"Response: {response}\n\n"
            "Rate the response quality from 0.0 (terrible) to 1.0 (perfect).\n"
            "List any issues found.\n"
            "Format your answer as:\n"
            "Score: <float>\n"
            "Issues: <comma-separated list or 'none'>\n"
            "Reasoning: <brief explanation>"
        )
        raw = await _call_vllm(
            self.vllm_url,
            self.model,
            [
                {"role": "system", "content": "You are a strict evaluator. Be honest and concise."},
                {"role": "user", "content": eval_prompt},
            ],
            temperature=0.1,
            max_tokens=512,
        )

        score = self._parse_score(raw)
        issues = self._parse_issues(raw)
        return EvaluationResult(
            success=score >= self._SUCCESS_THRESHOLD,
            score=score,
            reasoning=raw.strip(),
            issues=issues,
        )

    # ------------------------------------------------------------------
    # Reflect
    # ------------------------------------------------------------------

    async def _reflect(
        self, task: str, response: str, evaluation: EvaluationResult
    ) -> str:
        """Generate a verbal reflection on why the attempt failed.

        The reflection is stored and prepended to subsequent attempts so the
        agent can learn within the episode (arXiv:2303.11366, Section 3.2).
        """
        issues_str = "; ".join(evaluation.issues) if evaluation.issues else "unspecified"
        reflect_prompt = (
            "You attempted the following task and failed.\n\n"
            f"Task: {task}\n\n"
            f"Your response: {response}\n\n"
            f"Issues identified: {issues_str}\n"
            f"Score: {evaluation.score:.2f}\n\n"
            "Write a short reflection (2-3 sentences) on what went wrong "
            "and what you should do differently next time."
        )
        return await _call_vllm(
            self.vllm_url,
            self.model,
            [
                {"role": "system", "content": "You are a self-reflective agent. Be specific and actionable."},
                {"role": "user", "content": reflect_prompt},
            ],
            temperature=0.3,
            max_tokens=256,
        )

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    @staticmethod
    def _build_generation_prompt(task: str, reflections: List[str]) -> str:
        parts = [f"Task: {task}"]
        if reflections:
            parts.append("\n--- Previous reflections (learn from these) ---")
            for i, r in enumerate(reflections, 1):
                parts.append(f"Reflection {i}: {r}")
            parts.append("--- End reflections ---\n")
            parts.append("Using the reflections above, provide an improved answer.")
        return "\n".join(parts)

    @staticmethod
    def _parse_score(raw: str) -> float:
        for line in raw.splitlines():
            stripped = line.strip().lower()
            if stripped.startswith("score:"):
                try:
                    return max(0.0, min(1.0, float(stripped.split(":", 1)[1].strip())))
                except ValueError:
                    pass
        return 0.5  # default if parsing fails

    @staticmethod
    def _parse_issues(raw: str) -> List[str]:
        for line in raw.splitlines():
            stripped = line.strip()
            if stripped.lower().startswith("issues:"):
                body = stripped.split(":", 1)[1].strip()
                if body.lower() == "none":
                    return []
                return [i.strip() for i in body.split(",") if i.strip()]
        return []


# ===================================================================
# 3. MixtureOfAgents (EXPERIMENTAL — high VRAM / latency cost)
# ===================================================================


class MixtureOfAgents:
    """Combines multiple agent perspectives for higher-quality output.

    Layer 1 — *Proposers*: generate diverse candidate responses using
    varied system prompts (temperature, persona, style).
    Layer 2 — *Aggregator*: synthesises the best parts into a single
    coherent answer.

    Works on a single GPU by sequential generation with different prompts
    (no parallel model loading required).

    **WARNING**: On a 16 GB GPU this triples inference time (3 sequential
    generations + 1 aggregation per request).  Use only for high-stakes
    tasks where quality is more important than latency.  Consider using
    ``ConstitutionalChecker`` or ``ReflexionAgent`` instead for most cases.

    Reference: Wang et al., "Mixture-of-Agents Enhances Large Language
    Model Capabilities", arXiv:2406.04692.
    """

    _DEFAULT_PROPOSER_PROMPTS = [
        "You are an analytical expert. Provide a precise, fact-based answer.",
        "You are a creative problem-solver. Think outside the box and offer novel insights.",
        "You are a critical reviewer. Consider edge cases, risks, and limitations.",
    ]

    def __init__(
        self,
        vllm_url: str = _DEFAULT_VLLM_URL,
        model: str = "",
        num_proposers: int = 3,
    ):
        self.vllm_url = vllm_url.rstrip("/")
        self.model = model
        self.num_proposers = num_proposers

    async def generate(
        self,
        prompt: str,
        system_prompts: Optional[List[str]] = None,
    ) -> MoAResult:
        """Generate a response using the Mixture-of-Agents pattern.

        Args:
            prompt: User query.
            system_prompts: Optional per-proposer system prompts.
                Defaults to ``_DEFAULT_PROPOSER_PROMPTS`` (trimmed/cycled
                to match ``num_proposers``).

        Returns:
            ``MoAResult`` with aggregated answer and individual proposals.
        """
        prompts = self._resolve_system_prompts(system_prompts)
        start = time.monotonic()

        # Layer 1 — Proposers (sequential to stay within 16 GB VRAM)
        proposals: List[str] = []
        for idx, sys_prompt in enumerate(prompts):
            logger.info("moa_proposer", proposer=idx + 1, total=len(prompts))
            proposal = await _call_vllm(
                self.vllm_url,
                self.model,
                [
                    {"role": "system", "content": sys_prompt},
                    {"role": "user", "content": prompt},
                ],
                temperature=0.5 + idx * 0.1,  # slightly varied temperature
            )
            proposals.append(proposal)

        # Layer 2 — Aggregator
        aggregated = await self._aggregate(prompt, proposals)
        return MoAResult(
            aggregated_response=aggregated,
            proposals=proposals,
            num_proposers=len(prompts),
            elapsed_sec=time.monotonic() - start,
        )

    # ------------------------------------------------------------------
    # Internal
    # ------------------------------------------------------------------

    def _resolve_system_prompts(
        self, custom: Optional[List[str]]
    ) -> List[str]:
        if custom and len(custom) >= self.num_proposers:
            return custom[: self.num_proposers]
        base = custom or self._DEFAULT_PROPOSER_PROMPTS
        # Cycle if fewer prompts than proposers
        return [base[i % len(base)] for i in range(self.num_proposers)]

    async def _aggregate(self, original_prompt: str, proposals: List[str]) -> str:
        numbered = "\n\n".join(
            f"--- Proposal {i + 1} ---\n{p}" for i, p in enumerate(proposals)
        )
        agg_prompt = (
            "You are an expert aggregator. Below are several candidate responses "
            "to the same question. Synthesise the best parts of each into a single, "
            "coherent, accurate answer. Preserve important details; remove redundancy.\n\n"
            f"Original question: {original_prompt}\n\n"
            f"{numbered}\n\n"
            "Synthesised answer:"
        )
        return await _call_vllm(
            self.vllm_url,
            self.model,
            [
                {"role": "system", "content": "You synthesise multiple expert responses into one best answer."},
                {"role": "user", "content": agg_prompt},
            ],
            temperature=0.2,
        )


# ===================================================================
# 4. ConstitutionalChecker
# ===================================================================


class ConstitutionalChecker:
    """Constitutional AI principles for output safety.

    Before a response is delivered to the user it is checked against a set
    of principles.  If violations are detected the response is revised.

    Principles (from Bai et al., arXiv:2212.08073 + TruthRL extensions):
    1. **Helpfulness** — does it address the user's need?
    2. **Harmlessness** — does it avoid harmful content?
    3. **Honesty** — does it acknowledge uncertainty?
    4. **Truthfulness** — are claims verifiable?
    """

    PRINCIPLES: List[str] = [
        "Helpfulness: The response directly addresses the user's request with useful information.",
        "Harmlessness: The response avoids harmful, dangerous, or unethical content.",
        "Honesty: The response acknowledges uncertainty and does not fabricate confident claims.",
        "Truthfulness: Factual claims in the response are verifiable and not misleading.",
    ]

    def __init__(self, vllm_url: str = _DEFAULT_VLLM_URL, model: str = ""):
        self.vllm_url = vllm_url.rstrip("/")
        self.model = model

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    async def check(self, prompt: str, response: str) -> ConstitutionalResult:
        """Check *response* against constitutional principles.

        Returns a ``ConstitutionalResult`` with violation list and optional
        revised response.
        """
        violations, scores = await self._evaluate_principles(prompt, response)
        revised: Optional[str] = None
        if violations:
            revised = await self.revise(prompt, response, violations)
        return ConstitutionalResult(
            safe=len(violations) == 0,
            violations=violations,
            revised_response=revised,
            principle_scores=scores,
        )

    async def revise(
        self, prompt: str, response: str, violations: List[str]
    ) -> str:
        """Revise *response* to fix the listed constitutional violations."""
        violation_text = "\n".join(f"- {v}" for v in violations)
        revise_prompt = (
            "The following response violates some constitutional principles.\n\n"
            f"User prompt: {prompt}\n\n"
            f"Original response: {response}\n\n"
            f"Violations:\n{violation_text}\n\n"
            "Rewrite the response so that it no longer violates any principle "
            "while remaining helpful and accurate."
        )
        return await _call_vllm(
            self.vllm_url,
            self.model,
            [
                {"role": "system", "content": "You rewrite responses to comply with constitutional AI principles."},
                {"role": "user", "content": revise_prompt},
            ],
            temperature=0.2,
        )

    # ------------------------------------------------------------------
    # Internal
    # ------------------------------------------------------------------

    async def _evaluate_principles(
        self, prompt: str, response: str
    ) -> Tuple[List[str], Dict[str, float]]:
        principles_block = "\n".join(
            f"{i + 1}. {p}" for i, p in enumerate(self.PRINCIPLES)
        )
        eval_prompt = (
            "Evaluate the response against these constitutional principles:\n"
            f"{principles_block}\n\n"
            f"User prompt: {prompt}\n\n"
            f"Response: {response}\n\n"
            "For each principle, output a line:\n"
            "<Principle name>: <score 0.0-1.0> | <PASS or VIOLATION: reason>\n"
        )
        raw = await _call_vllm(
            self.vllm_url,
            self.model,
            [
                {"role": "system", "content": "You are a constitutional AI auditor. Be strict and fair."},
                {"role": "user", "content": eval_prompt},
            ],
            temperature=0.1,
            max_tokens=512,
        )

        violations: List[str] = []
        scores: Dict[str, float] = {}
        for line in raw.splitlines():
            line = line.strip()
            if not line or ":" not in line:
                continue
            # Expected: "Helpfulness: 0.9 | PASS"
            parts = line.split("|")
            name_score = parts[0].strip()
            if ":" not in name_score:
                continue
            name, score_str = name_score.rsplit(":", 1)
            name = name.strip()
            try:
                score = max(0.0, min(1.0, float(score_str.strip())))
            except ValueError:
                continue
            scores[name] = score
            if len(parts) > 1 and "violation" in parts[1].lower():
                reason = parts[1].strip()
                violations.append(f"{name}: {reason}")
        return violations, scores


# ===================================================================
# 5. ToolLearningTracker
# ===================================================================


class ToolLearningTracker:
    """Tracks tool usage patterns and learns from failures.

    Inspired by:
    - Toolformer (arXiv:2302.04761): language models self-learning tool use
    - Gorilla (arXiv:2305.15334): connecting LLMs to massive APIs
    - ToolBrain: adaptive tool selection based on usage statistics

    Capabilities:
    - Track success/failure rates per tool
    - Auto-retry with alternative tools on failure
    - Build tool usage profiles for downstream training
    - Map task types to best-performing tools
    """

    # If a tool's success rate drops below this, suggest an alternative
    _RETRY_THRESHOLD = 0.5
    # Keep at most this many recent errors per tool
    _MAX_RECENT_ERRORS = 20

    def __init__(self) -> None:
        self._stats: Dict[str, ToolStats] = {}
        # task_type → {tool_name: success_count}
        self._task_tool_map: Dict[str, Dict[str, int]] = defaultdict(lambda: defaultdict(int))
        self._lock = asyncio.Lock()

    # ------------------------------------------------------------------
    # Recording
    # ------------------------------------------------------------------

    def record_tool_use(
        self,
        tool_name: str,
        success: bool,
        latency_ms: int,
        error: Optional[str] = None,
        task_type: Optional[str] = None,
    ) -> None:
        """Record a single tool invocation.

        Args:
            tool_name: Canonical tool name.
            success: Whether the call succeeded.
            latency_ms: Wall-clock latency in milliseconds.
            error: Error message on failure (truncated to 200 chars).
            task_type: Optional task category for best-tool selection.
        """
        stats = self._stats.setdefault(tool_name, ToolStats(tool_name=tool_name))
        stats.total_calls += 1
        stats.total_latency_ms += latency_ms
        if success:
            stats.successes += 1
        else:
            stats.failures += 1
            if error:
                stats.recent_errors.append(error[:200])
                if len(stats.recent_errors) > self._MAX_RECENT_ERRORS:
                    stats.recent_errors = stats.recent_errors[-self._MAX_RECENT_ERRORS:]

        if task_type and success:
            self._task_tool_map[task_type][tool_name] += 1

        logger.debug(
            "tool_use_recorded",
            tool=tool_name,
            success=success,
            latency_ms=latency_ms,
            cumulative_rate=f"{stats.success_rate:.2f}",
        )

    # ------------------------------------------------------------------
    # Queries
    # ------------------------------------------------------------------

    def get_best_tool_for_task(self, task_type: str) -> Optional[str]:
        """Return the tool with the highest success count for *task_type*.

        Returns ``None`` if no data exists for the task type.
        """
        mapping = self._task_tool_map.get(task_type)
        if not mapping:
            return None
        return max(mapping, key=mapping.get)  # type: ignore[arg-type]

    def should_retry_with_alternative(self, tool_name: str) -> bool:
        """Return ``True`` if *tool_name*'s success rate is below the retry threshold."""
        stats = self._stats.get(tool_name)
        if stats is None or stats.total_calls < 3:
            # Not enough data to judge
            return False
        return stats.success_rate < self._RETRY_THRESHOLD

    def get_tool_stats(self) -> Dict[str, ToolStats]:
        """Return a snapshot of per-tool statistics."""
        return dict(self._stats)

    def get_tool_report(self) -> List[Dict[str, Any]]:
        """Return a JSON-serialisable summary of all tracked tools."""
        return [s.to_dict() for s in sorted(self._stats.values(), key=lambda s: s.total_calls, reverse=True)]

    def suggest_alternative(self, failed_tool: str) -> Optional[str]:
        """Suggest the highest-success-rate tool that is not *failed_tool*.

        Returns ``None`` if no alternative is known.
        """
        candidates = [
            s
            for name, s in self._stats.items()
            if name != failed_tool and s.total_calls >= 3
        ]
        if not candidates:
            return None
        best = max(candidates, key=lambda s: s.success_rate)
        return best.tool_name if best.success_rate > self._RETRY_THRESHOLD else None
