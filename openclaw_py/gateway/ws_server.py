"""WebSocket server integration.

This module integrates WebSocket functionality into the FastAPI application.
"""

from fastapi import APIRouter, WebSocket
from fastapi.responses import HTMLResponse

from openclaw_py.config import GatewayConfig

from .ws_broadcast import broadcast_event
from .ws_connection import WebSocketConnectionManager, handle_websocket_connection

# Global connection manager
_connection_manager = WebSocketConnectionManager()


def get_connection_manager() -> WebSocketConnectionManager:
    """Get the global WebSocket connection manager.

    Returns:
        WebSocket connection manager instance
    """
    return _connection_manager


def create_websocket_router(config: GatewayConfig) -> APIRouter:
    """Create WebSocket router with endpoints.

    Args:
        config: Gateway configuration

    Returns:
        FastAPI APIRouter with WebSocket routes
    """
    router = APIRouter()

    @router.websocket("/ws")
    async def websocket_endpoint(websocket: WebSocket):
        """WebSocket endpoint for client connections.

        This is the main WebSocket endpoint that clients connect to.
        """
        # Get client IP from connection
        client_ip = None
        if websocket.client:
            client_ip = websocket.client.host

        # Handle the connection
        await handle_websocket_connection(
            websocket=websocket,
            config=config,
            manager=_connection_manager,
            client_ip=client_ip,
        )

    @router.get("/ws-test")
    async def websocket_test_page():
        """Simple test page for WebSocket connection.

        Returns:
            HTML page with WebSocket test client
        """
        html_content = """
        <!DOCTYPE html>
        <html>
        <head>
            <title>WebSocket Test</title>
            <style>
                body {
                    font-family: Arial, sans-serif;
                    max-width: 800px;
                    margin: 50px auto;
                    padding: 20px;
                }
                #messages {
                    border: 1px solid #ccc;
                    height: 400px;
                    overflow-y: scroll;
                    padding: 10px;
                    margin: 20px 0;
                    background: #f5f5f5;
                }
                .message {
                    margin: 5px 0;
                    padding: 5px;
                    border-radius: 3px;
                }
                .sent {
                    background: #e3f2fd;
                }
                .received {
                    background: #f1f8e9;
                }
                button {
                    margin: 5px;
                    padding: 10px 20px;
                    cursor: pointer;
                }
                input {
                    padding: 10px;
                    width: 300px;
                }
            </style>
        </head>
        <body>
            <h1>WebSocket Test Client</h1>
            <div>
                <button onclick="connect()">Connect</button>
                <button onclick="disconnect()">Disconnect</button>
                <button onclick="ping()">Ping</button>
                <button onclick="getStatus()">Get Status</button>
            </div>
            <div>
                <input type="text" id="method" placeholder="Method name" value="ping">
                <input type="text" id="params" placeholder="Params (JSON)" value="{}">
                <button onclick="sendRequest()">Send Request</button>
            </div>
            <div id="status">Disconnected</div>
            <div id="messages"></div>
            <script>
                let ws = null;
                let messageId = 0;

                function connect() {
                    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
                    const wsUrl = `${protocol}//${window.location.host}/ws`;

                    ws = new WebSocket(wsUrl);

                    ws.onopen = () => {
                        updateStatus('Connected');
                        addMessage('Connected to ' + wsUrl, 'system');

                        // Send connect frame
                        const connectFrame = {
                            type: 'request',
                            id: 'connect',
                            method: 'connect',
                            params: {
                                client_id: 'test-client',
                                client_version: '1.0.0',
                                protocol_version: '1.0',
                                platform: 'web'
                            }
                        };
                        ws.send(JSON.stringify(connectFrame));
                        addMessage('SENT: ' + JSON.stringify(connectFrame, null, 2), 'sent');
                    };

                    ws.onmessage = (event) => {
                        addMessage('RECEIVED: ' + event.data, 'received');
                    };

                    ws.onerror = (error) => {
                        addMessage('ERROR: ' + error, 'error');
                    };

                    ws.onclose = () => {
                        updateStatus('Disconnected');
                        addMessage('Disconnected', 'system');
                    };
                }

                function disconnect() {
                    if (ws) {
                        ws.close();
                        ws = null;
                    }
                }

                function ping() {
                    sendMethod('ping', {});
                }

                function getStatus() {
                    sendMethod('get_status', {});
                }

                function sendRequest() {
                    const method = document.getElementById('method').value;
                    const paramsStr = document.getElementById('params').value;
                    let params = {};
                    try {
                        params = JSON.parse(paramsStr);
                    } catch (e) {
                        alert('Invalid JSON params');
                        return;
                    }
                    sendMethod(method, params);
                }

                function sendMethod(method, params) {
                    if (!ws || ws.readyState !== WebSocket.OPEN) {
                        alert('Not connected');
                        return;
                    }

                    messageId++;
                    const frame = {
                        type: 'request',
                        id: String(messageId),
                        method: method,
                        params: params
                    };

                    ws.send(JSON.stringify(frame));
                    addMessage('SENT: ' + JSON.stringify(frame, null, 2), 'sent');
                }

                function updateStatus(status) {
                    document.getElementById('status').textContent = 'Status: ' + status;
                }

                function addMessage(text, type) {
                    const messagesDiv = document.getElementById('messages');
                    const messageDiv = document.createElement('div');
                    messageDiv.className = 'message ' + type;
                    messageDiv.textContent = text;
                    messagesDiv.appendChild(messageDiv);
                    messagesDiv.scrollTop = messagesDiv.scrollHeight;
                }
            </script>
        </body>
        </html>
        """
        return HTMLResponse(content=html_content)

    return router


async def broadcast_to_all(event_name: str, params: dict | None = None) -> int:
    """Broadcast an event to all connected clients.

    This is a convenience function that uses the global connection manager.

    Args:
        event_name: Name of the event
        params: Event parameters

    Returns:
        Number of clients that received the event

    Examples:
        >>> count = await broadcast_to_all("config.updated", {"version": 2})
        >>> count >= 0
        True
    """
    manager = get_connection_manager()
    return await broadcast_event(
        event_name=event_name,
        params=params,
        connections=manager.connections,
    )
