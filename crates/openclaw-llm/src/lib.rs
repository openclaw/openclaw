//! LLM provider implementations for the OpenClaw Rust rewrite.
//!
//! Covers the provider surface of the upstream `extensions/` directory:
//! - Native: Anthropic (Claude), OpenAI, Ollama
//! - OpenAI-compatible: 20+ third-party and self-hosted endpoints via
//!   [`compatible::OpenAICompatibleProvider`]

pub mod anthropic;
pub mod compatible;
pub mod ollama;
pub mod openai;
pub mod registry;

pub use anthropic::anthropic_provider;
pub use compatible::{
    compatible_provider, known_compatible, OpenAICompatibleProvider, KNOWN_COMPATIBLE,
};
pub use ollama::ollama_provider;
pub use openai::openai_provider;
pub use registry::ProviderRegistry;
