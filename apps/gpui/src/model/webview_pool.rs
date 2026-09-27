//! One spare per document store, fenced to the current Gateway connection.

#[derive(Clone, Copy, Debug)]
pub enum WebViewKind {
    Control,
    Reading,
}

pub struct WebviewPool<T> {
    gateway: Option<String>,
    generation: u64,
    control: Option<T>,
    reading: Option<T>,
}

impl<T> Default for WebviewPool<T> {
    fn default() -> Self {
        Self {
            gateway: None,
            generation: 0,
            control: None,
            reading: None,
        }
    }
}

impl<T> WebviewPool<T> {
    pub fn connect(&mut self, gateway: &str) -> Vec<T> {
        if self.gateway.as_deref() == Some(gateway) {
            return Vec::new();
        }
        let retired = self.clear();
        self.gateway = Some(gateway.into());
        retired
    }

    pub fn clear(&mut self) -> Vec<T> {
        self.generation += 1;
        self.gateway = None;
        self.control
            .take()
            .into_iter()
            .chain(self.reading.take())
            .collect()
    }

    pub fn generation(&self) -> u64 {
        self.generation
    }

    pub fn needs(&self, kind: WebViewKind) -> bool {
        self.gateway.is_some() && self.get(kind).is_none()
    }

    pub fn get(&self, kind: WebViewKind) -> Option<&T> {
        match kind {
            WebViewKind::Control => self.control.as_ref(),
            WebViewKind::Reading => self.reading.as_ref(),
        }
    }

    pub fn insert(&mut self, generation: u64, kind: WebViewKind, spare: T) -> Result<(), T> {
        if generation != self.generation || !self.needs(kind) {
            return Err(spare);
        }
        *self.slot(kind) = Some(spare);
        Ok(())
    }

    pub fn adopt(&mut self, kind: WebViewKind, ready: impl FnOnce(&T) -> bool) -> Option<T> {
        let slot = self.slot(kind);
        if slot.as_ref().is_some_and(ready) {
            slot.take()
        } else {
            None
        }
    }

    fn slot(&mut self, kind: WebViewKind) -> &mut Option<T> {
        match kind {
            WebViewKind::Control => &mut self.control,
            WebViewKind::Reading => &mut self.reading,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn adopts_only_ready_spares_and_replenishes_once_per_store() {
        let mut pool = WebviewPool::default();
        pool.connect("ws://gateway.test/");
        let generation = pool.generation();
        for kind in [WebViewKind::Control, WebViewKind::Reading] {
            assert!(pool.insert(generation, kind, "first").is_ok());
            assert_eq!(pool.insert(generation, kind, "duplicate"), Err("duplicate"));
            assert_eq!(pool.adopt(kind, |_| false), None);
            assert_eq!(pool.adopt(kind, |_| true), Some("first"));
            assert_eq!(pool.adopt(kind, |_| true), None);
            assert!(pool.insert(generation, kind, "replacement").is_ok());
        }
        assert_eq!(pool.clear(), vec!["replacement", "replacement"]);
    }

    #[test]
    fn switch_sign_out_and_profile_removal_retire_both_stores_and_fence_queued_warming() {
        let mut pool = WebviewPool::default();
        pool.connect("ws://first.test/");
        let first = pool.generation();
        pool.insert(first, WebViewKind::Control, "control").unwrap();
        pool.insert(first, WebViewKind::Reading, "reading").unwrap();
        assert!(pool.connect("ws://first.test/").is_empty());
        assert_eq!(
            pool.connect("ws://second.test/"),
            vec!["control", "reading"]
        );
        assert_eq!(
            pool.insert(first, WebViewKind::Control, "stale"),
            Err("stale")
        );
        let second = pool.generation();
        pool.insert(second, WebViewKind::Control, "second").unwrap();
        assert_eq!(pool.clear(), vec!["second"]);
        assert!(!pool.needs(WebViewKind::Control));
        assert!(!pool.needs(WebViewKind::Reading));
        assert_eq!(
            pool.insert(second, WebViewKind::Reading, "signed out"),
            Err("signed out")
        );
        pool.connect("ws://second.test/");
        assert_eq!(
            pool.insert(second, WebViewKind::Control, "removed profile"),
            Err("removed profile")
        );
    }
}
