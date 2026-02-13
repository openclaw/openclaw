"""FastAPI application for Gateway HTTP server.

This module creates and configures the FastAPI application.
"""

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from openclaw_py.config import OpenClawConfig

from .routes import config as config_routes
from .routes import health as health_routes
from .routes import sessions as sessions_routes
from .ws_server import create_websocket_router


def create_app(config: OpenClawConfig) -> FastAPI:
    """Create and configure FastAPI application.

    Args:
        config: OpenClaw configuration

    Returns:
        Configured FastAPI application

    Examples:
        >>> from openclaw_py.config import load_config_sync
        >>> config = load_config_sync()
        >>> app = create_app(config)
    """
    app = FastAPI(
        title="OpenClaw Gateway API",
        description="HTTP API for OpenClaw Gateway",
        version="0.1.0",
    )

    # Configure CORS
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],  # TODO: Make this configurable
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    # Store config in app state
    app.state.config = config
    app.state.gateway_config = config.gateway

    # Register HTTP routes
    app.include_router(health_routes.router, tags=["health"])
    app.include_router(sessions_routes.router, tags=["sessions"])
    app.include_router(config_routes.router, tags=["config"])

    # Register WebSocket routes
    ws_router = create_websocket_router(config.gateway)
    app.include_router(ws_router, tags=["websocket"])

    # Root endpoint
    @app.get("/")
    async def root():
        """Root endpoint."""
        return {
            "name": "OpenClaw Gateway API",
            "version": "0.1.0",
            "status": "running",
        }

    return app
