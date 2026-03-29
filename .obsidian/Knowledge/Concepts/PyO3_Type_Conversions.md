# PyO3: Type Conversions Rust ↔ Python

#v16_knowledge #pyo3 #rust #python #types

## Table of Contents

- [Primitive Type Mapping](#primitive-type-mapping)
- [Collection Conversions](#collection-conversions)
- [Custom Type Conversion](#custom-type-conversion)
- [Enum Mapping](#enum-mapping)
- [Optional & None Handling](#optional--none-handling)
- [Bytes & Buffer Protocol](#bytes--buffer-protocol)

## Primitive Type Mapping

| Rust                  | Python      | Notes                             |
| --------------------- | ----------- | --------------------------------- |
| `bool`                | `bool`      | Direct                            |
| `i8/i16/i32/i64/i128` | `int`       | Python int is arbitrary precision |
| `u8/u16/u32/u64/u128` | `int`       | Overflow → OverflowError          |
| `f32/f64`             | `float`     | IEEE 754                          |
| `String` / `&str`     | `str`       | UTF-8 ↔ Unicode                   |
| `Vec<u8>`             | `bytes`     | Zero-copy with `&[u8]`            |
| `Option<T>`           | `T \| None` | Automatic conversion              |
| `()`                  | `None`      | Unit → None                       |

> «When accepting `&str` from Python, PyO3 borrows directly from the Python string object — zero-copy for ASCII strings. For non-ASCII, a temporary UTF-8 buffer is created.» — PyO3 Type Guide

## Collection Conversions

```rust
use pyo3::prelude::*;
use std::collections::HashMap;

#[pyfunction]
fn process_prices(prices: Vec<i64>) -> Vec<i64> {
    // Vec<T> ↔ list[T] — full copy on each boundary crossing
    prices.iter().map(|p| p * 2).collect()
}

#[pyfunction]
fn merge_configs(
    base: HashMap<String, String>,
    override_: HashMap<String, String>,
) -> HashMap<String, String> {
    // HashMap<K,V> ↔ dict[K,V]
    let mut result = base;
    result.extend(override_);
    result
}

#[pyfunction]
fn unique_items(items: Vec<String>) -> Vec<String> {
    // HashSet<T> ↔ set[T]
    use std::collections::HashSet;
    let set: HashSet<_> = items.into_iter().collect();
    set.into_iter().collect()
}
```

**Стоимость конвертации:**

| Type                 | Python → Rust   | Rust → Python   |
| -------------------- | --------------- | --------------- |
| `i64`                | O(1) — unbox    | O(1) — box      |
| `String`             | O(n) — copy     | O(n) — copy     |
| `Vec<i64>`           | O(n) — copy all | O(n) — copy all |
| `HashMap<K,V>`       | O(n) — copy all | O(n) — copy all |
| `&[u8]` from `bytes` | O(1) — borrow   | N/A             |

## Custom Type Conversion

```rust
use pyo3::prelude::*;
use pyo3::types::PyDict;

#[derive(Clone)]
struct DmarketItem {
    asset_id: String,
    title: String,
    price_cents: i64,
    float_value: Option<f64>,
}

// Rust → Python: convert to dict
impl IntoPyObject<'_> for DmarketItem {
    type Target = PyDict;
    type Output = Bound<'_, PyDict>;
    type Error = PyErr;

    fn into_pyobject(self, py: Python<'_>) -> Result<Self::Output, Self::Error> {
        let dict = PyDict::new(py);
        dict.set_item("asset_id", self.asset_id)?;
        dict.set_item("title", self.title)?;
        dict.set_item("price_cents", self.price_cents)?;
        dict.set_item("float_value", self.float_value)?;
        Ok(dict)
    }
}

// Python → Rust: convert from dict
impl<'py> FromPyObject<'py> for DmarketItem {
    fn extract_bound(ob: &Bound<'py, PyAny>) -> PyResult<Self> {
        let dict = ob.downcast::<PyDict>()?;
        Ok(DmarketItem {
            asset_id: dict.get_item("asset_id")?.unwrap().extract()?,
            title: dict.get_item("title")?.unwrap().extract()?,
            price_cents: dict.get_item("price_cents")?.unwrap().extract()?,
            float_value: dict.get_item("float_value")?.and_then(|v| v.extract().ok()),
        })
    }
}
```

## Enum Mapping

```rust
use pyo3::prelude::*;

#[pyclass(eq, eq_int)]
#[derive(Clone, PartialEq)]
enum OrderType {
    Buy = 0,
    Sell = 1,
    Cancel = 2,
}

#[pyclass(eq, eq_int)]
#[derive(Clone, PartialEq)]
enum Exterior {
    FactoryNew = 0,
    MinimalWear = 1,
    FieldTested = 2,
    WellWorn = 3,
    BattleScarred = 4,
}

// String enum (not natively supported — use manual conversion)
#[pyfunction]
fn parse_exterior(s: &str) -> PyResult<Exterior> {
    match s {
        "factory-new" => Ok(Exterior::FactoryNew),
        "minimal-wear" => Ok(Exterior::MinimalWear),
        "field-tested" => Ok(Exterior::FieldTested),
        "well-worn" => Ok(Exterior::WellWorn),
        "battle-scarred" => Ok(Exterior::BattleScarred),
        _ => Err(pyo3::exceptions::PyValueError::new_err(
            format!("Unknown exterior: {s}")
        )),
    }
}
```

## Optional & None Handling

```rust
#[pyfunction]
fn find_best_price(
    prices: Vec<i64>,
    min_price: Option<i64>,   // Python: None → Rust: None
    max_price: Option<i64>,
) -> Option<i64> {             // Rust: None → Python: None
    let filtered: Vec<_> = prices.into_iter()
        .filter(|p| min_price.map_or(true, |min| *p >= min))
        .filter(|p| max_price.map_or(true, |max| *p <= max))
        .collect();

    filtered.into_iter().min()
}
```

## Bytes & Buffer Protocol

```rust
use pyo3::prelude::*;
use pyo3::types::PyBytes;

#[pyfunction]
fn hash_payload<'py>(py: Python<'py>, data: &[u8]) -> Bound<'py, PyBytes> {
    // &[u8] borrows from Python bytes — zero-copy input
    use sha2::{Sha256, Digest};
    let mut hasher = Sha256::new();
    hasher.update(data);
    let result = hasher.finalize();

    // PyBytes::new copies into Python heap — necessary for ownership
    PyBytes::new(py, &result)
}

// For large data: use buffer protocol
#[pyclass]
struct LargeBuffer {
    data: Vec<u8>,
}

#[pymethods]
impl LargeBuffer {
    #[new]
    fn new(size: usize) -> Self {
        LargeBuffer { data: vec![0u8; size] }
    }

    unsafe fn __getbuffer__(
        slf: Bound<'_, Self>,
        view: *mut pyo3::ffi::Py_buffer,
        flags: std::os::raw::c_int,
    ) -> PyResult<()> {
        // Expose Rust buffer directly to Python — true zero-copy
        pyo3::buffer::PyBuffer::fill_info(
            view, flags, &slf.borrow().data, true,
        )
    }
}
```

---

_Сгенерировано Knowledge Expansion v16.5_
