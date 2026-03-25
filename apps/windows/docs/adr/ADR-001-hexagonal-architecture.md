# ADR-001: Hexagonal Modular Monolith Architecture

## Status
Accepted

## Context

OpenClaw Windows must implement 25 bounded contexts covering camera, canvas, exec approvals, gateway, voice, and UI. The architecture must enforce clear boundaries between domain logic and platform-specific WinRT adapters, mirror the macOS Swift separation of concerns, and remain testable without real hardware (camera, microphone, screen capture).

## Decision

Adopt **Hexagonal Architecture (Ports & Adapters)** as a modular monolith within a single MSIX package.

- **Domain layer** — pure C# with no platform dependencies
- **Application layer** — use case handlers (MediatR), ports (interfaces), behaviors
- **Infrastructure layer** — 18 WinRT/NuGet adapters implementing the ports
- **Presentation layer** — WinUI 3 MVVM with CommunityToolkit.Mvvm

The implementation resides in a single `.csproj` (monolith) rather than 5 separate projects. This reduces MSBuild complexity while maintaining the logical layer separation via namespaces and architecture tests.

## Consequences

### Positive
- Domain and application layers are fully testable with NSubstitute mocks
- WinRT adapters are isolated — can be replaced without touching business logic
- Layer violations are caught by ArchUnitNET tests in CI
- Single MSIX package simplifies deployment

### Negative
- Monolith .csproj means all code compiles together — longer build times as the codebase grows
- Domain layer must be explicitly guarded from WinRT references (via architecture tests)

### Risks
- If the codebase grows significantly, splitting into 5 separate projects (as originally planned in Phase 2) may be warranted

## Traceability
- Phase: 0 (ADR-001 in Phase 0 Step 3)
- Related: QAS-001, QAS-003, R-002, R-006
