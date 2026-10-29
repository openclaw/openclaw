use openclaw_core::traits::ModelProvider;
use std::collections::HashMap;
use std::sync::Arc;

/// Registry of available model providers.
#[derive(Debug, Default)]
pub struct ProviderRegistry {
    providers: HashMap<String, Arc<dyn ModelProvider>>,
}

impl ProviderRegistry {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Register a provider.
    pub fn register(&mut self, provider: Arc<dyn ModelProvider>) {
        self.providers.insert(provider.id().to_owned(), provider);
    }

    /// Look up a provider by id.
    #[must_use]
    pub fn get(&self, id: &str) -> Option<&Arc<dyn ModelProvider>> {
        self.providers.get(id)
    }

    /// List registered provider ids.
    #[must_use]
    pub fn list(&self) -> Vec<&str> {
        self.providers.keys().map(String::as_str).collect()
    }
}
