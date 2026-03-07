"""
SotyBot Engine FastAPI Application

Main endpoint serving the SotyBot HTTP API and health checks.
"""

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from config.settings import settings

app = FastAPI(
    title="SotyBot Engine API",
    version="0.1.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.security.allowed_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.get("/health")
async def health_check():
    """Healthcheck endpoint for Docker Compose."""
    return {"status": "ok"}
