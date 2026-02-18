# Database Source Configuration Reference

## PostgreSQL

```yaml
sources:
  my-pg:
    kind: postgres
    host: localhost
    port: 5432
    database: mydb
    user: postgres
    password: ${PG_PASSWORD}
    # Optional
    sslmode: disable # disable|require|verify-ca|verify-full
    pool_max_conns: 10
```

## MySQL

```yaml
sources:
  my-mysql:
    kind: mysql
    host: localhost
    port: 3306
    database: mydb
    user: root
    password: ${MYSQL_PASSWORD}
```

## SQLite

```yaml
sources:
  local:
    kind: sqlite
    database: ./path/to/data.db
```

## BigQuery

```yaml
sources:
  bq:
    kind: bigquery
    project: my-gcp-project
    dataset: my_dataset
    # Uses Application Default Credentials (ADC)
```

## Spanner

```yaml
sources:
  spanner:
    kind: spanner
    project: my-gcp-project
    instance: my-instance
    database: my-database
```

## Cloud SQL (with IAM auth)

```yaml
sources:
  cloudsql-pg:
    kind: cloud-sql-postgres
    project: my-gcp-project
    region: us-central1
    instance: my-instance
    database: mydb
    user: my-user
    # Uses IAM authentication by default

  cloudsql-mysql:
    kind: cloud-sql-mysql
    project: my-gcp-project
    region: us-central1
    instance: my-instance
    database: mydb
    user: my-user
```

## MongoDB

```yaml
sources:
  mongo:
    kind: mongodb
    uri: mongodb://localhost:27017
    database: mydb
```

## Redis

```yaml
sources:
  redis:
    kind: redis
    address: localhost:6379
    password: ${REDIS_PASSWORD}
    db: 0
```

## ClickHouse

```yaml
sources:
  ch:
    kind: clickhouse
    host: localhost
    port: 9000
    database: default
    user: default
    password: ${CH_PASSWORD}
```

## Neo4j

```yaml
sources:
  neo:
    kind: neo4j
    uri: bolt://localhost:7687
    user: neo4j
    password: ${NEO4J_PASSWORD}
```

## Snowflake

```yaml
sources:
  snow:
    kind: snowflake
    account: my-account
    user: my-user
    password: ${SF_PASSWORD}
    database: MY_DB
    schema: PUBLIC
    warehouse: MY_WH
```

## Elasticsearch

```yaml
sources:
  es:
    kind: elasticsearch
    addresses:
      - http://localhost:9200
    username: elastic
    password: ${ES_PASSWORD}
```

## Tool Definition Patterns

### Basic SQL Tool

```yaml
tools:
  get-user:
    kind: postgres-sql
    source: my-pg
    description: "Get user by ID"
    statement: "SELECT * FROM users WHERE id = $1"
    parameters:
      - name: user_id
        type: integer
        description: "The user ID"
```

### Tool with Auth

```yaml
tools:
  sensitive-query:
    kind: postgres-sql
    source: my-pg
    description: "Query with auth"
    statement: "SELECT * FROM orders WHERE user_id = @user_id"
    authRequired:
      - google # Requires Google OAuth
    parameters:
      - name: user_id
        type: string
        description: "Authenticated user ID"
        authSources:
          - name: google
            field: sub # Maps to OAuth subject claim
```

### Toolsets (Group Tools)

```yaml
toolsets:
  user-management:
    - get-user
    - list-users
    - create-user

  analytics:
    - run-report
    - get-metrics
```
