//! Advanced async processing with napi-rs for OpenClaw Rust plugin
//!
//! This module demonstrates advanced napi-rs features following official best practices

use napi::bindgen_prelude::*;
use napi_derive::napi;
use std::sync::Arc;

/// String processing task for async execution
pub struct StringProcessingTask {
    input: String,
}

impl Task for StringProcessingTask {
    type Output = String;
    type JsValue = String;

    fn compute(&mut self) -> Result<Self::Output> {
        // Simulate expensive operation
        use std::thread::sleep;
        use std::time::Duration;

        sleep(Duration::from_millis(100));

        // Process string
        Ok(self.input.to_uppercase())
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }

    fn reject(&mut self, _env: Env, err: Error) -> Result<Self::JsValue> {
        Err(err)
    }
}

/// Async task with AbortSignal support
#[napi]
pub fn cancellable_operation(
    input: String,
    signal: Option<AbortSignal>,
) -> AsyncTask<StringProcessingTask> {
    AsyncTask::with_optional_signal(StringProcessingTask { input }, signal)
}

/// Complex data task for async processing
pub struct ComplexDataTask {
    data: Vec<u8>,
    oversized: bool, // Flag to indicate input was too large
}

impl Task for ComplexDataTask {
    type Output = Vec<u8>;
    type JsValue = Buffer;

    fn compute(&mut self) -> Result<Self::Output> {
        // Return error if input was oversized
        if self.oversized {
            return Err(Error::new(Status::InvalidArg, "Input too large (max 10MB)"));
        }

        // Process data with overflow protection
        let processed: Vec<u8> = self.data.iter().map(|b| b.wrapping_add(1)).collect();
        Ok(processed)
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output.into())
    }

    fn reject(&mut self, _env: Env, err: Error) -> Result<Self::JsValue> {
        // Propagate the error properly
        Err(err)
    }
}

#[napi]
pub fn complex_data_async(data: Vec<u8>) -> AsyncTask<ComplexDataTask> {
    const MAX_SIZE: usize = 10_000_000; // 10MB

    let oversized = data.len() > MAX_SIZE;

    AsyncTask::new(ComplexDataTask {
        data: if oversized { vec![] } else { data },
        oversized,
    })
}

/// Buffer processor for async operations
pub struct BufferProcessor {
    buffer: Buffer,
}

impl Task for BufferProcessor {
    type Output = Buffer;
    type JsValue = Buffer;

    fn compute(&mut self) -> Result<Self::Output> {
        // Process buffer asynchronously
        let data: Vec<u8> = self.buffer.clone().into();
        let reversed: Vec<u8> = data.into_iter().rev().collect();
        Ok(reversed.into())
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}

#[napi]
pub fn process_buffer_async(buffer: Buffer) -> AsyncTask<BufferProcessor> {
    AsyncTask::new(BufferProcessor { buffer })
}

// /// Class-based streaming processor with custom lifecycle
// #[napi(custom_finalize)]
// pub struct StreamingProcessor {
//     buffer: Vec<u8>,
//     capacity: usize,
// }
//
// #[napi]
// impl StreamingProcessor {
//     #[napi(constructor)]
//     pub fn new(mut env: Env, capacity: u32) -> Result<Self> {
//         let capacity = capacity as usize;
//
//         // Validate capacity
//         if capacity > 100_000_000 {
//             return Err(Error::new(
//                 Status::InvalidArg,
//                 "Capacity too large (max 100MB)",
//             ));
//         }
//
//         let buffer = vec![0; capacity];
//         let buffer_size = buffer.len();
//         env.adjust_external_memory(buffer_size as i64)?;
//         Ok(Self {
//             buffer,
//             capacity,
//         })
//     }
//
//     #[napi]
//     pub fn process(&mut self, data: Buffer) -> Result<usize> {
//         let data_vec: Vec<u8> = data.into();
//
//         // Validate size
//         if data_vec.len() > 1_000_000 {
//             return Err(Error::new(
//                 Status::InvalidArg,
//                 "Data too large (max 1MB)",
//             ));
//         }
//
//         let processed: Vec<u8> = data_vec.iter()
//             .map(|b| b.wrapping_add(1))
//             .collect();
//
//         // Check for overflow
//         let new_len = self.buffer.len().checked_add(processed.len())
//             .ok_or_else(|| Error::new(Status::GenericFailure, "Buffer overflow"))?;
//
//         if new_len > self.capacity {
//             return Err(Error::new(
//                 Status::InvalidArg,
//                 "Buffer capacity exceeded",
//             ));
//         }
//
//         let processed_len = processed.len();
//         self.buffer.extend(processed);
//         Ok(processed_len)
//     }
//
//     #[napi]
//     pub fn get_buffer(&self) -> Buffer {
//         self.buffer.clone().into()
//     }
//
//     #[napi(getter)]
//     pub fn length(&self) -> u32 {
//         self.buffer.len() as u32
//     }
//
//     #[napi(setter)]
//     pub fn set_capacity(&mut self, mut env: Env, new_capacity: u32) -> Result<()> {
//         let new_capacity = new_capacity as usize;
//
//         // Validate new capacity
//         if new_capacity > 100_000_000 {
//             return Err(Error::new(
//                 Status::InvalidArg,
//                 "Capacity too large (max 100MB)",
//             ));
//         }
//
//         // Adjust external memory tracking
//         let old_len = self.buffer.len();
//         let diff = new_capacity as isize - old_len as isize;
//
//         env.adjust_external_memory(diff as i64)?;
//
//         self.buffer.resize(new_capacity, 0);
//         self.capacity = new_capacity;
//         Ok(())
//     }
//
//     /// Factory method to create with default capacity
//     #[napi(factory)]
//     pub fn with_default_capacity() -> Self {
//         Self {
//             buffer: Vec::with_capacity(1024),
//             capacity: 1024,
//         }
//     }
//
//     // Async process method (commented out - async with mut self not supported)
//     // #[napi]
//     // pub async fn process_async(mut self, data: Buffer) -> Result<usize> {
//     //     // Buffer can cross async boundaries
//     //     tokio::time::sleep(std::time::Duration::from_millis(10)).await;
//     //     self.process(data)
//     // }
// }
//
// impl ObjectFinalize for StreamingProcessor {
//     fn finalize(self, mut env: Env) -> Result<()> {
//         // Clean up external memory
//         env.adjust_external_memory(-(self.buffer.len() as i64))?;
//         Ok(())
//     }
// }

/// High-performance batch processor using Rayon
#[napi]
pub fn parallel_process_items(items: Vec<String>, operation: String) -> Result<Vec<String>> {
    use rayon::prelude::*;

    // Validate input size
    if items.len() > 100_000 {
        return Err(Error::new(Status::InvalidArg, "Too many items (max 100k)"));
    }

    // Validate total size
    let total_size: usize = items.iter().map(|s| s.len()).sum();
    if total_size > 100_000_000 {
        return Err(Error::new(
            Status::InvalidArg,
            "Total input too large (max 100MB)",
        ));
    }

    Ok(items
        .into_par_iter()
        .map(|item| match operation.as_str() {
            "uppercase" => item.to_uppercase(),
            "lowercase" => item.to_lowercase(),
            "reverse" => item.chars().rev().collect(),
            "trim" => item.trim().to_string(),
            _ => item,
        })
        .collect::<Vec<_>>())
}

/// Shared state processor using Arc (thread-safe)
#[napi]
pub struct SharedStateProcessor {
    state: Arc<parking_lot::Mutex<Vec<u8>>>,
}

#[napi]
impl SharedStateProcessor {
    #[napi(constructor)]
    pub fn new() -> Self {
        Self {
            state: Arc::new(parking_lot::Mutex::new(Vec::new())),
        }
    }

    #[napi]
    pub fn add_data(&self, data: Buffer) -> Result<()> {
        let data_vec: Vec<u8> = data.into();

        // Validate size
        if data_vec.len() > 10_000_000 {
            return Err(Error::new(Status::InvalidArg, "Data too large (max 10MB)"));
        }

        let mut state = self.state.lock();
        let new_len = state
            .len()
            .checked_add(data_vec.len())
            .ok_or_else(|| Error::new(Status::GenericFailure, "State overflow"))?;

        if new_len > 100_000_000 {
            return Err(Error::new(
                Status::InvalidArg,
                "State too large (max 100MB)",
            ));
        }

        state.extend(data_vec);
        Ok(())
    }

    #[napi]
    pub fn get_data(&self) -> Buffer {
        let state = self.state.lock();
        state.clone().into()
    }

    #[napi]
    pub fn clear(&self) -> Result<()> {
        let mut state = self.state.lock();
        // Securely zero the buffer before clearing
        use zeroize::Zeroize;
        state.zeroize();
        Ok(())
    }
}

impl Default for SharedStateProcessor {
    fn default() -> Self {
        Self::new()
    }
}

/// Typed array operations
#[napi]
pub fn process_typed_array(_env: Env, input: Uint32Array) -> Result<Uint32Array> {
    let slice = input.as_ref();

    // Validate size
    if slice.len() > 1_000_000 {
        return Err(Error::new(
            Status::InvalidArg,
            "Array too large (max 1M elements)",
        ));
    }

    let processed: Vec<u32> = slice
        .iter()
        .map(|n| {
            n.checked_mul(2)
                .ok_or_else(|| Error::new(Status::GenericFailure, "Multiplication overflow"))
        })
        .collect::<Result<Vec<_>>>()?;

    Ok(Uint32Array::new(processed))
}

#[napi]
pub fn float_array_stats(input: Float64Array) -> Result<ObjectStats> {
    let slice = input.as_ref();

    // Validate size
    if slice.len() > 1_000_000 {
        return Err(Error::new(
            Status::InvalidArg,
            "Array too large (max 1M elements)",
        ));
    }

    if slice.is_empty() {
        return Ok(ObjectStats {
            min: 0.0,
            max: 0.0,
            avg: 0.0,
            sum: 0.0,
            count: 0,
        });
    }

    let sum: f64 = slice.iter().sum();
    let avg = sum / slice.len() as f64;
    let min = slice.iter().fold(f64::NAN, |a, b| a.min(*b));
    let max = slice.iter().fold(f64::NAN, |a, b| a.max(*b));

    Ok(ObjectStats {
        min,
        max,
        avg,
        sum,
        count: slice.len() as u32,
    })
}

#[napi(object)]
pub struct ObjectStats {
    pub min: f64,
    pub max: f64,
    pub avg: f64,
    pub sum: f64,
    pub count: u32,
}

/// Error handling with custom error types
#[napi]
pub fn fallible_complex_operation(input: String) -> Result<ComplexResult> {
    // Validate input size
    if input.len() > 1_000_000 {
        return Err(Error::new(
            Status::InvalidArg,
            "Input too large (max 1MB)".to_string(),
        ));
    }

    if input.is_empty() {
        return Err(Error::new(
            Status::InvalidArg,
            "Input cannot be empty".to_string(),
        ));
    }

    Ok(ComplexResult {
        success: true,
        processed_length: input.len() as u32,
        hash: blake3::hash(input.as_bytes()).to_hex().to_string(),
        metadata: Some(Metadata {
            timestamp: chrono::Utc::now().to_rfc3339(),
            complexity: input.chars().filter(|c| c.is_alphanumeric()).count() as u32,
        }),
    })
}

#[napi(object)]
pub struct ComplexResult {
    pub success: bool,
    pub processed_length: u32,
    pub hash: String,
    pub metadata: Option<Metadata>,
}

#[napi(object)]
pub struct Metadata {
    pub timestamp: String,
    pub complexity: u32,
}
