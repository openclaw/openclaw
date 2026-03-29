# PyO3: Rust↔Python FFI Fundamentals

#v16_knowledge #pyo3 #rust #python #ffi

## Table of Contents

- [What is PyO3](#what-is-pyo3)
- [#\[pyfunction\] — Exporting Rust Functions](#pyfunction)
- [#\[pyclass\] — Exporting Rust Structs](#pyclass)
- [#\[pymethods\] — Adding Methods](#pymethods)
- [Error Handling Across Boundary](#error-handling-across-boundary)
- [GIL Management](#gil-management)

## What is PyO3

PyO3 — Rust framework для создания нативных Python-модулей (C-extension replacement).

```toml
# Cargo.toml
[lib]
name = "my_module"
crate-type = ["cdylib"]

[dependencies]
pyo3 = { version = "0.22", features = ["extension-module"] }
```

```rust
use pyo3::prelude::*;

#[pymodule]
fn my_module(m: &Bound<'_, PyModule>) -> PyResult<()> {
    m.add_function(wrap_pyfunction!(fast_hash, m)?)?;
    m.add_class::<PriceEngine>()?;
    Ok(())
}
```

> «PyO3 generates the CPython C-API boilerplate at compile time. The result is a `.so`/`.pyd` that Python imports like any C extension — no runtime overhead beyond the function call boundary.» — PyO3 User Guide

## #[pyfunction]

```rust
/// Compute HMAC-SHA256 signature for Dmarket API
#[pyfunction]
fn dmarket_sign(secret_key: &str, message: &str) -> PyResult<String> {
    use hmac::{Hmac, Mac};
    use sha2::Sha256;

    let mut mac = Hmac::<Sha256>::new_from_slice(secret_key.as_bytes())
        .map_err(|e| PyErr::new::<pyo3::exceptions::PyValueError, _>(
            format!("Invalid key: {e}")
        ))?;

    mac.update(message.as_bytes());
    let result = mac.finalize();
    Ok(hex::encode(result.into_bytes()))
}
```

**Python usage:**

```python
import my_module
sig = my_module.dmarket_sign("secret", "GET/marketplace-api/v1/items")
```

## #[pyclass]

```rust
#[pyclass]
struct PriceEngine {
    prices: Vec<i64>,
    window_size: usize,
}

#[pymethods]
impl PriceEngine {
    #[new]
    fn new(window_size: usize) -> Self {
        PriceEngine {
            prices: Vec::new(),
            window_size,
        }
    }

    fn add_price(&mut self, price: i64) {
        self.prices.push(price);
        if self.prices.len() > self.window_size {
            self.prices.remove(0);
        }
    }

    fn moving_average(&self) -> f64 {
        if self.prices.is_empty() {
            return 0.0;
        }
        self.prices.iter().sum::<i64>() as f64 / self.prices.len() as f64
    }

    fn __repr__(&self) -> String {
        format!("PriceEngine(window={}, count={})", self.window_size, self.prices.len())
    }
}
```

## #[pymethods]

```rust
#[pymethods]
impl PriceEngine {
    // Class method (like @classmethod)
    #[classmethod]
    fn from_list(_cls: &Bound<'_, PyType>, prices: Vec<i64>) -> Self {
        let window = prices.len();
        PriceEngine { prices, window_size: window }
    }

    // Static method (like @staticmethod)
    #[staticmethod]
    fn spread(buy: i64, sell: i64) -> f64 {
        (sell - buy) as f64 / sell as f64 * 100.0
    }

    // Property getter
    #[getter]
    fn count(&self) -> usize {
        self.prices.len()
    }

    // Property setter
    #[setter]
    fn set_window_size(&mut self, size: usize) {
        self.window_size = size;
    }
}
```

## Error Handling Across Boundary

```rust
use pyo3::exceptions::{PyValueError, PyRuntimeError, PyIOError};
use thiserror::Error;

#[derive(Error, Debug)]
enum EngineError {
    #[error("Price out of range: {0}")]
    PriceRange(i64),
    #[error("Network error: {0}")]
    Network(String),
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),
}

// Convert Rust errors to Python exceptions
impl From<EngineError> for PyErr {
    fn from(err: EngineError) -> PyErr {
        match err {
            EngineError::PriceRange(p) => PyValueError::new_err(format!("Price {p} out of range")),
            EngineError::Network(msg) => PyRuntimeError::new_err(msg),
            EngineError::Io(e) => PyIOError::new_err(e.to_string()),
        }
    }
}
```

## GIL Management

```rust
use pyo3::prelude::*;

#[pyfunction]
fn cpu_heavy_task(py: Python<'_>, data: Vec<f64>) -> PyResult<f64> {
    // Release GIL for CPU-bound work
    let result = py.allow_threads(|| {
        data.iter()
            .map(|x| x.sin() * x.cos())
            .sum::<f64>()
    });
    Ok(result)
}
```

> «Always release the GIL with `py.allow_threads()` for CPU-bound operations. This lets other Python threads run while Rust computes. For I/O bound work, the GIL is usually released automatically by the OS.» — PyO3 Performance Guide

**GIL Rules:**
| Operation | GIL | Reason |
|---|---|---|
| Pure Rust computation | Release (`allow_threads`) | Let Python threads run |
| Access Python objects | Hold | Safety requirement |
| Call Python functions | Hold | CPython requirement |
| Rust mutex/atomics | Release | No Python interaction |

---

_Сгенерировано Knowledge Expansion v16.5_
