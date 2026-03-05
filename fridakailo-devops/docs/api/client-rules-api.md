# Client Rules API

## GET /api/clients/:clientId/rules

Returns Layer 3 rules for the client.

## PUT /api/clients/:clientId/rules

Updates Layer 3 rules. Body: `{ rules: HarnessRule[] }`

Triggers webhook to push rules to client VPS.
