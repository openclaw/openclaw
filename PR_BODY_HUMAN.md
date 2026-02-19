Multi-device browser relay support (Relay Naming)

This PR enables addressing browser commands to specific devices when multiple relays are connected to the same Gateway. Previously, the Gateway only supported one Chrome extension connection at a time, leading to command collisions and 409 errors when connecting multiple devices.

Key changes:

- Chrome extension UI: Added a "Relay name" field in the options page. The name is persisted and sent to the Gateway during the WebSocket handshake.
- Gateway relay server: Refactored to support multiple concurrent connections. CDP command routing now identifies which device owns each sessionId or targetId.
- CLI: Added a global --relay <name> flag to all browser commands.
- Diagnostics: New 'openclaw browser extension check' command to validate connectivity and list all connected devices.

I have tested this locally with my Mac and PC connected simultaneously, and the targeting works correctly.

Testing degree: Fully tested locally with multi-device setup.
AI assistance: This PR was developed with AI assistance (Etiven). I have reviewed and understand all changes.
