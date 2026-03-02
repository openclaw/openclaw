"""Bridge router: exposes SofaGenius subagent tools as REST endpoints.

SofaGenius routes everything through POST /api/chat (conversational, SSE).
OpenClaw bridge scripts need direct REST endpoints for each tool.

This router mounts into the SofaGenius FastAPI app at deploy time and wraps
the internal tool functions as simple request/response endpoints.

Mounted via: app.include_router(bridge_router) in main.py
Or injected at startup via the Dockerfile overlay.
"""

import json
import logging
import os
import time
from pathlib import Path

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

logger = logging.getLogger("bridge_router")

router = APIRouter(prefix="/api")

# ---------------------------------------------------------------------------
# Lazy-load SofaGenius tool modules (they may have heavy imports like wandb)
# ---------------------------------------------------------------------------

_tools_cache: dict = {}


def _get_tool(module_name: str):
    """Import a SofaGenius tool module lazily."""
    if module_name not in _tools_cache:
        try:
            if module_name == "wandb_monitor":
                from backend.tools.wandb_monitor import (
                    get_wandb_info,
                    list_wandb_runs,
                    get_run_metrics,
                    analyze_run_health,
                    compare_runs,
                )
                _tools_cache[module_name] = {
                    "get_wandb_info": get_wandb_info,
                    "list_wandb_runs": list_wandb_runs,
                    "get_run_metrics": get_run_metrics,
                    "analyze_run_health": analyze_run_health,
                    "compare_runs": compare_runs,
                }
            elif module_name == "sql_analyst":
                from backend.tools.sql_analyst import (
                    search_hf_datasets,
                    discover_dataset_schema,
                    run_sql_query,
                    compute_stats,
                    inspect_dataset_format,
                )
                _tools_cache[module_name] = {
                    "search_hf_datasets": search_hf_datasets,
                    "discover_dataset_schema": discover_dataset_schema,
                    "run_sql_query": run_sql_query,
                    "compute_stats": compute_stats,
                    "inspect_dataset_format": inspect_dataset_format,
                }
            elif module_name == "scout_draft":
                from backend.tools.scout_draft import (
                    search_hf_datasets as scout_search_datasets,
                    search_hf_models,
                    create_draft_post_card,
                )
                _tools_cache[module_name] = {
                    "search_hf_datasets": scout_search_datasets,
                    "search_hf_models": search_hf_models,
                    "create_draft_post_card": create_draft_post_card,
                }
            elif module_name == "modal_launcher":
                from backend.tools.modal_launcher import (
                    propose_finetuning_config,
                    estimate_cost,
                )
                _tools_cache[module_name] = {
                    "propose_finetuning_config": propose_finetuning_config,
                    "estimate_cost": estimate_cost,
                }
        except ImportError as e:
            logger.warning("Could not import %s: %s", module_name, e)
            _tools_cache[module_name] = {}
    return _tools_cache[module_name]


def _safe_call(tool_fn, **kwargs) -> dict:
    """Call a tool function, handling both sync and async, and normalize output."""
    import asyncio
    try:
        if asyncio.iscoroutinefunction(tool_fn):
            loop = asyncio.get_event_loop()
            if loop.is_running():
                import concurrent.futures
                with concurrent.futures.ThreadPoolExecutor() as pool:
                    result = pool.submit(asyncio.run, tool_fn(**kwargs)).result()
            else:
                result = asyncio.run(tool_fn(**kwargs))
        else:
            result = tool_fn(**kwargs)

        if isinstance(result, str):
            try:
                return json.loads(result)
            except json.JSONDecodeError:
                return {"result": result}
        elif isinstance(result, dict):
            return result
        else:
            return {"result": str(result)}
    except Exception as e:
        logger.exception("Tool call failed: %s", e)
        raise HTTPException(status_code=500, detail=str(e))


# ===========================================================================
# Training endpoints (wraps wandb_monitor tools)
# ===========================================================================

class TrainingStatusRequest(BaseModel):
    run_id: str

class TrainingAnomaliesRequest(BaseModel):
    run_id: str

class TrainingCompareRequest(BaseModel):
    run_ids: list[str]


@router.post("/training/status")
async def training_status(req: TrainingStatusRequest):
    """Get W&B run status and metrics."""
    tools = _get_tool("wandb_monitor")
    if "get_run_metrics" not in tools:
        raise HTTPException(status_code=501, detail="wandb_monitor tools not available")
    # Try get_run_metrics first, fall back to get_wandb_info
    result = _safe_call(tools["get_run_metrics"], run_id=req.run_id)
    return result


@router.post("/training/anomalies")
async def training_anomalies(req: TrainingAnomaliesRequest):
    """Analyze run health and detect anomalies."""
    tools = _get_tool("wandb_monitor")
    if "analyze_run_health" not in tools:
        raise HTTPException(status_code=501, detail="wandb_monitor tools not available")
    result = _safe_call(tools["analyze_run_health"], run_id=req.run_id)
    return result


@router.post("/training/compare")
async def training_compare(req: TrainingCompareRequest):
    """Compare multiple W&B runs."""
    tools = _get_tool("wandb_monitor")
    if "compare_runs" not in tools:
        raise HTTPException(status_code=501, detail="wandb_monitor tools not available")
    result = _safe_call(tools["compare_runs"], run_ids=req.run_ids)
    return result


@router.post("/training/check-active")
async def training_check_active():
    """Check all active runs for anomalies (proactive monitoring)."""
    tools = _get_tool("wandb_monitor")
    if "list_wandb_runs" not in tools or "analyze_run_health" not in tools:
        raise HTTPException(status_code=501, detail="wandb_monitor tools not available")

    # List active runs, then check each for anomalies
    runs_result = _safe_call(tools["list_wandb_runs"], state="running")
    runs = runs_result.get("runs", []) if isinstance(runs_result, dict) else []

    anomalies = []
    all_runs = []
    for run in runs:
        run_id = run.get("id") or run.get("run_id") or run.get("name", "")
        if not run_id:
            continue
        all_runs.append(run_id)
        try:
            health = _safe_call(tools["analyze_run_health"], run_id=run_id)
            issues = health.get("issues", health.get("anomalies", []))
            if issues:
                for issue in (issues if isinstance(issues, list) else [issues]):
                    anomalies.append({
                        "run_id": run_id,
                        "type": issue.get("type", "unknown") if isinstance(issue, dict) else str(issue),
                        "message": issue.get("message", str(issue)) if isinstance(issue, dict) else str(issue),
                    })
        except Exception as e:
            logger.warning("Could not check health for run %s: %s", run_id, e)

    return {"anomalies": anomalies, "all_runs": all_runs, "checked": len(all_runs)}


# ===========================================================================
# Data endpoints (wraps sql_analyst tools)
# ===========================================================================

class DataSearchRequest(BaseModel):
    query: str

class DataSqlRequest(BaseModel):
    dataset: str
    query: str

class DataFormatRequest(BaseModel):
    dataset: str

class DataStatsRequest(BaseModel):
    dataset: str


@router.post("/data/search")
async def data_search(req: DataSearchRequest):
    """Search HuggingFace datasets."""
    tools = _get_tool("sql_analyst")
    if "search_hf_datasets" not in tools:
        raise HTTPException(status_code=501, detail="sql_analyst tools not available")
    return _safe_call(tools["search_hf_datasets"], query=req.query)


@router.post("/data/sql")
async def data_sql(req: DataSqlRequest):
    """Run SQL query on a HuggingFace dataset via DuckDB."""
    tools = _get_tool("sql_analyst")
    if "run_sql_query" not in tools:
        raise HTTPException(status_code=501, detail="sql_analyst tools not available")
    return _safe_call(tools["run_sql_query"], dataset=req.dataset, query=req.query)


@router.post("/data/format")
async def data_format(req: DataFormatRequest):
    """Detect dataset format (ChatML, instruction, QA, etc)."""
    tools = _get_tool("sql_analyst")
    if "inspect_dataset_format" not in tools:
        raise HTTPException(status_code=501, detail="sql_analyst tools not available")
    return _safe_call(tools["inspect_dataset_format"], dataset=req.dataset)


@router.post("/data/stats")
async def data_stats(req: DataStatsRequest):
    """Get dataset statistics (row count, token stats, etc)."""
    tools = _get_tool("sql_analyst")
    if "compute_stats" not in tools:
        raise HTTPException(status_code=501, detail="sql_analyst tools not available")
    return _safe_call(tools["compute_stats"], dataset=req.dataset)


# ===========================================================================
# Scout endpoints (wraps scout_draft tools)
# ===========================================================================

class ScoutSearchRequest(BaseModel):
    query: str
    type: str = "model"

class ScoutRecommendRequest(BaseModel):
    task: str

class ScoutDraftPostRequest(BaseModel):
    run_id: str
    platform: str = "twitter"


@router.post("/scout/search")
async def scout_search(req: ScoutSearchRequest):
    """Search HuggingFace for models or datasets."""
    tools = _get_tool("scout_draft")
    if req.type == "dataset":
        fn = tools.get("search_hf_datasets")
    else:
        fn = tools.get("search_hf_models")
    if not fn:
        raise HTTPException(status_code=501, detail="scout_draft tools not available")
    return _safe_call(fn, query=req.query)


@router.post("/scout/recommend")
async def scout_recommend(req: ScoutRecommendRequest):
    """Get dataset/model recommendations for a task."""
    tools = _get_tool("scout_draft")
    # Use search as a proxy for recommendations
    fn = tools.get("search_hf_datasets") or tools.get("search_hf_models")
    if not fn:
        raise HTTPException(status_code=501, detail="scout_draft tools not available")
    return _safe_call(fn, query=req.task)


@router.post("/scout/draft-post")
async def scout_draft_post(req: ScoutDraftPostRequest):
    """Draft a social media post from W&B run metrics."""
    tools = _get_tool("scout_draft")
    fn = tools.get("create_draft_post_card")
    if not fn:
        raise HTTPException(status_code=501, detail="scout_draft tools not available")
    return _safe_call(fn, run_id=req.run_id, platform=req.platform)


# ===========================================================================
# Launch endpoints (wraps modal_launcher tools + existing /api/launch)
# ===========================================================================

class LaunchProposeRequest(BaseModel):
    dataset: str
    model: str

class LaunchModifyRequest(BaseModel):
    config_id: str
    changes: dict

class LaunchRunRequest(BaseModel):
    config_id: str
    mode: str = "experiment"

class LaunchStatusRequest(BaseModel):
    job_id: str


# In-memory config store (configs are ephemeral per deploy)
_launch_configs: dict[str, dict] = {}


@router.post("/launch/propose")
async def launch_propose(req: LaunchProposeRequest):
    """Generate a training config with cost estimate."""
    tools = _get_tool("modal_launcher")
    fn = tools.get("propose_finetuning_config")
    if fn:
        result = _safe_call(fn, dataset=req.dataset, model=req.model)
    else:
        # Fallback: generate a reasonable default config
        result = {
            "dataset": req.dataset,
            "model": req.model,
            "learning_rate": 2e-5,
            "epochs": 3,
            "batch_size": 4,
            "warmup_ratio": 0.1,
            "max_seq_length": 2048,
            "lora_r": 16,
            "lora_alpha": 32,
            "gpu": "A100-40GB",
        }

    config_id = f"cfg-{int(time.time())}"
    result["config_id"] = config_id
    _launch_configs[config_id] = result
    return result


@router.post("/launch/modify")
async def launch_modify(req: LaunchModifyRequest):
    """Modify an existing training config."""
    if req.config_id not in _launch_configs:
        raise HTTPException(status_code=404, detail=f"Config {req.config_id} not found")
    config = _launch_configs[req.config_id]
    config.update(req.changes)
    return config


@router.post("/launch/run")
async def launch_run(req: LaunchRunRequest):
    """Launch a training job on Modal."""
    if req.config_id not in _launch_configs:
        raise HTTPException(status_code=404, detail=f"Config {req.config_id} not found")

    config = _launch_configs[req.config_id]

    # Use the existing SofaGenius /api/launch mechanism if available
    # Otherwise return a stub that can be wired up
    import urllib.request
    import urllib.error

    launch_payload = {
        "job_type": "sft",
        "config": config,
        "mode": req.mode,
    }
    try:
        data = json.dumps(launch_payload).encode()
        internal_req = urllib.request.Request(
            "http://127.0.0.1:8000/api/launch",
            data=data,
            headers={"Content-Type": "application/json"},
        )
        with urllib.request.urlopen(internal_req, timeout=120) as resp:
            result = json.loads(resp.read().decode())
        result["config"] = config
        result["mode"] = req.mode
        return result
    except Exception as e:
        # If internal launch endpoint isn't available, return config for manual launch
        return {
            "status": "config_ready",
            "message": "Config ready but auto-launch unavailable. Use Modal CLI to launch manually.",
            "config": config,
            "mode": req.mode,
            "error": str(e),
        }


@router.post("/launch/status")
async def launch_status(req: LaunchStatusRequest):
    """Check job status (proxies to existing /api/launch/status endpoint)."""
    import urllib.request
    import urllib.error
    try:
        url = f"http://127.0.0.1:8000/api/launch/status/{req.job_id}"
        with urllib.request.urlopen(url, timeout=30) as resp:
            return json.loads(resp.read().decode())
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Could not reach launch status: {e}")


@router.post("/launch/check-completed")
async def launch_check_completed():
    """Check for recently completed jobs and suggest next steps."""
    # This would ideally query Modal or W&B for recently completed runs
    tools = _get_tool("wandb_monitor")
    if "list_wandb_runs" not in tools:
        return {"completed_jobs": [], "message": "wandb_monitor not available"}

    result = _safe_call(tools["list_wandb_runs"], state="finished")
    runs = result.get("runs", []) if isinstance(result, dict) else []

    completed_jobs = []
    for run in runs[:5]:  # Last 5 completed
        run_id = run.get("id") or run.get("run_id") or run.get("name", "")
        completed_jobs.append({
            "job_id": run_id,
            "final_loss": run.get("summary", {}).get("loss", "N/A") if isinstance(run.get("summary"), dict) else "N/A",
            "suggestions": [
                "Run evaluation on held-out test set",
                "Upload model to HuggingFace Hub",
                "Compare with previous best run",
            ],
        })

    return {"completed_jobs": completed_jobs}


# ===========================================================================
# Feedback endpoints (new — enables the bidirectional learning loop)
# ===========================================================================

FEEDBACK_DIR = Path(os.environ.get("OPENCLAW_STATE_DIR", "/data")) / "sofagenius-feedback"


class FeedbackIngestRequest(BaseModel):
    executions: list[dict] = []
    corrections: list[dict] = []
    patterns: list[dict] = []
    skill_drafts: list[dict] = []


@router.post("/feedback/ingest")
async def feedback_ingest(req: FeedbackIngestRequest):
    """Receive feedback from OpenClaw and store for learning."""
    FEEDBACK_DIR.mkdir(parents=True, exist_ok=True)

    total = 0
    insights = []

    for category, records in [
        ("executions", req.executions),
        ("corrections", req.corrections),
        ("patterns", req.patterns),
        ("skill_drafts", req.skill_drafts),
    ]:
        if records:
            filepath = FEEDBACK_DIR / f"{category}.jsonl"
            with open(filepath, "a") as f:
                for record in records:
                    record["_ingested_at"] = time.time()
                    f.write(json.dumps(record) + "\n")
            total += len(records)

    # Generate insights from corrections
    if req.corrections:
        param_corrections: dict[str, int] = {}
        for c in req.corrections:
            correction_text = c.get("correction", "")
            for param in ["learning_rate", "epochs", "batch_size", "warmup_ratio", "lora_r"]:
                if param in correction_text.lower():
                    param_corrections[param] = param_corrections.get(param, 0) + 1
        for param, count in param_corrections.items():
            insights.append(f"Detected preference for custom {param} ({count} correction(s))")

    if req.skill_drafts:
        for draft in req.skill_drafts:
            insights.append(f"New workflow '{draft.get('name', 'unnamed')}' queued for skill generation")

    return {"accepted": total, "rejected": 0, "insights": insights}


@router.get("/feedback/skill-updates")
async def feedback_skill_updates():
    """Check if there are evolved skills based on feedback."""
    # Future: analyze accumulated feedback and generate skill improvements
    updates_file = FEEDBACK_DIR / "skill-updates.json"
    if updates_file.exists():
        return json.loads(updates_file.read_text())
    return {"updates": [], "pending_drafts": []}


@router.get("/feedback/stats")
async def feedback_stats():
    """Get stats on accumulated feedback."""
    stats = {
        "total_executions_ingested": 0,
        "total_corrections_ingested": 0,
        "total_patterns_ingested": 0,
        "top_corrected_defaults": [],
    }

    for category in ["executions", "corrections", "patterns"]:
        filepath = FEEDBACK_DIR / f"{category}.jsonl"
        if filepath.exists():
            count = sum(1 for _ in open(filepath))
            stats[f"total_{category}_ingested"] = count

    return stats
