# Maturin: Build System for Rust-Python Extensions

#v16_knowledge #maturin #rust #python #build

## Table of Contents

- [Maturin Overview](#maturin-overview)
- [Project Setup](#project-setup)
- [Build Commands](#build-commands)
- [Cargo.toml Configuration](#cargotoml-configuration)
- [pyproject.toml Integration](#pyprojecttoml-integration)
- [Cross-Compilation](#cross-compilation)

## Maturin Overview

Maturin — build backend для создания Python wheels из Rust-кода (PyO3, cffi, uniffi).

```bash
pip install maturin
maturin init --bindings pyo3     # New project
maturin develop                   # Dev build + install in venv
maturin build --release           # Release wheel (.whl)
maturin publish                   # Build + upload to PyPI
```

> «Maturin handles the entire wheel-building pipeline: compiling Rust, linking Python, structuring the wheel, and handling platform tags. It replaces setuptools-rust with zero configuration.» — Maturin Docs

## Project Setup

```
my_rust_module/
├── Cargo.toml
├── pyproject.toml
├── src/
│   └── lib.rs          # Rust source with #[pymodule]
├── python/
│   └── my_module/
│       ├── __init__.py  # Python-level re-exports
│       └── helpers.py   # Pure Python helpers
└── tests/
    └── test_module.py
```

**Minimal `src/lib.rs`:**

```rust
use pyo3::prelude::*;

#[pyfunction]
fn fast_add(a: i64, b: i64) -> i64 {
    a + b
}

#[pymodule]
fn _my_module(m: &Bound<'_, PyModule>) -> PyResult<()> {
    m.add_function(wrap_pyfunction!(fast_add, m)?)?;
    Ok(())
}
```

**`python/my_module/__init__.py`:**

```python
from my_module._my_module import fast_add

__all__ = ["fast_add"]
```

## Build Commands

```bash
# Development (debug, installs in current venv)
maturin develop
maturin develop --release   # Optimized dev build

# Build wheel (does NOT install)
maturin build               # Debug
maturin build --release     # Release optimized

# Build + publish to PyPI
maturin publish --username __token__ --password $PYPI_TOKEN

# Build for specific Python version
maturin build --interpreter python3.11

# Build with specific features
maturin develop --features "simd,parallel"
```

| Command           | Use case      | Output                |
| ----------------- | ------------- | --------------------- |
| `maturin develop` | Iterative dev | Installs in venv      |
| `maturin build`   | CI/packaging  | `target/wheels/*.whl` |
| `maturin publish` | Release       | Uploads to PyPI       |
| `maturin sdist`   | Source dist   | `.tar.gz`             |

## Cargo.toml Configuration

```toml
[package]
name = "openclaw-rust-core"
version = "0.1.0"
edition = "2021"

[lib]
name = "_rust_core"           # Python module name (underscore prefix convention)
crate-type = ["cdylib"]       # Required for Python extension

[dependencies]
pyo3 = { version = "0.22", features = ["extension-module"] }
serde = { version = "1", features = ["derive"] }
serde_json = "1"
tokio = { version = "1", features = ["rt-multi-thread"] }

[profile.release]
opt-level = 3
lto = "fat"                   # Link-Time Optimization
codegen-units = 1             # Better optimization, slower compile
strip = true                  # Strip debug symbols
```

## pyproject.toml Integration

```toml
[build-system]
requires = ["maturin>=1.7,<2"]
build-backend = "maturin"

[project]
name = "openclaw-rust-core"
version = "0.1.0"
description = "Rust-accelerated core for OpenClaw"
requires-python = ">=3.11"
dependencies = []

[tool.maturin]
python-source = "python"       # Directory with Python code
module-name = "my_module._rust_core"  # Dotted module path
features = ["pyo3/extension-module"]
strip = true

# Include extra files in wheel
include = [
    {path = "py.typed", format = "module"},  # PEP 561 type stub marker
]
```

## Cross-Compilation

```bash
# Linux (from macOS/Linux with Docker)
maturin build --release --target x86_64-unknown-linux-gnu

# Windows cross-compile
maturin build --release --target x86_64-pc-windows-msvc

# Multi-platform via zig linker
pip install ziglang
maturin build --release --zig --target aarch64-unknown-linux-gnu

# Build for multiple Python versions
maturin build --release --interpreter python3.11 python3.12 python3.13
```

> «For CI, use `maturin build --release --zig` for hassle-free cross-compilation. Zig bundles its own libc, eliminating the need for platform-specific cross-compilation toolchains.» — Maturin Cross-Compilation Guide

---

_Сгенерировано Knowledge Expansion v16.5_
