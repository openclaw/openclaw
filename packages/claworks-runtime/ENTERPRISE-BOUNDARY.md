# Enterprise Feature Boundary

This document describes which features are included in the **open source** `@claworks/runtime` and which require **ClaWorks Enterprise** licensing.

---

## Open Source (`@claworks/runtime` — MIT)

Everything in this package is open source. This includes:

| Feature               | Description                                                             |
| --------------------- | ----------------------------------------------------------------------- |
| **EventKernel**       | Event bus, Playbook trigger matching, outbox persistence                |
| **PlaybookEngine**    | YAML Playbook execution, step scheduling, run persistence               |
| **HITL**              | Human-in-the-loop approval gates via IM                                 |
| **ObjectStore**       | Typed document store backed by SQLite                                   |
| **KnowledgeBase**     | Semantic search (in-memory and file-based providers)                    |
| **OntologyEngine**    | YAML-driven schema with foreign key validation                          |
| **Pack system**       | Install, reload, and run community and custom Packs                     |
| **Nexus registry**    | Self-hosted Pack distribution server                                    |
| **A2A**               | Agent-to-Agent delegation (peer-to-peer)                                |
| **Connector manager** | External system subprocess bridge (NDJSON protocol)                     |
| **REST API**          | Full `/v1/*` management API                                             |
| **MCP interface**     | Model Context Protocol server                                           |
| **Basic RBAC**        | Role-based access control stored in ObjectStore as `RbacPolicy` objects |
| **Observability**     | Health checks, Prometheus metrics, decision log, OTEL export            |
| **Scheduler**         | Cron-based Playbook triggers                                            |

---

## Enterprise (ClaWorks Enterprise — separate license)

These capabilities are **not included** in this package. They are delivered as closed-source plugins or SaaS services.

| Feature                   | Why it's enterprise                                                          |
| ------------------------- | ---------------------------------------------------------------------------- |
| **Multi-tenancy**         | Isolated namespaces, per-tenant RBAC, tenant data segregation in ObjectStore |
| **SSO / SAML / OIDC**     | Enterprise identity provider integration, seat-based licensing               |
| **Delegated RBAC chains** | Cross-tenant permission delegation, row-level security                       |
| **Audit log export**      | Tamper-evident event export to SIEM (Splunk, Datadog, etc.)                  |
| **SLA monitoring**        | Playbook SLA breach detection, escalation Playbooks                          |
| **Vector KB providers**   | Weaviate, Qdrant, pgvector integration for large-scale semantic search       |
| **HA / clustering**       | Multi-node EventKernel with shared outbox (Redis, NATS)                      |
| **Admin UI**              | Web-based Studio for Playbook authoring, monitoring, Pack management         |
| **ClaWorks Cloud**        | Fully managed SaaS hosting                                                   |

---

## Extension Points for Enterprise Plugins

The open source runtime exposes stable seams for enterprise plugins to attach without forking:

| Seam                                  | What enterprise plugins use it for                        |
| ------------------------------------- | --------------------------------------------------------- |
| `PackContribution.actionHandlers`     | Custom action implementations per enterprise integration  |
| `PackContribution.intentMappings`     | Custom IM intent routing                                  |
| `EventKernel.subscribe()`             | Hooking into any event for audit, SSO validation          |
| `ConnectorManager`                    | Registering enterprise system connectors                  |
| `ObjectStore` with custom ObjectTypes | Storing tenant configuration, SSO sessions, audit records |
| `RbacGuard.reload()`                  | Dynamically refreshing RBAC from enterprise IAM system    |
| REST API `/v1/packs/install`          | Installing enterprise packs at runtime                    |

---

## Contribution Policy

Contributions that implement open source features are always welcome.

Enterprise feature implementations should **not** be submitted to this repository. Instead:

1. Build them as a separate closed-source `@claworks/enterprise-*` package
2. Use the extension seams listed above
3. Load the package via the Pack system at runtime

Contact [hi@claworks.ai](mailto:hi@claworks.ai) for enterprise licensing and integration support.
