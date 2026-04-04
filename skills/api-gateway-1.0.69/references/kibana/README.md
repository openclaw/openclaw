# Kibana Routing Reference

**App name:** `kibana`
**Base URL proxied:** User's Kibana instance

## API Path Pattern

```
/kibana/api/{resource}
```

**Important:** All requests require `kbn-xsrf: true` header.

## Status & Features

### Get Status

```bash
GET /kibana/api/status
```

### List Features

```bash
GET /kibana/api/features
```

## Saved Objects

### Find Saved Objects

```bash
GET /kibana/api/saved_objects/_find?type={type}
```

Types: `dashboard`, `visualization`, `index-pattern`, `search`, `lens`, `map`

### Get Saved Object

```bash
GET /kibana/api/saved_objects/{type}/{id}
```

### Create Saved Object

```bash
POST /kibana/api/saved_objects/{type}/{id}
Content-Type: application/json

{"attributes": {"title": "Name"}}
```

### Delete Saved Object

```bash
DELETE /kibana/api/saved_objects/{type}/{id}
```

## Data Views

### List Data Views

```bash
GET /kibana/api/data_views
```

### Get Data View

```bash
GET /kibana/api/data_views/data_view/{id}
```

### Create Data View

```bash
POST /kibana/api/data_views/data_view
Content-Type: application/json

{
  "data_view": {
    "title": "logs-*",
    "timeFieldName": "@timestamp"
  }
}
```

### Delete Data View

```bash
DELETE /kibana/api/data_views/data_view/{id}
```

## Spaces

### List Spaces

```bash
GET /kibana/api/spaces/space
```

### Get Space

```bash
GET /kibana/api/spaces/space/{id}
```

### Create Space

```bash
POST /kibana/api/spaces/space
Content-Type: application/json

{"id": "space-id", "name": "Space Name"}
```

### Delete Space

```bash
DELETE /kibana/api/spaces/space/{id}
```

## Alerting

### Find Alert Rules

```bash
GET /kibana/api/alerting/rules/_find
```

### Get Alert Rule

```bash
GET /kibana/api/alerting/rule/{id}
```

### Enable/Disable Rule

```bash
POST /kibana/api/alerting/rule/{id}/_enable
POST /kibana/api/alerting/rule/{id}/_disable
```

## Connectors

### List Connectors

```bash
GET /kibana/api/actions/connectors
```

### Get Connector

```bash
GET /kibana/api/actions/connector/{id}
```

### Execute Connector

```bash
POST /kibana/api/actions/connector/{id}/_execute
```

## Fleet

### List Agent Policies

```bash
GET /kibana/api/fleet/agent_policies
```

### List Agents

```bash
GET /kibana/api/fleet/agents
```

### List Packages

```bash
GET /kibana/api/fleet/epm/packages
```

## Security

### List Roles

```bash
GET /kibana/api/security/role
```

## Cases

### Find Cases

```bash
GET /kibana/api/cases/_find
```

## Notes

- All requests require `kbn-xsrf: true` header
- Saved object types: dashboard, visualization, index-pattern, search, lens, map
- Data views replace index patterns in newer versions
- Fleet manages Elastic Agents

## Resources

- [Kibana REST API](https://www.elastic.co/docs/api/doc/kibana/)
