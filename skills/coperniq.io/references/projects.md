# Project Endpoints

Base URL: `https://api.coperniq.io/v1`
Auth header: `x-api-key: $COPERNIQ_API_KEY`

---

## Project Schema

Fields returned on all project responses:

| Field          | Type          | Description                                   |
| -------------- | ------------- | --------------------------------------------- |
| `id`           | integer       | Unique identifier                             |
| `number`       | integer       | Human-readable record number                  |
| `title`        | string        | Project name                                  |
| `description`  | string\|null  | Project description                           |
| `address`      | string        | Location/address                              |
| `status`       | string        | `ACTIVE`, `ON_HOLD`, `CANCELLED`, `COMPLETED` |
| `isActive`     | boolean       | Whether record is active                      |
| `primaryEmail` | string\|null  | Primary contact email                         |
| `primaryPhone` | string\|null  | Primary contact phone                         |
| `trades`       | string[]      | Trade types (e.g. `["Solar"]`)                |
| `value`        | number\|null  | Project dollar value                          |
| `size`         | number\|null  | Project size                                  |
| `clientId`     | integer\|null | Associated client ID                          |
| `workflowId`   | integer\|null | Associated workflow ID                        |
| `workflowName` | string        | Name of associated workflow                   |
| `custom`       | object        | Custom fields (key/value)                     |
| `stage`        | object\|null  | Current stage — Workflows 1.0 only            |
| `phase`        | object\|null  | Current phase — Workflows 2.0 only            |
| `createdAt`    | datetime      | ISO 8601 creation timestamp                   |
| `updatedAt`    | datetime      | ISO 8601 last-updated timestamp               |

**Note:** `stage` is present only for Workflows 1.0 projects. `phase` replaces it for Workflows 2.0. `GET /projects/{id}` also returns `phaseInstances[]` (ordered list of all phase instances with `id`, `name`, `status`, `startedAt`, `completedAt`).

---

## List Projects

`GET /v1/projects`

Returns a paginated list of projects.

**Query parameters:**

| Param                        | Required | Default | Description                |
| ---------------------------- | -------- | ------- | -------------------------- |
| `page_size`                  | no       | 20      | Items per page (max 100)   |
| `page`                       | no       | 1       | Page number (1-based)      |
| `order_by`                   | no       | asc     | `asc` or `desc`            |
| `updated_after`              | no       | —       | ISO 8601 datetime filter   |
| `updated_before`             | no       | —       | ISO 8601 datetime filter   |
| `q`                          | no       | —       | Full-text search query     |
| `title`                      | no       | —       | Filter by title            |
| `address`                    | no       | —       | Filter by address          |
| `primaryName`                | no       | —       | Filter by contact name     |
| `primaryPhone`               | no       | —       | Filter by contact phone    |
| `primaryEmail`               | no       | —       | Filter by contact email    |
| `include_virtual_properties` | no       | false   | Include virtual properties |

**Example:**

```bash
curl -s "https://api.coperniq.io/v1/projects?page_size=50&q=solar" \
  -H "x-api-key: $COPERNIQ_API_KEY"
```

---

## Get Project

`GET /v1/projects/{projectId}`

Returns a single project by ID, including all `phaseInstances`.

**Path params:** `projectId` (integer)

**Query params:** `include_virtual_properties` (boolean, default false)

**Example:**

```bash
curl -s "https://api.coperniq.io/v1/projects/12345" \
  -H "x-api-key: $COPERNIQ_API_KEY"
```

---

## Search Projects

`GET /v1/projects/search`

Filter projects using up to two property conditions.

**Query parameters:**

| Param       | Required | Description                         |
| ----------- | -------- | ----------------------------------- |
| `prop1`     | yes      | Field name (standard or custom key) |
| `op1`       | yes      | Operator (see below)                |
| `value1`    | yes      | Filter value                        |
| `prop2`     | no       | Second field name                   |
| `op2`       | no       | Operator for prop2                  |
| `value2`    | no       | Value for prop2                     |
| `logic`     | no       | `and` (default) or `or`             |
| `page_size` | no       | Max 100, default 20                 |
| `page`      | no       | 1-based                             |
| `order_by`  | no       | `asc` or `desc`                     |

**Operators:** `eq`, `neq`, `gt`, `gte`, `lt`, `lte`, `contains`, `in`, `nin`, `between`, `exists`

**Value formats:**

- `in`/`nin`: CSV (`ACTIVE,ON_HOLD`) or JSON array (`["ACTIVE","ON_HOLD"]`)
- `between`: `from,to` — e.g. `2025-01-01,2025-12-31` or `10,100`
- Dates: ISO 8601

**Common `prop1` values for standard fields:** `status`, `title`, `address`, `city`, `state`, `type`, `primaryEmail`, `primaryPhone`, `trades`, `value`, `size`, `createdAt`, `updatedAt`

**Custom properties:** use the property `key` from company settings (e.g. `legacy_tool_project_id`)

**Examples:**

```bash
# Active projects only
curl -s "https://api.coperniq.io/v1/projects/search?prop1=status&op1=eq&value1=ACTIVE" \
  -H "x-api-key: $COPERNIQ_API_KEY"

# Active projects in Austin
curl -s "https://api.coperniq.io/v1/projects/search?prop1=status&op1=eq&value1=ACTIVE&logic=and&prop2=city&op2=eq&value2=Austin" \
  -H "x-api-key: $COPERNIQ_API_KEY"

# Title contains "Solar"
curl -s "https://api.coperniq.io/v1/projects/search?prop1=title&op1=contains&value1=Solar" \
  -H "x-api-key: $COPERNIQ_API_KEY"

# Custom property lookup
curl -s "https://api.coperniq.io/v1/projects/search?prop1=legacy_tool_project_id&op1=eq&value1=1234" \
  -H "x-api-key: $COPERNIQ_API_KEY"

# Status in a set
curl -s "https://api.coperniq.io/v1/projects/search?prop1=status&op1=in&value1=ACTIVE,ON_HOLD" \
  -H "x-api-key: $COPERNIQ_API_KEY"
```

---

## Create Project

`POST /v1/projects`

**Required body fields:** `title` (string), `address` (array with one string)

**Optional body fields:**

| Field          | Type         | Description                                          |
| -------------- | ------------ | ---------------------------------------------------- |
| `trades`       | string[]     | Trade types, defaults to `["Solar"]`                 |
| `description`  | string\|null | Description                                          |
| `status`       | string       | `ACTIVE`, `ON_HOLD`, `CANCELLED`, `COMPLETED`        |
| `value`        | number       | Project value                                        |
| `size`         | number       | Project size                                         |
| `clientId`     | string       | ID of associated client                              |
| `workflowId`   | string       | ID of associated workflow                            |
| `primaryEmail` | string       | Primary contact email (auto-creates/matches contact) |
| `primaryPhone` | string       | Primary contact phone (auto-creates/matches contact) |
| `contacts`     | integer[]    | Contact IDs (must pre-exist via POST /contacts)      |
| `custom`       | object       | Custom fields key/value                              |

**Query params (optional):**

- `match_by`: `title` (default), `primaryEmail`, `primaryPhone`, `address` — field to match existing records
- `match_found_strategy`: `skip` (default), `replace`, `enrich` — what to do if a match exists
- `allow_new_options`: boolean — allow creating new dropdown options

**Example:**

```bash
curl -s -X POST "https://api.coperniq.io/v1/projects" \
  -H "x-api-key: $COPERNIQ_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Smith Residence Solar",
    "address": ["123 Main St, Austin, TX 78701"],
    "trades": ["Solar"],
    "primaryEmail": "smith@example.com",
    "status": "ACTIVE"
  }'
```

**With custom fields:**

```bash
curl -s -X POST "https://api.coperniq.io/v1/projects" \
  -H "x-api-key: $COPERNIQ_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Jones Commercial HVAC",
    "address": ["456 Oak Ave, Dallas, TX 75201"],
    "trades": ["HVAC"],
    "clientId": "789",
    "custom": {"job_number": "JOB-2025-042"}
  }'
```
