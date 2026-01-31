---
name: ddd-cola-python
description: Python COLA Architecture Guide - Adapting Alibaba's Clean Object-Oriented and Layered Architecture to Python/Flask/FastAPI projects. For Python backend DDD layered architecture design, code structure standards, and application architecture refactoring. Triggers on Python DDD, Flask architecture, FastAPI architecture, Python layered architecture, clean architecture, hexagonal architecture, onion architecture, COLA, code layering, module organization, Gateway pattern, Repository pattern, CQRS, architecture refactoring, separation of concerns. Automatically applies COLA directory structure and naming conventions when creating Python files.
homepage: https://github.com/alibaba/COLA
metadata: {"openclaw":{"emoji":"🐍"}}
---

# Python COLA Architecture

COLA = Clean Object-Oriented and Layered Architecture

## Layered Architecture

```
Adapter → Application → Domain ← Infrastructure
                    ↘      ↙
                     Client
```

| Layer | Responsibility | Python Implementation |
|-------|----------------|----------------------|
| **Adapter** | Receive external requests | Flask Blueprint / FastAPI Router |
| **Application** | Use case orchestration | Service, CmdExe, QryExe |
| **Domain** | Core business logic | Entity, ValueObject, Gateway interface |
| **Infrastructure** | Technical implementation | Gateway implementation, SQLAlchemy |
| **Client** | DTO definitions | Command, Query, CO |

## Directory Structure

```
project/
├── adapter/routes/           # Flask Blueprint
├── application/
│   ├── command/              # *_cmd_exe.py
│   ├── query/                # *_qry_exe.py
│   └── service/              # *_service.py
├── client/
│   ├── api/                  # *_service_i.py (Protocol)
│   └── dto/
│       ├── command/          # *_cmd.py
│       ├── query/            # *_qry.py
│       └── co/               # *_co.py
├── domain/
│   ├── {aggregate}/          # entity.py, value_object.py
│   └── gateway/              # *_gateway.py (ABC)
├── infrastructure/
│   ├── gateway_impl/         # *_gateway_impl.py
│   ├── convertor/            # *_convertor.py
│   └── repository/           # models.py
└── app.py
```

## Naming Conventions

| Type | Suffix | Location |
|------|--------|----------|
| Command | `_cmd` | client/dto/command |
| Query | `_qry` | client/dto/query |
| Command Executor | `_cmd_exe` | application/command |
| Query Executor | `_qry_exe` | application/query |
| Client Object | `_co` | client/dto/co |
| Service Interface | `_service_i` | client/api |
| Service Implementation | `_service` | application/service |
| Gateway Interface | `_gateway` | domain/gateway |
| Gateway Implementation | `_gateway_impl` | infrastructure/gateway_impl |
| Converter | `_convertor` | infrastructure/convertor |

## Core Principles

1. **Domain layer has no dependencies** (pure Python, no framework dependencies)
2. **Infrastructure implements Gateway interfaces defined in Domain**
3. **Client layer is depended on by all layers (DTO definitions)**

## Code Templates

For detailed code examples, see:
- **Response and DTO**: [references/dto.md](references/dto.md)
- **Service and Executors**: [references/service.md](references/service.md)
- **Gateway Pattern**: [references/gateway.md](references/gateway.md)
- **Complete Example**: [references/example.md](references/example.md)

## Refactoring Checklist

1. Create adapter/application/client/domain/infrastructure packages
2. Define Response, Command, Query, CO classes
3. Create CmdExe/QryExe executors and Service
4. Define Gateway interfaces (ABC) and implementations
5. Create Convertor converters
6. Migrate routes to adapter/routes

## Python vs Java Comparison

| Java | Python |
|------|--------|
| `interface` | `Protocol` or `ABC` |
| `@Autowired` | Constructor injection |
| `@CatchAndLog` | `@catch_and_log` decorator |
| `@Data` | `@dataclass` |
| `@RestController` | Flask Blueprint / FastAPI Router |
