---
name: ddd-cola-java
description: Java COLA Architecture Guide - Alibaba's Clean Object-Oriented and Layered Architecture framework. For DDD layered architecture design, code structure standards, and application architecture refactoring in Java/Spring Boot projects. Triggers on COLA, Java DDD, Spring Boot architecture, layered architecture, clean architecture, hexagonal architecture, onion architecture, code layering, module organization, Gateway pattern, Repository pattern, CQRS, architecture refactoring, separation of concerns, Maven multi-module. Automatically applies COLA directory structure and naming conventions when creating Java files.
homepage: https://github.com/alibaba/COLA
metadata: {"openclaw":{"emoji":"☕"}}
---

# Java COLA Architecture

COLA = Clean Object-Oriented and Layered Architecture

## Layered Architecture

```
                        ┌─────────────────────────────────────┐
  Driving Adapter:      │  Browser  │  Scheduler │  MQ        │
                        └─────────────────────────────────────┘
                                         ↓
  VO ←─────────────── ┌─────────────────────────────────────┐
  (View Object)       │            Adapter Layer             │
                      │  controller │ scheduler │ consumer   │
                      └─────────────────────────────────────┘
                                         ↓
  DTO ←────────────── ┌─────────────────────────────────────┐
  (Data Transfer      │              App Layer               │
   Object)            │       service  │  executor           │
                      └─────────────────────────────────────┘
                                         ↓
  Entity ←─────────── ┌─────────────────────────────────────┐
                      │            Domain Layer              │
                      │   gateway │ model │ ability          │
                      └─────────────────────────────────────┘
                                         ↑
  DO ←─────────────── ┌─────────────────────────────────────┐
  (Data Object)       │        Infrastructure Layer          │
                      │  gatewayImpl │ mapper │ config       │
                      └─────────────────────────────────────┘
                                         ↓
  Driven Adapter:     │    DB    │   Search   │    RPC      │
```

### Dependency Direction

```
Adapter → App → Domain ← Infrastructure
              ↘      ↙
               Client
```

| Layer | Responsibility | Implementation |
|-------|----------------|----------------|
| **Adapter** | Receive external requests | Controller, Scheduler, Consumer |
| **App** | Use case orchestration | ServiceImpl, CmdExe, QryExe |
| **Domain** | Core business logic | Entity, ValueObject, Gateway, Ability |
| **Infrastructure** | Technical implementation | GatewayImpl, Mapper, Config |
| **Client** | DTO definitions | Command, Query, CO, ServiceI |

## Directory Structure

```
project-name/
├── project-adapter/          # Controller
│   └── com/company/project/web/
├── project-app/              # Service implementation
│   └── com/company/project/
│       ├── command/          # *CmdExe.java
│       │   └── query/        # *QryExe.java
│       └── service/          # *ServiceImpl.java
├── project-client/           # API definitions
│   └── com/company/project/
│       ├── api/              # *ServiceI.java
│       └── dto/
│           ├── command/      # *Cmd.java
│           ├── query/        # *Qry.java
│           └── clientobject/ # *CO.java
├── project-domain/           # Domain layer
│   └── com/company/project/domain/
│       ├── {aggregate}/      # Entity, ValueObject
│       └── gateway/          # *Gateway.java
├── project-infrastructure/   # Infrastructure
│   └── com/company/project/
│       ├── gatewayimpl/      # *GatewayImpl.java
│       └── convertor/        # *Convertor.java
└── start/                    # Startup module
```

## Naming Conventions

| Type | Suffix | Location |
|------|--------|----------|
| Command | `Cmd` | client/dto/command |
| Query | `Qry` | client/dto/query |
| Command Executor | `CmdExe` | app/command |
| Query Executor | `QryExe` | app/command/query |
| Client Object | `CO` | client/dto/clientobject |
| Data Object | `DO` | infrastructure |
| Service Interface | `ServiceI` | client/api |
| Service Implementation | `ServiceImpl` | app/service |
| Gateway Interface | `Gateway` | domain/gateway |
| Gateway Implementation | `GatewayImpl` | infrastructure/gatewayimpl |
| Converter | `Convertor` | infrastructure/convertor |

## Quick Project Setup

COLA provides two Archetypes:

### cola-archetype-web (Web Application)

For web applications with Adapter and backend services together:

```bash
mvn archetype:generate \
    -DgroupId=com.company.project \
    -DartifactId=my-web-app \
    -Dversion=1.0.0-SNAPSHOT \
    -Dpackage=com.company.project \
    -DarchetypeArtifactId=cola-framework-archetype-web \
    -DarchetypeGroupId=com.alibaba.cola \
    -DarchetypeVersion=5.0.0
```

Generated structure:
```
my-web-app/
├── my-web-app-adapter/      # Controller, schedulers, message listeners
├── my-web-app-app/          # Service implementation, executors
├── my-web-app-client/       # API interfaces, DTOs
├── my-web-app-domain/       # Domain models, Gateway interfaces
├── my-web-app-infrastructure/  # Gateway implementations, Mappers
└── start/                   # Startup module
```

### cola-archetype-service (Pure Backend Service)

For pure backend services (no web layer):

```bash
mvn archetype:generate \
    -DgroupId=com.company.project \
    -DartifactId=my-service \
    -Dversion=1.0.0-SNAPSHOT \
    -Dpackage=com.company.project \
    -DarchetypeArtifactId=cola-framework-archetype-service \
    -DarchetypeGroupId=com.alibaba.cola \
    -DarchetypeVersion=5.0.0
```

Generated structure:
```
my-service/
├── my-service-app/          # Service implementation, executors
├── my-service-client/       # API interfaces, DTOs (for other services to call)
├── my-service-domain/       # Domain models, Gateway interfaces
├── my-service-infrastructure/  # Gateway implementations, Mappers
└── start/                   # Startup module
```

## COLA Components

| Component | Function |
|-----------|----------|
| `cola-component-dto` | Response, Command, Query, PageResponse |
| `cola-component-exception` | BizException, SysException, ErrorCode |
| `cola-component-catchlog-starter` | @CatchAndLog exception catching and logging |
| `cola-component-extension-starter` | Extension point mechanism (multi-business support) |
| `cola-component-statemachine` | State machine (order flow, etc.) |
| `cola-component-domain-starter` | Spring-managed domain entities |
| `cola-component-ruleengine` | Rule engine |
| `cola-component-test-container` | Test container |

## Code Templates

For detailed code examples, see:
- **DTO and Response**: [references/dto.md](references/dto.md)
- **Service and Executors**: [references/service.md](references/service.md)
- **Gateway Pattern**: [references/gateway.md](references/gateway.md)
- **COLA Components**: [references/components.md](references/components.md)
- **Complete Example**: [references/example.md](references/example.md)

## Refactoring Checklist

1. Create adapter/app/client/domain/infrastructure/start modules
2. Configure Maven dependency relationships
3. Define Command, Query, CO classes
4. Create CmdExe/QryExe and ServiceImpl
5. Define Gateway interfaces and GatewayImpl
6. Create Convertor converters
7. Migrate Controllers to adapter/web
