"""OpenClaw Prompt Engine — plain English in, safe structured action out.

The engine sits between human language, business systems, and the automation
layer.  Users talk to OpenClaw like ChatGPT; the engine interprets, plans,
safety-checks, executes, and summarises.

Public API:
    OpenClawPromptEngine  — main orchestrator
    UserPrompt            — inbound prompt envelope
"""

from openclaw.prompt_engine.engine import OpenClawPromptEngine  # noqa: F401
from openclaw.prompt_engine.types import UserPrompt  # noqa: F401
