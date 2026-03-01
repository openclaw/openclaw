use serde::Serialize;
use thiserror::Error;

/// Core error types for the OpenClaw backend.
#[derive(Error, Debug)]
pub enum OpenClawError {
    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),
    #[error("Internal application error: {0}")]
    Internal(String),
    #[error("Network error: {0}")]
    Network(String),
}

impl From<anyhow::Error> for OpenClawError {
    fn from(err: anyhow::Error) -> Self {
        OpenClawError::Internal(err.to_string())
    }
}

impl Serialize for OpenClawError {
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: serde::ser::Serializer,
    {
        use serde::ser::SerializeStruct;
        let mut state = serializer.serialize_struct("OpenClawError", 2)?;
        state.serialize_field("message", &self.to_string())?;
        state.serialize_field("code", &self.code())?;
        state.end()
    }
}

impl OpenClawError {
    fn code(&self) -> &str {
        match self {
            OpenClawError::Io(_) => "IO_ERROR",
            OpenClawError::Internal(_) => "INTERNAL_ERROR",
            OpenClawError::Network(_) => "NETWORK_ERROR",
        }
    }
}

/// Helper to recover from poisoned mutex with logging, spec-compliant alternative to unwrap()
pub fn recover_mutex_poison<T>(poison_error: std::sync::PoisonError<T>, context: &str) -> T {
    tracing::warn!(
        "Mutex poisoned in context '{}', recovering with inner value",
        context
    );
    poison_error.into_inner()
}

pub type Result<T> = std::result::Result<T, OpenClawError>;
