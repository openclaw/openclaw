"""Gateway command - manage Gateway server."""

import asyncio
import signal
import sys

import typer

from openclaw_py.cli.utils import error_exit, info, success
from openclaw_py.config.loader import load_config_sync as load_config

gateway_app = typer.Typer(name="gateway", help="Manage Gateway server")


@gateway_app.command(name="start")
def start_cmd(
    host: str = typer.Option("127.0.0.1", "--host", "-h", help="Host to bind to"),
    http_port: int | None = typer.Option(None, "--http-port", help="HTTP port (overrides config)"),
    ws_port: int | None = typer.Option(None, "--ws-port", help="WebSocket port (overrides config)"),
) -> None:
    """Start the Gateway server."""
    try:
        config = load_config()

        # Determine ports
        final_http_port = http_port or (config.gateway.http.port if config.gateway and config.gateway.http else 3420)
        final_ws_port = ws_port or (config.gateway.ws.port if config.gateway and config.gateway.ws else 3421)

        info(f"Starting OpenClaw Gateway...")
        info(f"  HTTP server: http://{host}:{final_http_port}")
        info(f"  WebSocket server: ws://{host}:{final_ws_port}")
        info("")
        info("Press Ctrl+C to stop the server")
        info("=" * 60)

        # Run the gateway
        async def run_gateway():
            from openclaw_py.gateway.server import create_gateway_server

            server = create_gateway_server(config)

            # Setup signal handlers
            loop = asyncio.get_event_loop()

            def signal_handler():
                info("\n\nShutting down Gateway...")
                loop.stop()

            for sig in (signal.SIGTERM, signal.SIGINT):
                loop.add_signal_handler(sig, signal_handler)

            try:
                await server.start(host=host, http_port=final_http_port, ws_port=final_ws_port)
            except KeyboardInterrupt:
                pass
            finally:
                await server.stop()

        asyncio.run(run_gateway())

        success("\nGateway stopped.")

    except Exception as e:
        error_exit(f"Failed to start Gateway: {e}")


@gateway_app.command(name="stop")
def stop_cmd() -> None:
    """Stop the Gateway server."""
    info("Gateway stop not yet implemented (use Ctrl+C in the start terminal)")


@gateway_app.command(name="status")
def status_cmd() -> None:
    """Check Gateway server status."""
    try:
        config = load_config()

        http_port = config.gateway.http.port if config.gateway and config.gateway.http else 3420
        ws_port = config.gateway.ws.port if config.gateway and config.gateway.ws else 3421

        info(f"Gateway configuration:")
        info(f"  HTTP port: {http_port}")
        info(f"  WebSocket port: {ws_port}")

        # Try to check if server is running
        import socket

        def is_port_open(port: int) -> bool:
            sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            sock.settimeout(1)
            result = sock.connect_ex(("127.0.0.1", port))
            sock.close()
            return result == 0

        http_running = is_port_open(http_port)
        ws_running = is_port_open(ws_port)

        info(f"\nServer status:")
        info(f"  HTTP: {'Running' if http_running else 'Stopped'}")
        info(f"  WebSocket: {'Running' if ws_running else 'Stopped'}")

        if not (http_running or ws_running):
            info("\n💡 Start the server with: openclaw gateway start")

    except Exception as e:
        error_exit(f"Failed to check Gateway status: {e}")
