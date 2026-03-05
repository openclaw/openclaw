"""
Brigade: OpenClaw
Role: Pipeline Executor (Chain-of-Agents)

Implements the workflow chains described in SOUL.md:
- Dmarket Brigade: Executor → Security Auditor → Latency Monitor → Risk Manager
- OpenClaw Brigade: Planner → Tool Smith → Memory GC

Each step in the chain receives:
1. The original user prompt
2. A compressed context briefing from the previous step
3. Its own system prompt from openclaw_config.json

Uses task_queue.py for VRAM management to prevent model thrashing.
"""

import asyncio
import json
import logging
import re
from typing import Any, Dict, List, Optional

import aiohttp

logger = logging.getLogger("PipelineExecutor")


class PipelineExecutor:
    """
    Executes a chain of agent roles sequentially, passing compressed
    context between each step. Respects the 8GB VRAM constraint by
    loading one model at a time via the ModelTaskQueue.
    """

    def __init__(self, config: Dict[str, Any], ollama_url: str):
        self.config = config
        self.ollama_url = ollama_url

        # Default chain definitions per brigade (can be overridden in config)
        self.default_chains = {
            "Dmarket": ["Planner", "Executor", "Security_Auditor"],
            "OpenClaw": ["Planner"],
        }

    def get_chain(self, brigade: str) -> List[str]:
        """
        Returns the pipeline chain for a given brigade.
        Uses config override if available, otherwise defaults.
        """
        brigade_config = self.config.get("brigades", {}).get(brigade, {})

        # Check if the brigade defines a custom chain
        if "pipeline" in brigade_config:
            return brigade_config["pipeline"]

        # Otherwise use defaults — but only include roles that actually exist
        available_roles = set(brigade_config.get("roles", {}).keys())
        default_chain = self.default_chains.get(brigade, ["Planner"])
        return [role for role in default_chain if role in available_roles]

    async def execute(
        self,
        prompt: str,
        brigade: str,
        max_steps: int = 5,
        status_callback=None,
    ) -> Dict[str, Any]:
        """
        Execute the full pipeline for a brigade.

        Args:
            prompt: Original user prompt
            brigade: Target brigade name ("Dmarket" or "OpenClaw")
            max_steps: Safety limit on chain length
            status_callback: async callable(role, model, status_text) for live updates

        Returns:
            {
                "final_response": str,
                "brigade": str,
                "chain_executed": [str],
                "steps": [{"role": ..., "model": ..., "response": ...}]
            }
        """
        chain = self.get_chain(brigade)[:max_steps]

        if not chain:
            return {
                "final_response": "⚠️ No roles available in the pipeline.",
                "brigade": brigade,
                "chain_executed": [],
                "steps": [],
            }

        logger.info(f"Pipeline START: brigade={brigade}, chain={' → '.join(chain)}")

        steps_results = []
        context_briefing = ""

        for i, role_name in enumerate(chain):
            role_config = (
                self.config.get("brigades", {}).get(brigade, {}).get("roles", {}).get(role_name, {})
            )

            if not role_config:
                logger.warning(f"Role '{role_name}' not found in config, skipping")
                continue

            model = role_config.get("model", "llama3.2")
            system_prompt = role_config.get("system_prompt", "You are an AI assistant.")

            # Build context-aware prompt for this step
            if i == 0:
                # First step: gets the raw user prompt
                step_prompt = prompt
            else:
                # Subsequent steps: gets briefing from previous step + original task
                step_prompt = (
                    f"[PIPELINE CONTEXT from previous step]\n"
                    f"{context_briefing}\n\n"
                    f"[ORIGINAL USER TASK]\n"
                    f"{prompt}\n\n"
                    f"Based on the above context and the previous step's analysis, "
                    f"perform your role as {role_name}."
                )

            # Notify status
            if status_callback:
                await status_callback(
                    role_name,
                    model,
                    f"Шаг {i + 1}/{len(chain)}: {role_name} анализирует...",
                )

            logger.info(f"Pipeline step {i + 1}/{len(chain)}: {role_name} ({model})")

            # Execute inference
            response = await self._call_ollama(model, system_prompt, step_prompt)

            steps_results.append(
                {
                    "role": role_name,
                    "model": model,
                    "response": response,
                }
            )

            # Prepare context briefing for the next step (compressed)
            context_briefing = self._compress_for_next_step(role_name, response)

        final_response = steps_results[-1]["response"] if steps_results else ""

        logger.info(f"Pipeline COMPLETE: brigade={brigade}, steps={len(steps_results)}")

        return {
            "final_response": final_response,
            "brigade": brigade,
            "chain_executed": [s["role"] for s in steps_results],
            "steps": steps_results,
        }

    async def _call_ollama(self, model: str, system_prompt: str, user_prompt: str) -> str:
        """
        Calls Ollama API for a single inference step.
        Uses keep_alive=0 to immediately free VRAM for the next step.
        """
        system_prompt += (
            " Отвечай предельно четко, понятно, по делу. Не используй сложное форматирование."
        )

        # Auto-scaling context window based on input length
        # 4 chars roughly equals 1 token. Add 512 tokens buffer. Max 8192 for RX 6600.
        estimated_content_tokens = len(user_prompt + system_prompt) // 4
        dynamic_ctx = min(8192, max(2048, estimated_content_tokens + 512))

        payload = {
            "model": model,
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt},
            ],
            "stream": False,
            "keep_alive": 0,  # Flush VRAM immediately for pipeline chain
            "options": {"num_ctx": dynamic_ctx},
        }

        async def _run_inference():
            async with aiohttp.ClientSession() as session:
                try:
                    timeout = aiohttp.ClientTimeout(total=90)
                    async with session.post(
                        f"{self.ollama_url}/api/chat",
                        json=payload,
                        timeout=timeout,
                    ) as resp:
                        if resp.status == 200:
                            data = await resp.json()
                            text = data["message"]["content"].strip()
                            # Strip <think>...</think> blocks (DeepSeek-R1)
                            text = re.sub(r"<think>.*?</think>", "", text, flags=re.DOTALL).strip()
                            return text
                        else:
                            return f"⚠️ API Error ({resp.status})"
                except asyncio.TimeoutError:
                    return "❌ Timeout: модель не ответила за 90 секунд"
                except Exception as e:
                    return f"❌ Error: {e}"

        from task_queue import model_queue

        return await model_queue.enqueue(model, _run_inference)

    def _compress_for_next_step(self, role_name: str, response: str) -> str:
        """
        Creates a lightweight context briefing for the next pipeline step.
        This is a simple rule-based compression (no LLM call needed).
        For cost: truncate to ~500 chars to keep context lean.
        """
        # Take the first 500 chars of the response as briefing
        truncated = response[:500]
        if len(response) > 500:
            truncated += "..."

        return f"[{role_name} Output]: {truncated}"
