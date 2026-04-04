# Jobber Routing Reference

**App name:** `jobber`
**Base URL proxied:** `api.getjobber.com/api/`

## API Type

Jobber uses a GraphQL API exclusively. All requests are POST requests to the `/graphql` endpoint.

## API Path Pattern

```
/jobber/graphql
```

All operations use POST with a JSON body containing the `query` field.

## Version Header

The gateway automatically injects the `X-JOBBER-GRAPHQL-VERSION` header (currently `2025-04-16`).

## Common Operations

### Get Account

```bash
POST /jobber/graphql
Content-Type: application/json

{
  "query": "{ account { id name } }"
}
```

### List Clients

```bash
POST /jobber/graphql
Content-Type: application/json

{
  "query": "{ clients(first: 20) { nodes { id name emails { address } phones { number } } pageInfo { hasNextPage endCursor } } }"
}
```

### Get Client

```bash
POST /jobber/graphql
Content-Type: application/json

{
  "query": "query($id: EncodedId!) { client(id: $id) { id name emails { address } } }",
  "variables": { "id": "CLIENT_ID" }
}
```

### Create Client

```bash
POST /jobber/graphql
Content-Type: application/json

{
  "query": "mutation($input: ClientCreateInput!) { clientCreate(input: $input) { client { id name } userErrors { message path } } }",
  "variables": {
    "input": {
      "firstName": "John",
      "lastName": "Doe",
      "emails": [{"address": "john@example.com"}]
    }
  }
}
```

### List Jobs

```bash
POST /jobber/graphql
Content-Type: application/json

{
  "query": "{ jobs(first: 20) { nodes { id title jobNumber jobStatus client { name } } pageInfo { hasNextPage endCursor } } }"
}
```

### Create Job

```bash
POST /jobber/graphql
Content-Type: application/json

{
  "query": "mutation($input: JobCreateInput!) { jobCreate(input: $input) { job { id jobNumber } userErrors { message path } } }",
  "variables": {
    "input": {
      "clientId": "CLIENT_ID",
      "title": "Service Job"
    }
  }
}
```

### List Invoices

```bash
POST /jobber/graphql
Content-Type: application/json

{
  "query": "{ invoices(first: 20) { nodes { id invoiceNumber total invoiceStatus } pageInfo { hasNextPage endCursor } } }"
}
```

### List Quotes

```bash
POST /jobber/graphql
Content-Type: application/json

{
  "query": "{ quotes(first: 20) { nodes { id quoteNumber title quoteStatus } pageInfo { hasNextPage endCursor } } }"
}
```

### List Properties

```bash
POST /jobber/graphql
Content-Type: application/json

{
  "query": "{ properties(first: 20) { nodes { id address { street city } client { name } } } }"
}
```

### List Users

```bash
POST /jobber/graphql
Content-Type: application/json

{
  "query": "{ users(first: 50) { nodes { id name { full } email { raw } } } }"
}
```

## Pagination

Jobber uses Relay-style cursor-based pagination:

```bash
# First page
{
  "query": "{ clients(first: 20) { nodes { id name } pageInfo { hasNextPage endCursor } } }"
}

# Next page
{
  "query": "{ clients(first: 20, after: \"CURSOR\") { nodes { id name } pageInfo { hasNextPage endCursor } } }"
}
```

## Notes

- Jobber uses GraphQL exclusively (no REST API)
- Gateway injects version header automatically (`2025-04-16`)
- IDs use `EncodedId` type (base64 encoded) - pass as strings
- Field naming: `emails`/`phones` (arrays), `jobStatus`/`invoiceStatus`/`quoteStatus`
- Rate limits: 2,500 requests per 5 minutes, plus query cost limits (max 10,000 points)
- Old API versions supported for 12-18 months
- Available resources: Clients, Jobs, Invoices, Quotes, Requests, Properties, Users, Custom Fields

## Resources

- [Jobber Developer Documentation](https://developer.getjobber.com/docs/)
- [API Changelog](https://developer.getjobber.com/docs/changelog)
- [API Support](mailto:api-support@getjobber.com)
