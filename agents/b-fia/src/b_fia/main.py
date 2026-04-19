"""FastAPI application for B-FIA backend."""

from __future__ import annotations

from fastapi import FastAPI, HTTPException

from .models import AnalyzeRequest
from .orchestrator import run_analysis, run_report

app = FastAPI(
    title="B-FIA Backend",
    description="Biggo Financial Intelligence Agent - orchestrates OpenBB, FinGPT, and QuantAgent",
    version="0.1.0",
)


@app.get("/health")
async def health() -> dict:
    return {"status": "ok", "service": "b-fia"}


@app.post("/api/v1/market-data")
async def market_data(req: AnalyzeRequest) -> dict:
    """Fetch market data only (OpenBB)."""
    from .services.openbb import OpenBBService

    try:
        svc = OpenBBService()
        result = await svc.fetch(req.symbol, req.period)
        return result.model_dump()
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"OpenBB error: {exc}") from exc


@app.post("/api/v1/sentiment")
async def sentiment(req: AnalyzeRequest) -> dict:
    """Fetch sentiment only (FinGPT)."""
    from .services.fingpt import FinGPTService

    try:
        svc = FinGPTService()
        result = await svc.analyze(req.symbol)
        return result.model_dump()
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"FinGPT error: {exc}") from exc


@app.post("/api/v1/signals")
async def signals(req: AnalyzeRequest) -> dict:
    """Fetch trade signals only (QuantAgent)."""
    from .services.quantagent import QuantAgentService

    try:
        svc = QuantAgentService()
        result = await svc.get_signals(req.symbol, req.period)
        return result.model_dump()
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"QuantAgent error: {exc}") from exc


@app.post("/api/v1/analyze")
async def analyze(req: AnalyzeRequest) -> dict:
    """Full orchestrated analysis (raw JSON, no channel formatting)."""
    result = await run_analysis(req.symbol, req.period)
    return result.model_dump()


@app.post("/api/v1/report")
async def report(req: AnalyzeRequest) -> dict:
    """Full analysis with channel-formatted output."""
    result = await run_report(req.symbol, req.period, req.channel)
    return result.model_dump()
