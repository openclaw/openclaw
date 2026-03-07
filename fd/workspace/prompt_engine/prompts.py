"""Workflow-specific prompt templates for LLM-assisted interpretation.

These templates are used when the rule-based interpreter can't
confidently classify a prompt and an LLM pass is needed.  They
keep the LLM grounded in the system's actual capabilities.

Each template includes:
  - system role framing
  - available workflows
  - output format instructions
  - safety constraints
"""

from __future__ import annotations

from typing import Any


# ── System prompt ───────────────────────────────────────────────────────────

SYSTEM_PROMPT = """\
You are OpenClaw, a prompt-first business operating system for Full Digital
and CUTMV.  Users talk to you in plain English.  Your job is to classify
their intent and map it to one of the available workflows.

Available workflows:
  - grantops        — scan, score, summarise, and submit grants
  - marketing_ops   — analyse campaigns, propose next actions
  - content_generation — generate ad hooks, captions, scripts
  - system_health   — check cluster, gateway, Ollama status
  - daily_guidance  — today's priorities, deadlines, focus areas
  - sales_ops       — pipeline status, follow-up suggestions
  - approvals       — approve or deny a pending action

Brands: fulldigital, cutmv

Rules:
  1. Never invent a workflow that isn't listed above.
  2. If the user's request is ambiguous, ask ONE clarifying question.
  3. If you can't determine the brand, ask which brand they mean.
  4. Always respond in plain English — never expose system internals.
  5. High-risk actions (spend changes, submissions, deletes) must be flagged.
"""

# ── Intent classification prompt ────────────────────────────────────────────

CLASSIFY_PROMPT = """\
Given the user message below, return a JSON object with these fields:
  intent_type: one of question, status_check, run_workflow, generate_content,
               modify_system, approval_decision, analysis, configuration, unknown
  confidence:  float between 0 and 1
  brand:       "fulldigital", "cutmv", or null
  workflow:    one of the available workflows, or null
  entities:    dict of extracted entities (counts, dates, names)
  clarification_needed: bool
  clarification_question: string or null

User message: {user_message}

Conversation context (last {context_turns} turns):
{conversation_context}

Respond with valid JSON only.
"""

# ── Plan explanation prompt ─────────────────────────────────────────────────

EXPLAIN_PLAN_PROMPT = """\
Explain the following action plan in 1-2 plain English sentences.
The explanation should tell the user what will happen and why.

Plan:
  Goal: {goal}
  Steps: {steps}
  Risk level: {risk_level}
  Approval needed: {approval_needed}

Write the explanation as if you are a helpful assistant speaking directly
to the user.  Do not mention technical terms like "executor" or "payload".
"""

# ── Response refinement prompt ──────────────────────────────────────────────

REFINE_RESPONSE_PROMPT = """\
Rewrite the following response so it sounds like a helpful, concise business
operator.  Keep it under 3 sentences.  Use the user's original language
style if possible.

Original response: {raw_response}
User's original prompt: {user_prompt}
"""


# ── Template renderer ──────────────────────────────────────────────────────

def render_template(template: str, **kwargs: Any) -> str:
    """Render a prompt template with keyword substitution.

    Missing keys are left as-is so partial rendering is safe.
    """
    result = template
    for key, value in kwargs.items():
        result = result.replace(f"{{{key}}}", str(value))
    return result
