# Authentication Notes

All API requests require an `x-api-key` header. Store your key in `$COPERNIQ_API_KEY`.

## Getting an API Key

Generate a key via `POST https://api.coperniq.io/v1/api-keys` using Basic Auth
(your Coperniq email + password):

```bash
curl -s -X POST "https://api.coperniq.io/v1/api-keys" \
  -H "Authorization: Basic <base64(email:password)>" \
  -H "Content-Type: application/json" \
  -d '{}'
```

Response:

```json
{
  "token": "<your-api-key>",
  "companyId": 392,
  "description": "...",
  "name": "...",
  "email": "...",
  "id": 14350
}
```

The `token` value is your API key. Store it:

```bash
export COPERNIQ_API_KEY="<token>"
```

## Key Properties

- Keys inherit the permissions of the user that created them.
- You can create multiple keys for different environments.
- Rotate keys regularly; delete unused ones.
