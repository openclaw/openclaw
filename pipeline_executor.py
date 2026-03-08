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
Integrates .memory-bank architecture and the 90/10 STAR Framework for agent planning.
"""

import asyncio
import json
import logging
import os
import re
from typing import Any, Dict, List, Optional
import time
import aiohttp
import structlog
from contextlib import asynccontextmanager
from task_queue import ModelTaskQueue

# Injecting MCP Client
from mcp_client import OpenClawMCPClient

logger = structlog.get_logger(__name__)


# Models that require full VRAM (cannot coexist)
HEAVY_MODELS = {"deepseek-r1:14b", "qwen2.5-coder:14b", "gemma3:12b"}


class PipelineExecutor:
    """
    Executes a chain of agent roles sequentially, passing compressed
    context between each step. Respects the 16GB VRAM constraint by
    loading one model at a time via the ModelTaskQueue.
    Uses forced VRAM unload (keep_alive=0) when switching between
    heavy models (e.g. deepseek-r1:14b ~9GB + qwen2.5-coder:14b ~9GB = 18GB > 16GB).
    """

    def __init__(self, config: Dict[str, Any], ollama_url: str):
        self.config = config
        self.ollama_url = ollama_url
        self.gc_model = config.get("memory", {}).get("model", "gemma3:12b")

        # Default chain definitions per brigade (can be overridden in config)
        self.default_chains = {
            "Dmarket": ["Planner", "Executor", "Security_Auditor"],
            "OpenClaw": ["Planner"],
        }
        
        # Initialize Isolated MCP Clients
        # Using specific paths: OpenClaw root and Dmarket_bot root
        workspace_root = os.path.abspath(os.path.dirname(__file__))
        dmarket_root = "D:/Dmarket_bot"
        db_path = os.path.join(dmarket_root, "data", "dmarket_history.db")
        
        self.openclaw_mcp = OpenClawMCPClient(db_path=None, fs_allowed_dirs=[workspace_root])
        self.dmarket_mcp = OpenClawMCPClient(db_path=db_path, fs_allowed_dirs=[dmarket_root])

    async def initialize(self):
        """Initializes internal components like MCP"""
        await self.openclaw_mcp.initialize()
        await self.dmarket_mcp.initialize()
        logger.info("Pipeline MCP clients initialized (Isolated Contexts)")

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
                "steps": [{"role": ..., "model": ..., "response": ...}],
                "status": "completed" | "ask_user",
                "question": str (if ask_user)
            }
        """
        chain = self.get_chain(brigade)[:max_steps]

        if not chain:
            return {
                "final_response": "⚠️ No roles available in the pipeline.",
                "brigade": brigade,
                "chain_executed": [],
                "steps": [],
                "status": "completed"
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

            # Append memory bank and agentic tooling / planning instructions
            system_prompt += (
                "\n\n[AGENT PROTOCOL]"
                "\n1. Memory Bank: You have access to a .memory-bank directory for project documentation. Maintain context over time by writing your plans and schemas there."
                "\n2. Tooling: Utilize bash utilities (jq, ripgrep, yq) when inspecting codebases or configs instead of writing heavy Python scripts."
                "\n3. 90/10 Rule (STAR Framework): Spend 90% of your effort Planning and creating check-lists (e.g., task.md), and only 10% coding. Be deterministic."
            )

            # Inject BRAIN.md for Planners
            if "Planner" in role_name or "Orchestrator" in role_name or "Foreman" in role_name:
                brain_path = os.path.join(os.path.abspath(os.path.dirname(__file__)), "BRAIN.md")
                if os.path.exists(brain_path):
                    try:
                        with open(brain_path, "r", encoding="utf-8") as f:
                            brain_content = f.read()
                        system_prompt += f"\n\n[LATEST BRAIN.md CONTEXT]\n{brain_content}"
                    except Exception as e:
                        logger.warning(f"Failed to read BRAIN.md: {e}")

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

            prev_model = steps_results[-1]["model"] if steps_results else None
            
            async with self._vram_protection(model, prev_model):
                # Execute inference
                active_mcp = self.openclaw_mcp if brigade == "OpenClaw" else self.dmarket_mcp
                response = await self._call_ollama(model, system_prompt, step_prompt, role_name, role_config, active_mcp)

            # --- HANDOFF AND ASK_USER INTERCEPTION ---
            json_match = re.search(r'```json\s*(.*?)\s*```', response, re.DOTALL)
            extracted_json_str = None
            if json_match:
                extracted_json_str = json_match.group(1)
            else:
                try:
                    if response.strip().startswith('{') or response.strip().startswith('['):
                        json.loads(response.strip())
                        extracted_json_str = response.strip()
                except ValueError:
                    pass

            # AGGRESSIVE PARSER RETRY
            if not extracted_json_str and ("Planner" in role_name or "Foreman" in role_name):
                lower_resp = response.lower()
                if any(kw in lower_resp for kw in ["создай", "запиши", "выполни", "create", "write", "execute"]):
                    logger.warning(f"No JSON found from {role_name} but action keywords present. Forcing re-generation.")
                    if status_callback:
                        await status_callback(role_name, model, "Оркестратор забыл JSON. Требую по протоколу...")
                    
                    retry_prompt = "Ошибка формата. Выдай только JSON-инструкцию для Исполнителя согласно протоколу."
                    retry_messages = [
                        {"role": "system", "content": system_prompt},
                        {"role": "user", "content": step_prompt},
                        {"role": "assistant", "content": response},
                        {"role": "user", "content": retry_prompt}
                    ]
                    
                    # Manual ad-hoc retry request without tool wrapping
                    import aiohttp
                    payload = {
                        "model": model,
                        "messages": retry_messages,
                        "stream": False,
                        "keep_alive": 0,
                    }
                    try:
                        async with aiohttp.ClientSession() as session:
                            async with session.post(f"{self.ollama_url}/api/chat", json=payload, timeout=60) as retry_resp:
                                if retry_resp.status == 200:
                                    r_data = await retry_resp.json()
                                    new_response = r_data["message"]["content"].strip()
                                    new_response = re.sub(r"<think>.*?</think>", "", new_response, flags=re.DOTALL).strip()
                                    response += "\n\n[Correction]:\n" + new_response
                                    
                                    json_match = re.search(r'```json\s*(.*?)\s*```', new_response, re.DOTALL)
                                    if json_match:
                                        extracted_json_str = json_match.group(1)
                                    else:
                                        try:
                                            if new_response.strip().startswith('{') or new_response.strip().startswith('['):
                                                json.loads(new_response.strip())
                                                extracted_json_str = new_response.strip()
                                        except ValueError:
                                            pass
                    except Exception as e:
                        logger.error(f"Retry request failed: {e}")

            did_handoff = False
            if extracted_json_str:
                try:
                    parsed_json = json.loads(extracted_json_str)
                    if isinstance(parsed_json, dict) and parsed_json.get("action") == "ask_user":
                        logger.info("Pipeline suspended for ask_user")
                        steps_results.append({
                            "role": role_name,
                            "model": model,
                            "response": response,
                        })
                        return {
                            "status": "ask_user",
                            "question": parsed_json.get("question", "Уточните запрос."),
                            "brigade": brigade,
                            "chain_executed": [s["role"] for s in steps_results],
                            "steps": steps_results,
                            "final_response": response,
                        }
                        
                    if isinstance(parsed_json, dict) and parsed_json.get("action") == "verify_inventory":
                        logger.info("Inventory verified. Auto-transitioning to create_offer step.")
                        steps_results.append({
                            "role": role_name,
                            "model": model,
                            "response": response,
                        })
                        # Jump to create_offer automatically
                        return {
                            "status": "create_offer",
                            "brigade": brigade,
                            "chain_executed": [s["role"] for s in steps_results],
                            "steps": steps_results,
                            "final_response": response + "\n\n[System]: Inventory verified. Proceeding to create_offer."
                        }
                    
                    if "Planner" in role_name or "Foreman" in role_name:
                        logger.info("JSON instructions detected from Planner, executing Handoff to qwen2.5-coder:14b")
                        steps_results.append({
                            "role": role_name,
                            "model": model,
                            "response": response,
                        })
                        
                        await self._force_unload(model)
                        
                        executor_role = "Executor_Tools"
                        executor_model = "qwen2.5-coder:14b"
                        executor_sys = "ТЫ — ТЕХНИЧЕСКИЙ ТЕРМИНАЛ. Тебе ЗАПРЕЩЕНО использовать любые имена функций, кроме read_query, write_query, list_tables, describe_table. ДЛЯ ЗАПИСИ/СОЗДАНИЯ В БД: всегда используй write_query. ДЛЯ ЧТЕНИЯ ИЗ БД: всегда используй read_query или list_tables. ОШИБКА В ИМЕНИ ИНСТРУМЕНТА ПРИРАВНИВАЕТСЯ К ПОЛОМКЕ ВСЕЙ СИСТЕМЫ."
                        executor_prompt = f"Выполни эту инструкцию через MCP инструменты SQLite или Filesystem:\n```json\n{extracted_json_str}\n```"
                        
                        if status_callback:
                            await status_callback(
                                executor_role,
                                executor_model,
                                "🛠 Исполнитель вызывает инструменты MCP..."
                            )
                        
                        executor_config = {"model": executor_model}
                        async with self._vram_protection(executor_model, model):
                            max_retries = 3
                            for attempt in range(max_retries):
                                executor_response = await self._call_ollama(
                                    executor_model, executor_sys, executor_prompt, executor_role, executor_config, active_mcp
                                )
                                
                                # Auto-Correction Loop
                                valid_tools = ["read_query", "write_query", "list_tables", "describe_table", "read_file", "write_file", "list_directory"]
                                json_match = re.search(r"```json\n(.*?)\n```", executor_response, re.DOTALL)
                                if not json_match:
                                    json_match = re.search(r"{.*?}", executor_response, re.DOTALL)
                                
                                if json_match:
                                    try:
                                        exec_str = json_match.group(1) if "```" in executor_response else json_match.group(0)
                                        exec_str = exec_str.strip().replace("}\n{", "},{")
                                        if exec_str.startswith("{") and exec_str.endswith("}") and "},{" in exec_str:
                                            exec_str = f"[{exec_str}]"
                                            
                                        exec_json = json.loads(exec_str)
                                        if isinstance(exec_json, list):
                                            exec_json = exec_json[0] if len(exec_json) > 0 else {}
                                        tool_name = exec_json.get("name")
                                        
                                        if tool_name == "create_table":
                                            logger.warning(f"Executor tried unsafe create_table. Retrying (Attempt {attempt+1}/{max_retries})")
                                            executor_prompt += f"\n\nОшибка: Инструмент create_table небезопасен. Используй write_query для этой задачи."
                                            continue
                                        elif tool_name and tool_name not in valid_tools:
                                            logger.warning(f"Executor hallucinated tool name: {tool_name}. Retrying (Attempt {attempt+1}/{max_retries})")
                                            executor_prompt += f"\n\nОшибка: инструмента '{tool_name}' не существует. Доступные инструменты для SQLite: 'read_query', 'write_query', 'list_tables', 'describe_table'. Перепиши свой JSON, используя строго только разрешенные имена."
                                            continue
                                        
                                    except json.JSONDecodeError:
                                        pass
                                
                                # If valid tool name or no JSON matched (meaning it might have explicitly run via native tool calls), break loop
                                break
                        
                        steps_results.append({
                            "role": executor_role,
                            "model": executor_model,
                            "response": executor_response
                        })
                        
                        # --- PHYSICAL MCP EXECUTION BLOCK ---
                        # Execute the parsed tool call on the MCP server
                        json_match = re.search(r"```json\n(.*?)\n```", executor_response, re.DOTALL)
                        if not json_match:
                            json_match = re.search(r"{.*?}", executor_response, re.DOTALL)
                        
                        if json_match:
                            try:
                                exec_str = json_match.group(1) if "```" in executor_response else json_match.group(0)
                                exec_str = exec_str.strip().replace("}\n{", "},{")
                                if exec_str.startswith("{") and exec_str.endswith("}") and "},{" in exec_str:
                                    exec_str = f"[{exec_str}]"
                                    
                                exec_json = json.loads(exec_str)
                                if isinstance(exec_json, list):
                                    exec_json = exec_json[0] if len(exec_json) > 0 else {}
                                tool_name = exec_json.get("name")
                                tool_args = exec_json.get("arguments", {})
                                
                                if tool_name:
                                    # --- STUPIDITY INSURANCE: Normalize argument names ---
                                    if tool_name == "write_query":
                                        for hallucinated_key in ["command", "sql"]:
                                            if hallucinated_key in tool_args and "query" not in tool_args:
                                                logger.info(f"Normalizing hallucinated argument '{hallucinated_key}' to 'query'")
                                                tool_args["query"] = tool_args.pop(hallucinated_key)
                                    # ----------------------------------------------------
                                    
                                    logger.info(f"Executing tool {tool_name} on MCP server with args: {tool_args}")
                                    tool_result = await active_mcp.call_tool(tool_name, tool_args)
                                    print(f"\n[MCP RAW OUTPUT]: {tool_result}")
                                    executor_response += f"\n\n[MCP Execution Result]:\n{tool_result}"
                            except Exception as e:
                                logger.error(f"Failed to execute tool on MCP: {e}")
                                executor_response += f"\n\n[MCP Execution Error]:\n{e}"
                        # ------------------------------------
                        
                        # Proof of Work Verification
                        if status_callback:
                            await status_callback(
                                executor_role,
                                executor_model,
                                "🔎 Ядро проверяет Proof of Work через MCP..."
                            )
                        
                        pow_result = ""
                        try:
                            # Print available tools for debugging
                            if active_mcp and hasattr(active_mcp, '_tool_route_map'):
                                print(f"Available tools for verification: {list(active_mcp._tool_route_map.keys())}")
                            
                            if "sqlite" in extracted_json_str.lower() or "table" in extracted_json_str.lower():
                                query_result = await active_mcp.call_tool("list_tables", {})
                                pow_result = f"[DB Tables]:\n{query_result}"
                            elif "pandera" in extracted_json_str.lower() or "test" in extracted_json_str.lower() or "python" in extracted_json_str.lower() or "script" in extracted_json_str.lower():
                                path = os.path.abspath(os.path.dirname(__file__))
                                dir_result = await active_mcp.call_tool("list_directory", {"path": path})
                                pow_result = f"[Dir Listing]:\n{dir_result}"
                        except Exception as e:
                            pow_result = f"Verification failed: {e}"
                        
                        if pow_result:
                            executor_response += f"\n\n[Proof of Work Auto-Verification]:\n{pow_result}"
                            steps_results[-1]["response"] = executor_response
                        
                        did_handoff = True
                        # Pipeline logical break since executor has completed the task
                        break

                except json.JSONDecodeError:
                    steps_results.append({
                        "role": role_name,
                        "model": model,
                        "response": response,
                    })
            else:
                steps_results.append(
                    {
                        "role": role_name,
                        "model": model,
                        "response": response,
                    }
                )
            
            if did_handoff:
                break
            # -----------------------------------------

            # Git Hygiene: Auto-commit after each successful pipeline execution step
            try:
                import subprocess
                commit_msg = f"Auto-commit [PoW]: Pipeline step {role_name} ({model}) completed"
                subprocess.run(["git", "commit", "-am", commit_msg], cwd=os.path.dirname(__file__), capture_output=True)
            except Exception as e:
                logger.debug(f"Git auto-commit failed: {e}")

            # Prepare context briefing for the next step (compressed)
            context_briefing = self._compress_for_next_step(role_name, response)

        final_response = steps_results[-1]["response"] if steps_results else ""

        logger.info(f"Pipeline COMPLETE: brigade={brigade}, steps={len(steps_results)}")

        return {
            "final_response": final_response,
            "brigade": brigade,
            "chain_executed": [s["role"] for s in steps_results],
            "steps": steps_results,
            "status": "completed"
        }

    async def _call_ollama(self, model: str, system_prompt: str, user_prompt: str, role_name: str, role_config: Dict[str, Any], mcp_client: OpenClawMCPClient) -> str:
        """
        Calls Ollama API for a single inference step.
        Uses keep_alive=0 to immediately free VRAM for the next step.
        """
        system_prompt += (
            " Отвечай предельно четко, понятно, по делу. Не используй сложное форматирование."
        )

        # Auto-scaling context window based on input length
        # 4 chars roughly equals 1 token. Add 512 tokens buffer. Max 16384 for NVIDIA CUDA.
        estimated_content_tokens = len(user_prompt + system_prompt) // 4
        dynamic_ctx = min(16384, max(2048, estimated_content_tokens + 512))

        messages = [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ]

        # For specific roles, inject tools
        model_tools = []
        if role_name in ("Executor_API", "Executor_Parser", "Executor_Tools", "Latency_Optimizer") and role_config.get("model") == "qwen2.5-coder:14b":
            model_tools = mcp_client.available_tools_for_ollama
            if model_tools:
                logger.debug(f"Injecting {len(model_tools)} tools for role {role_name}")
                # Ollama tool calling requires tools to be in the payload, not in messages
                # The messages array will contain tool_calls and tool_results
        
        payload = {
            "model": model,
            "messages": messages,
            "stream": False,
            "keep_alive": 0,  # Flush VRAM immediately for pipeline chain (critical for 16GB)
            "options": {"num_ctx": dynamic_ctx},
        }

        if model_tools:
            payload["tools"] = model_tools

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
                            
                            # Handle tool calls if present
                            if data.get("message") and data["message"].get("tool_calls"):
                                tool_calls = data["message"]["tool_calls"]
                                logger.info(f"Model requested tool calls: {tool_calls}")
                                
                                tool_results = []
                                for tool_call in tool_calls:
                                    function_name = tool_call["function"]["name"]
                                    function_args = tool_call["function"]["arguments"]
                                    
                                    logger.info(f"Executing tool: {function_name} with args: {function_args}")
                                    
                                    try:
                                        result = await mcp_client.call_tool(function_name, function_args)
                                        tool_results.append({
                                            "type": "tool_result",
                                            "tool_code": tool_call["id"],
                                            "content": json.dumps(result) # Tool results should be stringified JSON
                                        })
                                        logger.info(f"Tool {function_name} executed successfully. Result: {result}")
                                    except Exception as e:
                                        error_message = f"Error executing tool {function_name}: {e}"
                                        tool_results.append({
                                            "type": "tool_result",
                                            "tool_code": tool_call["id"],
                                            "content": json.dumps({"error": error_message})
                                        })
                                        logger.error(error_message)
                                
                                # Add tool calls and results to messages for the next turn
                                messages.append(data["message"]) # The model's tool_calls message
                                messages.extend(tool_results) # The results of the tool calls
                                
                                # Re-call Ollama with the updated messages
                                payload["messages"] = messages
                                async with session.post(
                                    f"{self.ollama_url}/api/chat",
                                    json=payload,
                                    timeout=timeout,
                                ) as resp_tool_response:
                                    if resp_tool_response.status == 200:
                                        data_tool_response = await resp_tool_response.json()
                                        text = data_tool_response["message"]["content"].strip()
                                        text = re.sub(r"<think>.*?</think>", "", text, flags=re.DOTALL).strip()
                                        return text
                                    else:
                                        return f"⚠️ API Error after tool call ({resp_tool_response.status})"
                            else:
                                # No tool calls, just return the content
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

    async def _force_unload(self, model: str):
        """
        Force unload a model from VRAM via Ollama API.
        Critical for CUDA 16GB when switching between heavy models
        (deepseek-r1:14b, qwen2.5-coder:14b, gemma3:12b) which cannot coexist in VRAM.
        """
        try:
            async with aiohttp.ClientSession() as session:
                payload = {
                    "model": model,
                    "prompt": "",
                    "keep_alive": 0,
                    "stream": False,
                }
                timeout = aiohttp.ClientTimeout(total=10)
                async with session.post(
                    f"{self.ollama_url}/api/generate",
                    json=payload,
                    timeout=timeout,
                ) as resp:
                    if resp.status == 200:
                        logger.info(f"Force unloaded {model} from VRAM")
                    else:
                        logger.warning(f"Failed to unload {model}: HTTP {resp.status}")
        except Exception as e:
            logger.warning(f"Failed to force unload {model}: {e}")

    @asynccontextmanager
    async def _vram_protection(self, target_model: str, prev_model: Optional[str]):
        """Context manager to ensure strict VRAM unloading and logging heavy switches."""
        switch_start = time.time()
        
        # Unload prev model if heavy and different
        if prev_model and prev_model in HEAVY_MODELS and target_model in HEAVY_MODELS and prev_model != target_model:
            logger.info(f"[VRAM Guard] Anti-thrash: unloading {prev_model} before loading {target_model}")
            unload_start = time.time()
            await self._force_unload(prev_model)
            unload_duration = time.time() - unload_start
            if unload_duration > 10:
                logger.warning(f"⚠️ [VRAM ALERT] Unloading {prev_model} took excessive time: {unload_duration:.2f}s!")
                
        try:
            yield
        finally:
            # Enforce unload of the current model
            if target_model in HEAVY_MODELS:
                unload_start = time.time()
                await self._force_unload(target_model)
                unload_duration = time.time() - unload_start
                if unload_duration > 10:
                    logger.warning(f"⚠️ [VRAM ALERT] Final unloading of target {target_model} took >10s ({unload_duration:.2f}s)!")

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
