"""OpenClaw Prompt Engine — the main orchestrator.

This is the single entry point for all prompt-first interactions.
Adapters (Telegram, UI, Notion) construct a :class:`UserPrompt` and
call :meth:`OpenClawPromptEngine.handle`.  The engine:

  1. Interprets intent (rule-first, LLM fallback)
  2. Gathers the right business/system context
  3. Routes to the correct workflow
  4. Builds a safe action plan
  5. Safety-reviews and requests approval if needed
  6. Executes (or queues for approval)
  7. Summarises the result in plain English
  8. Records conversation history for multi-turn context

The interface never feels command-line driven — every response reads
like a helpful operator.
"""

from __future__ import annotations

from packages.common.ids import new_id
from packages.common.logging import get_logger

from .context import ContextBuilder
from .executors import PlanExecutor, register_default_executors
from .interpreter import PromptInterpreter
from .memory import ConversationStore, NoteStore
from .planner import PromptPlanner
from .registry import ExecutorRegistry
from .responders import ResponseBuilder
from .router import PromptRouter
from .safety import SafetyGate
from .summarizer import Summarizer
from .types import EngineResponse, UserPrompt

logger = get_logger(__name__)


class OpenClawPromptEngine:
    """Prompt-first orchestration layer.

    All parameters are optional — the engine boots with sensible defaults
    (stub data sources, in-memory stores) so you can start talking to it
    immediately and wire real backends later.
    """

    def __init__(
        self,
        interpreter: PromptInterpreter | None = None,
        context_builder: ContextBuilder | None = None,
        router: PromptRouter | None = None,
        planner: PromptPlanner | None = None,
        safety_gate: SafetyGate | None = None,
        executor: PlanExecutor | None = None,
        responder: ResponseBuilder | None = None,
        summarizer: Summarizer | None = None,
        conversation_store: ConversationStore | None = None,
        note_store: NoteStore | None = None,
        registry: ExecutorRegistry | None = None,
    ):
        self.interpreter = interpreter or PromptInterpreter()
        self.context_builder = context_builder or ContextBuilder()
        self.router = router or PromptRouter()
        self.planner = planner or PromptPlanner()

        # Registry + executor wiring
        self._registry = registry or ExecutorRegistry()
        if not self._registry.registered_names:
            register_default_executors(self._registry)

        self.safety_gate = safety_gate or SafetyGate()
        self._executor = executor or PlanExecutor(self._registry, self.safety_gate)
        self.responder = responder or ResponseBuilder()
        self.summarizer = summarizer or Summarizer()

        # Memory
        self._conversations = conversation_store or ConversationStore()
        self._notes = note_store or NoteStore()

    def handle(self, prompt: UserPrompt) -> EngineResponse:
        """Process a natural-language prompt through the full pipeline."""
        conversation_id = prompt.conversation_id or new_id("conv")

        # Record user turn
        self._conversations.add_turn(conversation_id, "user", prompt.text)

        try:
            response = self._handle_inner(prompt, conversation_id)
        except Exception as exc:
            logger.error(
                "engine_error",
                extra={"extra": {"error": str(exc), "conversation_id": conversation_id}},
            )
            response = self.responder.build_error(
                str(exc), conversation_id=conversation_id,
            )

        # Record assistant turn
        self._conversations.add_turn(conversation_id, "assistant", response.reply)

        # Remember last brand for this user
        if response.intent and response.intent.brand:
            self._notes.set(
                f"user:{prompt.user_id}", "last_brand", response.intent.brand,
            )

        return response

    def _handle_inner(self, prompt: UserPrompt, conversation_id: str) -> EngineResponse:
        # ── 1. Infer brand from memory if not provided ──────────────────
        if not prompt.brand_hint:
            remembered = self._notes.get(f"user:{prompt.user_id}", "last_brand")
            if remembered:
                prompt.brand_hint = remembered

        # ── 2. Interpret intent ─────────────────────────────────────────
        intent = self.interpreter.parse(prompt)

        if intent.clarification_needed:
            return self.responder.build_clarification(intent, conversation_id)

        # ── 3. Gather context ───────────────────────────────────────────
        context = self.context_builder.build(intent)

        # ── 4. Route to workflow ────────────────────────────────────────
        route = self.router.route(intent)

        # ── 5. Build action plan ────────────────────────────────────────
        plan = self.planner.build_plan(intent, context, route.workflow)
        plan.target_agent = route.agent

        # ── 6. Safety review ───────────────────────────────────────────
        plan = self.safety_gate.review(plan)

        # ── 7. Execute ─────────────────────────────────────────────────
        result = self._executor.run(plan)

        # ── 8. Build response ──────────────────────────────────────────
        return self.responder.build(intent, context, plan, result, conversation_id)

    # ── Public helpers ──────────────────────────────────────────────────

    @property
    def registry(self) -> ExecutorRegistry:
        return self._registry

    def get_conversation_history(self, conversation_id: str, last_n: int | None = None):
        return self._conversations.get_history(conversation_id, last_n)

    def invalidate_context_cache(self) -> None:
        self.context_builder.invalidate_cache()
