//! A document and route receipt must settle before its native view can be revealed.

#[derive(Default)]
pub struct WebPresentation {
    document: Option<String>,
    pub navigation: u64,
    generation: u64,
    requested: Option<String>,
    pub url: String,
    pub ready: bool,
}

impl WebPresentation {
    pub fn revealable(&self) -> bool {
        self.ready && self.url != "about:blank"
    }

    pub fn navigate_document(&mut self, url: &str) {
        self.navigation += 1;
        self.document = None;
        self.generation = 0;
        self.requested = None;
        self.url = url.into();
        self.ready = false;
    }

    pub fn navigate_route(&mut self, url: &str) {
        self.requested = Some(url.into());
        self.ready = false;
    }

    pub fn navigate_history(&mut self) {
        self.generation += 1;
        self.requested = None;
        self.ready = false;
    }

    pub fn document(&mut self, id: &str, url: &str, navigation: u64) -> bool {
        if self.document.is_none() && navigation == self.navigation {
            self.document = Some(id.into());
            self.url = url.into();
            return true;
        }
        false
    }

    pub fn acknowledge_route(&mut self, document: &str, url: &str, generation: u64) {
        if self.document.as_deref() == Some(document) && self.requested.as_deref() == Some(url) {
            self.requested = None;
            self.generation = self.generation.max(generation);
        }
    }

    pub fn update(&mut self, document: &str, generation: u64, url: &str, ready: bool) -> bool {
        if self.document.as_deref() != Some(document) || generation < self.generation {
            return false;
        }
        if let Some(requested) = &self.requested {
            if requested != url {
                return false;
            }
            // Matching loading acknowledges native intent. The router can then
            // legitimately redirect this generation to a different destination.
            self.requested = None;
        }
        let changed = self.ready != ready || self.url != url || self.generation != generation;
        self.generation = generation;
        self.url = url.into();
        self.ready = ready;
        changed
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reload_rejects_old_document_receipts_and_routes_reject_superseded_results() {
        let mut view = WebPresentation::default();
        view.navigate_document("https://example.test/settings");
        view.document("first", "https://example.test/settings", view.navigation);
        assert!(view.update("first", 1, "https://example.test/settings", true));
        view.navigate_route("https://example.test/automations");
        assert!(!view.ready);
        assert!(!view.update("first", 1, "https://example.test/settings", true));
        assert!(view.update("first", 2, "https://example.test/automations", false));
        assert!(view.update("first", 3, "https://example.test/tasks", false));
        assert!(!view.update("first", 2, "https://example.test/automations", true));
        assert!(view.update("first", 3, "https://example.test/tasks", true));
        view.navigate_document("https://example.test/tasks");
        let current = view.navigation;
        assert!(!view.document("first", "https://example.test/settings", current - 1));
        assert!(!view.update("first", 4, "https://example.test/tasks", true));
        view.document("second", "https://example.test/tasks", current);
        view.document("first", "https://example.test/tasks", current - 1);
        assert!(!view.update("first", 4, "https://example.test/tasks", true));
        assert!(view.update("second", 1, "https://example.test/tasks", true));
        view.navigate_history();
        assert!(!view.update("second", 1, "https://example.test/tasks", true));
        assert!(view.update("second", 2, "https://example.test/settings", true));
    }

    #[test]
    fn native_same_route_and_acknowledged_redirect_can_reveal_without_reloading() {
        let mut view = WebPresentation::default();
        view.document("blank", "about:blank", view.navigation);
        view.update("blank", 0, "about:blank", true);
        assert!(view.ready);
        assert!(!view.revealable());
        view.navigate_document("https://example.test/settings");
        view.document("doc", "https://example.test/settings", view.navigation);
        view.update("doc", 1, "https://example.test/settings", true);
        assert!(view.revealable());
        view.navigate_route("https://example.test/settings");
        assert!(view.update("doc", 1, "https://example.test/settings", true));
        view.navigate_route("https://example.test/old-route");
        view.acknowledge_route("doc", "https://example.test/old-route", 2);
        assert!(!view.update("doc", 1, "https://example.test/settings", true));
        assert!(view.update("doc", 3, "https://example.test/current-route", true));
        assert!(view.ready);
    }
}
