# Contributing to OpenClaw Windows

## Prerequisites

- Windows 10 version 1903 (build 19041) or later
- .NET 10 SDK
- Windows App SDK 1.6+
- Visual Studio 2022 17.8+ or VS Code with C# Dev Kit

## Building

```powershell
# Restore and build
dotnet build OpenClawWindows.csproj -c Debug

# Publish MSIX (x64)
dotnet publish OpenClawWindows.csproj -c Release -r win-x64 --self-contained false
```

## Running Tests

```powershell
# All tests (requires Windows)
dotnet test tests/OpenClawWindows.Tests.csproj -c Release

# With coverage
dotnet test tests/OpenClawWindows.Tests.csproj --collect "XPlat Code Coverage"

# PBT with verbose output (dev profile runs more iterations)
$env:FSCHECK_PROFILE = "dev"
dotnet test tests/OpenClawWindows.Tests.csproj --filter "Category=pbt"

# Architecture tests only
dotnet test tests/OpenClawWindows.Tests.csproj --filter "FullyQualifiedName~Architecture"
```

## Mutation Testing

```powershell
scripts/run_mutation_tests.ps1 -OpenReport
```

Requires `dotnet-stryker` global tool. Install with `dotnet tool install --global dotnet-stryker`.

## Architecture

This project uses Hexagonal Architecture (Ports & Adapters):

```
src/
  domain/          # Pure C# — no platform references allowed
  application/     # Use case handlers (MediatR), ports (interfaces)
  infrastructure/  # WinRT/NuGet adapters implementing ports
  presentation/    # WinUI 3 MVVM (ViewModels + Views)
```

Layer violations are enforced by `tests/architecture/LayerDependencyTests.cs` using ArchUnitNET.

## Code Style

- Follow DOC-001..007 documentation rules:
  - `/// <summary>` only on public interfaces and classes where the name is insufficient
  - Never use `<param>` or `<returns>` tags
  - Inline `//` comments explain WHY, not WHAT
- Use `ErrorOr<T>` for all fallible operations
- Use `MediatR` for cross-layer dispatch
- No `ArgumentString` — always use `ArgumentList` for shell execution (TF-001)
- Never reference WinRT namespaces from `domain/` or `application/`

## Pull Request Process

1. Fork the repository and create a branch from `main`
2. Write tests for new domain logic (target: 90% domain coverage)
3. Run `dotnet test` and confirm all tests pass
4. Run the architecture tests and confirm zero violations
5. Update `KNOWN_ISSUES.md` if introducing known limitations
6. Open a PR describing your change

## Known Limitations

See [KNOWN_ISSUES.md](KNOWN_ISSUES.md) for the full list, including:

- **Voice Wake**: Porcupine hotword detection is a stub — Talk Mode STT works
- **Canvas eval**: `canvas.eval` executes arbitrary JS inside WebView2; sandboxing review recommended before production use
