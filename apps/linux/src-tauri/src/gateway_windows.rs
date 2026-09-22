//! Window selection is independent of the Primary Gateway's process and RPC owners.
use crate::gateway_profiles::{GatewayProfiles, SavedGateway};
use crate::gateway_ws::GatewayOwnership;
use crate::native_browser_platform::NavigationEvent;
use crate::remote_gateway::{self, RemoteGatewayRequest, SshTunnel};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashSet};
use std::sync::{Arc, Condvar, Mutex};
#[cfg(any(target_os = "windows", test))]
use std::{
    path::{Path, PathBuf},
    time::{Duration, Instant},
};
use tauri::ipc::CapabilityBuilder;
use tauri::menu::{MenuItem, PredefinedMenuItem, Submenu};
use tauri::webview::{NewWindowResponse, PageLoadEvent, WebviewBuilder};
use tauri::{AppHandle, LogicalPosition, Manager, Url, Webview, WebviewUrl, WindowBuilder};

pub(crate) const PRIMARY: &str = "primary";
const SETTINGS: &str = "gateway-settings";
const INITIAL_SELECTION: &str = "initial-selection";
const LOAD_FAILURE: &str =
    "Could not load this Gateway. Check its address and connection, then try again.";
const STALE: &str = "This Gateway action was cancelled because the window or connection changed.";

#[derive(Clone)]
struct Route {
    url: Url,
    auth_script: Option<String>,
}

#[derive(Clone)]
struct Document {
    lifetime: String,
    nonce: Option<String>,
    url: Url,
    phase: NavigationPhase,
    navigation: u64,
    native_navigation: Option<u64>,
    queued_url: Option<Url>,
    completion: Option<SelectionCompletion>,
    profile_revision: Option<String>,
    #[cfg(target_os = "windows")]
    _browser_data: Option<Arc<TemporaryBrowserData>>,
}

#[derive(Clone, Copy, Eq, PartialEq)]
enum NavigationPhase {
    Preparing,
    Active,
    Failed,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Default)]
enum SelectionCompletion {
    #[default]
    Automatic,
    Explicit(u64),
    RestoreEdited(u64),
}

impl SelectionCompletion {
    fn remembers(self, sequence: u64) -> bool {
        matches!(self,Self::Explicit(id)|Self::RestoreEdited(id) if id==sequence)
    }
    fn presents(self, sequence: u64) -> bool {
        matches!(self,Self::Explicit(id) if id==sequence)
    }
}

#[derive(Clone)]
struct DocumentEvent {
    label: String,
    window_lifetime: String,
    document_lifetime: String,
    navigation: u64,
}

struct WindowRoute {
    lifetime: String,
    target: String,
    primary_generation: Option<u64>,
    generation: u64,
    document: Option<Document>,
    pending: Option<PendingSelection>,
    tunnel: Option<SshTunnel>,
    notice: Option<String>,
    recovery: Option<SelectionCompletion>,
}

struct PendingSelection {
    intent: Intent,
    completion: SelectionCompletion,
    action: PendingAction,
}

#[derive(Clone, Copy, Eq, PartialEq)]
enum PendingAction {
    Switch,
    Promote,
}

impl WindowRoute {
    fn pending_target(&self) -> Option<&str> {
        self.pending
            .as_ref()
            .map(|pending| pending.intent.target.as_str())
    }
}

impl Default for WindowRoute {
    fn default() -> Self {
        Self {
            lifetime: uuid::Uuid::new_v4().to_string(),
            target: PRIMARY.into(),
            primary_generation: None,
            generation: 0,
            document: None,
            pending: None,
            tunnel: None,
            notice: None,
            recovery: None,
        }
    }
}

#[derive(Debug, Eq, PartialEq)]
enum SelectionDisposition {
    Pending,
    Reuse,
    Replace,
}

#[derive(Debug, Eq, PartialEq)]
#[cfg(any(target_os = "linux", test))]
enum MainPresentation {
    Preserve,
    ReloadRemotePrimary,
    LegacyFallback,
}

#[derive(Clone)]
struct DocumentAuthority {
    label: String,
    lifetime: String,
    nonce: String,
}

#[derive(Clone)]
struct Intent {
    label: String,
    window_lifetime: String,
    generation: u64,
    source: Option<DocumentAuthority>,
    source_url: Option<Url>,
    target: String,
}

#[derive(Clone)]
pub(crate) struct PromotionGuard {
    intent: Intent,
    profile_id: String,
    profile_revision: String,
}

impl PromotionGuard {
    fn matches(&self, routing: &Routing, profile: &SavedGateway) -> bool {
        profile.id == self.profile_id
            && profile.revision == self.profile_revision
            && routing.current(&self.intent)
    }

    pub(crate) fn current(&self, app: &AppHandle) -> bool {
        let owner = app.state::<GatewayWindows>();
        let Ok(profile) = owner.profiles.get(&self.profile_id) else {
            return false;
        };
        let current = owner
            .routing
            .lock()
            .is_ok_and(|routing| self.matches(&routing, &profile));
        current && source_current(app, &owner, &self.intent)
    }
}

#[derive(Default)]
enum InitialSelection {
    #[default]
    AwaitingBootstrap,
    Waiting,
    Restoring {
        generation: u64,
        window_lifetime: String,
    },
    Finished,
}

impl InitialSelection {
    fn matches(&self, intent: &Intent) -> bool {
        matches!(self,Self::Restoring {generation,window_lifetime} if *generation==intent.generation && *window_lifetime==intent.window_lifetime)
    }
}

#[derive(Default)]
struct Routing {
    primary: Option<Route>,
    primary_ownership: Option<GatewayOwnership>,
    primary_generation: u64,
    windows: BTreeMap<String, WindowRoute>,
    discovered: BTreeMap<String, (String, Url)>,
    granted: HashSet<(String, String)>,
    closing: bool,
    preparing: usize,
    initial_selection: InitialSelection,
    selection_sequence: u64,
    selection_target: Option<String>,
}

impl Routing {
    fn document_navigation(&mut self, label: &str, lifetime: &str, url: &Url) -> bool {
        if self.closing {
            return false;
        }
        let Some(doc) = self
            .windows
            .get(label)
            .and_then(|route| route.document.as_ref())
            .filter(|doc| doc.lifetime == lifetime)
        else {
            return false;
        };
        if doc.phase == NavigationPhase::Preparing {
            return url.as_str() == "about:blank";
        }
        if doc.phase == NavigationPhase::Failed {
            return false;
        }
        self.retire_initial_document(label);
        let route = self.windows.get_mut(label).expect("current document");
        route.generation = route.generation.wrapping_add(1);
        route.pending = None;
        let doc = route.document.as_mut().expect("current document");
        doc.navigation = doc.navigation.wrapping_add(1);
        doc.phase = NavigationPhase::Active;
        doc.nonce = None;
        true
    }

    fn document_event(&self, label: &str, lifetime: &str) -> Option<DocumentEvent> {
        let route = self.windows.get(label)?;
        let doc = route
            .document
            .as_ref()
            .filter(|doc| doc.lifetime == lifetime)?;
        Some(DocumentEvent {
            label: label.into(),
            window_lifetime: route.lifetime.clone(),
            document_lifetime: lifetime.into(),
            navigation: doc.navigation,
        })
    }

    fn native_document_event(
        &mut self,
        label: &str,
        lifetime: &str,
        native: NavigationEvent,
    ) -> Option<DocumentEvent> {
        if self.closing {
            return None;
        }
        let doc = self.windows.get_mut(label)?.document.as_mut()?;
        if doc.lifetime != lifetime || doc.phase != NavigationPhase::Active {
            return None;
        }
        if matches!(native, NavigationEvent::Started) {
            doc.native_navigation = Some(doc.navigation);
            return None;
        }
        // Native identity filtering pairs this result with the captured start.
        // A later policy callback can precede its own native Started callback.
        let navigation = doc.native_navigation.take()?;
        let mut event = self.document_event(label, lifetime)?;
        event.navigation = navigation;
        if !self.document_event_current(&event) {
            return None;
        }
        if matches!(native, NavigationEvent::Failed) {
            self.document_failed(label, lifetime)
        } else {
            Some(event)
        }
    }

    fn document_event_current(&self, event: &DocumentEvent) -> bool {
        !self.closing
            && self.windows.get(&event.label).is_some_and(|route| {
                route.lifetime == event.window_lifetime
                    && route.document.as_ref().is_some_and(|doc| {
                        doc.lifetime == event.document_lifetime
                            && doc.navigation == event.navigation
                    })
            })
    }

    fn document_failed(&mut self, label: &str, lifetime: &str) -> Option<DocumentEvent> {
        let event = self.document_event(label, lifetime)?;
        if !self.document_event_current(&event) {
            return None;
        }
        let doc = self.windows.get_mut(label)?.document.as_mut()?;
        if doc.phase == NavigationPhase::Failed {
            return None;
        }
        doc.phase = NavigationPhase::Failed;
        doc.nonce = None;
        Some(event)
    }

    fn failed_document(&self, event: &DocumentEvent) -> bool {
        self.document_event_current(event)
            && self.windows.get(&event.label).is_some_and(|route| {
                route.pending.is_none()
                    && route
                        .document
                        .as_ref()
                        .is_some_and(|doc| doc.phase == NavigationPhase::Failed)
            })
    }

    fn begin_document_recovery(&mut self, event: &DocumentEvent) -> Option<(Intent, bool)> {
        if !self.failed_document(event) {
            return None;
        }
        let route = self.windows.get_mut(&event.label)?;
        let target = route.target.clone();
        let completion = route
            .document
            .as_mut()?
            .completion
            .take()
            .unwrap_or_default();
        let present = completion.presents(self.selection_sequence);
        let intent = self.begin(&event.label, &target, None);
        self.windows
            .get_mut(&event.label)?
            .pending
            .as_mut()?
            .completion = completion;
        Some((intent, present))
    }

    fn complete_document(
        &mut self,
        event: &DocumentEvent,
        url: &Url,
    ) -> Option<(Document, SelectionCompletion, Option<String>)> {
        if !self.document_event_current(event) {
            return None;
        }
        let route = self.windows.get_mut(&event.label)?;
        let doc = route.document.as_mut()?;
        if doc.phase != NavigationPhase::Active || !matches_route(url, &doc.url) {
            return None;
        }
        doc.nonce = Some(uuid::Uuid::new_v4().to_string());
        let completion = doc.completion.take().unwrap_or_default();
        Some((doc.clone(), completion, route.notice.take()))
    }

    fn bootstrap_admitted(&mut self) {
        if matches!(self.initial_selection, InitialSelection::AwaitingBootstrap) {
            self.initial_selection = InitialSelection::Waiting;
        }
    }

    fn retire_initial_document(&mut self, label: &str) {
        if label != "main" {
            return;
        }
        let matching = match &self.initial_selection {
            InitialSelection::Restoring {
                generation,
                window_lifetime,
            } => self.windows.get(label).is_some_and(|route| {
                route.generation == *generation && route.lifetime == *window_lifetime
            }),
            _ => false,
        };
        if matching {
            self.initial_selection = InitialSelection::Waiting;
        }
    }

    fn reserve_initial_selection(&mut self, local_url: Option<Url>) -> Option<Intent> {
        if self.closing || !matches!(self.initial_selection, InitialSelection::Waiting) {
            return None;
        }
        let route = self.windows.entry("main".into()).or_default();
        if route.target != PRIMARY || route.pending.is_some() {
            return None;
        }
        let source = if local_url.is_some() {
            None
        } else {
            let document = route.document.as_ref()?;
            Some(DocumentAuthority {
                label: "main".into(),
                lifetime: document.lifetime.clone(),
                nonce: document.nonce.clone()?,
            })
        };
        let mut intent = self.begin("main", INITIAL_SELECTION, source);
        intent.source_url = local_url;
        self.initial_selection = InitialSelection::Restoring {
            generation: intent.generation,
            window_lifetime: intent.window_lifetime.clone(),
        };
        Some(intent)
    }

    fn resolve_initial_selection(
        &mut self,
        intent: &Intent,
        target: Option<&str>,
    ) -> Option<Intent> {
        if !self.initial_selection.matches(intent) || !self.current(intent) {
            return None;
        }
        if let Some(target) = target {
            let mut next = self.begin("main", target, intent.source.clone());
            next.source_url = intent.source_url.clone();
            self.initial_selection = InitialSelection::Restoring {
                generation: next.generation,
                window_lifetime: next.window_lifetime.clone(),
            };
            Some(next)
        } else {
            self.cancel("main");
            self.initial_selection = InitialSelection::Finished;
            None
        }
    }

    fn finish_initial_selection(&mut self, intent: &Intent) {
        if self.initial_selection.matches(intent) {
            if self.current(intent) {
                self.cancel("main");
            }
            self.initial_selection = InitialSelection::Finished;
        }
    }

    fn explicit_selection(&mut self) {
        if let InitialSelection::Restoring {
            generation,
            window_lifetime,
        } = &self.initial_selection
        {
            if self.windows.get("main").is_some_and(|route| {
                route.generation == *generation && route.lifetime == *window_lifetime
            }) {
                self.cancel("main");
            }
        }
        self.initial_selection = InitialSelection::Finished;
    }

    fn settings_page_load(&mut self, started: bool) {
        self.explicit_selection();
        if started {
            self.cancel("main");
        }
    }

    fn primary_kind(&self) -> &'static str {
        if self.primary_ownership == Some(GatewayOwnership::Remote) {
            "remote"
        } else {
            "local"
        }
    }

    #[cfg(any(target_os = "linux", test))]
    fn main_presentation(&self) -> MainPresentation {
        if self.closing
            || self.windows.get("main").is_some_and(|route| {
                route.target != PRIMARY || route.recovery.is_some() || route.pending.is_some()
            })
        {
            MainPresentation::Preserve
        } else if self.primary_ownership == Some(GatewayOwnership::Remote)
            && self.can_reuse("main", PRIMARY)
        {
            MainPresentation::ReloadRemotePrimary
        } else {
            MainPresentation::LegacyFallback
        }
    }

    fn follows_primary(&self) -> bool {
        self.windows.get("main").is_none_or(|route| {
            route.recovery.is_none() && route.target == PRIMARY && route.pending.is_none()
        })
    }

    fn begin(&mut self, label: &str, target: &str, source: Option<DocumentAuthority>) -> Intent {
        let route = self.windows.entry(label.to_string()).or_default();
        route.generation = route.generation.wrapping_add(1);
        let intent = Intent {
            label: label.to_string(),
            window_lifetime: route.lifetime.clone(),
            generation: route.generation,
            source,
            source_url: None,
            target: target.to_string(),
        };
        let completion = if route.target == target {
            route.recovery.unwrap_or_default()
        } else {
            SelectionCompletion::Automatic
        };
        route.pending = Some(PendingSelection {
            intent: intent.clone(),
            completion,
            action: PendingAction::Switch,
        });
        if let Some(doc) = &mut route.document {
            doc.completion = None;
        }
        intent
    }

    fn begin_promotion(&mut self, label: &str, target: &str, source: DocumentAuthority) -> Intent {
        let intent = self.begin(label, target, Some(source));
        self.windows
            .get_mut(label)
            .expect("reserved window")
            .pending
            .as_mut()
            .expect("reserved promotion")
            .action = PendingAction::Promote;
        intent
    }

    fn refresh_primary(&mut self, label: &str) -> Intent {
        let inherited = self
            .windows
            .get(label)
            .and_then(|route| route.pending.as_ref())
            .map(|pending| (pending.intent.clone(), pending.completion));
        let document_completion = self
            .windows
            .get(label)
            .and_then(|route| route.document.as_ref())
            .and_then(|doc| doc.completion);
        let mut next = self.begin(
            label,
            PRIMARY,
            inherited
                .as_ref()
                .and_then(|(intent, _)| intent.source.clone()),
        );
        if let Some((previous, completion)) = inherited {
            next.source_url = previous.source_url;
            if let Some(pending) = self
                .windows
                .get_mut(label)
                .and_then(|route| route.pending.as_mut())
            {
                pending.intent = next.clone();
                pending.completion = completion;
            }
        } else if let Some(completion) = document_completion {
            if let Some(pending) = self
                .windows
                .get_mut(label)
                .and_then(|route| route.pending.as_mut())
            {
                pending.completion = completion;
            }
        }
        next
    }

    fn primary_refresh_targets(&self) -> Vec<String> {
        self.windows
            .iter()
            .filter(|(label, route)| match &route.pending {
                Some(pending) => {
                    pending.action == PendingAction::Switch
                        && pending.intent.target == PRIMARY
                        && self.current(&pending.intent)
                }
                None => {
                    label.as_str() != "main"
                        && route.target == PRIMARY
                        && route.primary_generation.is_some()
                        && route.recovery.is_none()
                }
            })
            .map(|(label, _)| label.clone())
            .collect()
    }

    fn current(&self, intent: &Intent) -> bool {
        !self.closing
            && self.owns_intent(intent)
            && intent
                .source
                .as_ref()
                .is_none_or(|source| self.source_current(source))
    }

    fn owns_intent(&self, intent: &Intent) -> bool {
        self.windows.get(&intent.label).is_some_and(|route| {
            route.lifetime == intent.window_lifetime
                && route.generation == intent.generation
                && route.pending_target() == Some(&intent.target)
        })
    }

    fn cancel_intent(&mut self, intent: &Intent) {
        if self.owns_intent(intent) {
            self.cancel(&intent.label);
        }
    }

    fn primary_window(&self) -> Option<(String, bool)> {
        self.window_for_target(PRIMARY).map(|label| {
            let replace = !self.can_reuse(&label, PRIMARY);
            (label, replace)
        })
    }

    fn window_for_target(&self, target: &str) -> Option<String> {
        self.windows
            .iter()
            .find(|(_, route)| {
                route.target == target
                    && !(target == PRIMARY
                        && route.primary_generation.is_none()
                        && route
                            .pending_target()
                            .is_some_and(|pending| pending != PRIMARY))
            })
            .or_else(|| {
                self.windows
                    .iter()
                    .find(|(_, route)| route.pending_target() == Some(target))
            })
            .map(|(label, _)| label.clone())
    }

    fn can_reuse(&self, label: &str, target: &str) -> bool {
        self.windows.get(label).is_some_and(|route| {
            route.target == target
                && route.recovery.is_none()
                && route
                    .document
                    .as_ref()
                    .is_some_and(|doc| doc.nonce.is_some())
                && (target != PRIMARY || route.primary_generation == Some(self.primary_generation))
        })
    }

    fn admit_selection(
        &mut self,
        label: &str,
        target: &str,
        force: bool,
        explicit: bool,
    ) -> SelectionDisposition {
        let joining = self
            .windows
            .get(label)
            .and_then(|route| route.pending.as_ref())
            .filter(|pending| {
                pending.intent.target == target
                    && pending.action == PendingAction::Switch
                    && self.current(&pending.intent)
            })
            .map(|pending| pending.intent.clone());
        if let Some(intent) = joining {
            self.upgrade_selection(&intent, explicit);
            return SelectionDisposition::Pending;
        }
        let loading = self.windows.get(label).is_some_and(|route| {
            route.target == target
                && route.document.as_ref().is_some_and(|doc| {
                    doc.completion.is_some()
                        && doc.nonce.is_none()
                        && doc.phase != NavigationPhase::Failed
                })
        });
        if loading {
            if explicit {
                self.selection_sequence = self.selection_sequence.wrapping_add(1);
                self.selection_target = Some(target.to_string());
                if let Some(doc) = self
                    .windows
                    .get_mut(label)
                    .and_then(|route| route.document.as_mut())
                {
                    doc.completion = Some(SelectionCompletion::Explicit(self.selection_sequence));
                }
            }
            return SelectionDisposition::Pending;
        }
        let reuse = !force && self.can_reuse(label, target);
        self.cancel(label);
        if reuse {
            SelectionDisposition::Reuse
        } else {
            SelectionDisposition::Replace
        }
    }

    fn upgrade_selection(&mut self, intent: &Intent, explicit: bool) {
        if !self.current(intent) {
            return;
        }
        if explicit {
            self.selection_sequence = self.selection_sequence.wrapping_add(1);
            self.selection_target = Some(intent.target.clone());
        }
        if let Some(pending) = self
            .windows
            .get_mut(&intent.label)
            .and_then(|route| route.pending.as_mut())
        {
            pending.intent = intent.clone();
            if explicit {
                pending.completion = SelectionCompletion::Explicit(self.selection_sequence);
            }
        }
    }

    fn remember_edited_selection(&mut self, intent: &Intent) {
        if self.current(intent) {
            if let Some(pending) = self
                .windows
                .get_mut(&intent.label)
                .and_then(|route| route.pending.as_mut())
            {
                pending.completion = SelectionCompletion::RestoreEdited(self.selection_sequence);
            }
        }
    }

    fn remembers_edited_target(&self, id: &str) -> bool {
        self.windows.values().any(|route| {
            (route.target == id
                && (route
                    .recovery
                    .is_some_and(|completion| completion.remembers(self.selection_sequence))
                    || route
                        .document
                        .as_ref()
                        .and_then(|doc| doc.completion)
                        .is_some_and(|completion| completion.remembers(self.selection_sequence))))
                || route.pending.as_ref().is_some_and(|pending| {
                    pending.intent.target == id
                        && self
                            .selection_completion(&pending.intent)
                            .remembers(self.selection_sequence)
                })
        })
    }

    fn selection_completion(&self, intent: &Intent) -> SelectionCompletion {
        if !self.current(intent) {
            return SelectionCompletion::Automatic;
        }
        self.windows
            .get(&intent.label)
            .and_then(|route| route.pending.as_ref())
            .map(|pending| pending.completion)
            .unwrap_or_default()
    }

    fn needs_primary_refresh(&self, label: &str) -> bool {
        !self.closing
            && self.primary.is_some()
            && self.windows.get(label).is_some_and(|route| {
                route.target == PRIMARY
                    && route.recovery.is_none()
                    && route.pending.is_none()
                    && route.primary_generation != Some(self.primary_generation)
            })
    }

    fn enter_profile_recovery(
        &mut self,
        intent: &Intent,
        saved_target: Option<&str>,
    ) -> Result<Option<SshTunnel>, String> {
        if !self.current(intent) || saved_target.is_some_and(|id| id != intent.target) {
            return Err(STALE.into());
        }
        let route = self.windows.get_mut(&intent.label).ok_or(STALE)?;
        route.target = saved_target.unwrap_or(PRIMARY).to_string();
        route.generation = route.generation.wrapping_add(1);
        route.document = None;
        route.recovery = Some(
            match route
                .pending
                .as_ref()
                .map(|pending| pending.completion)
                .unwrap_or_default()
            {
                SelectionCompletion::Explicit(sequence)
                | SelectionCompletion::RestoreEdited(sequence) => {
                    SelectionCompletion::RestoreEdited(sequence)
                }
                SelectionCompletion::Automatic => SelectionCompletion::Automatic,
            },
        );
        route.pending = None;
        Ok(route.tunnel.take())
    }

    fn suspend_document(&mut self, label: &str) {
        if label == "main" {
            self.explicit_selection();
        }
        self.cancel(label);
        if let Some(route) = self.windows.get_mut(label) {
            route.document = None;
            route.recovery = None;
            route.notice = None;
        }
    }

    fn reserve_saved_restore(&mut self, source_url: Url) -> Option<Intent> {
        let target = self.windows.get("main")?.target.clone();
        if self.closing || target == PRIMARY {
            return None;
        }
        let mut intent = self.begin("main", &target, None);
        intent.source_url = Some(source_url);
        Some(intent)
    }

    fn source_current(&self, source: &DocumentAuthority) -> bool {
        self.windows
            .get(&source.label)
            .and_then(|route| route.document.as_ref())
            .is_some_and(|doc| {
                doc.lifetime == source.lifetime && doc.nonce.as_ref() == Some(&source.nonce)
            })
    }

    fn cancel(&mut self, label: &str) {
        if let Some(route) = self.windows.get_mut(label) {
            route.generation = route.generation.wrapping_add(1);
            route.pending = None;
            if let Some(doc) = &mut route.document {
                doc.completion = None;
            }
        }
    }

    fn invalidate_profile(&mut self, id: &str) -> Vec<String> {
        let mut affected = Vec::new();
        for (label, route) in &mut self.windows {
            if route.pending_target() == Some(id) || route.target == id {
                route.generation = route.generation.wrapping_add(1);
                route.pending = None;
            }
            if route.target == id {
                if let Some(doc) = &mut route.document {
                    doc.nonce = None;
                    doc.lifetime = uuid::Uuid::new_v4().to_string();
                }
                affected.push(label.clone());
            }
        }
        affected
    }
}

pub(crate) struct GatewayWindows {
    profiles: GatewayProfiles,
    routing: Mutex<Routing>,
    menus: Mutex<Vec<Submenu<tauri::Wry>>>,
    idle: Condvar,
    #[cfg(target_os = "windows")]
    browser_cleanup: Arc<BrowserDataCleanup>,
}

#[derive(Clone)]
pub(crate) struct DocumentRegistration {
    app: AppHandle,
    label: String,
    pub script: String,
    pub lifetime: String,
    #[cfg(target_os = "windows")]
    browser_data: Option<Arc<TemporaryBrowserData>>,
}

type DocumentReady = Arc<dyn Fn(&Webview) + Send + Sync>;

impl DocumentRegistration {
    pub fn initial_url(&self) -> WebviewUrl {
        WebviewUrl::External(Url::parse("about:blank").expect("blank URL"))
    }

    pub fn configure(&self, builder: WebviewBuilder<tauri::Wry>) -> WebviewBuilder<tauri::Wry> {
        let registration = self.clone();
        let builder = builder.on_navigation(move |url| {
            registration
                .app
                .state::<GatewayWindows>()
                .routing
                .lock()
                .is_ok_and(|mut state| {
                    state.document_navigation(&registration.label, &registration.lifetime, url)
                })
        });
        #[cfg(target_os = "windows")]
        if let Some(data) = &self.browser_data {
            return builder.data_directory(data.path.clone());
        }
        builder
    }

    pub fn page_load(&self, view: Webview, url: &Url, started: bool) {
        // Capture the whole registration in the native callback: its Windows
        // directory lease must outlive the actual WebView, including close.
        let app = view.app_handle().clone();
        app.state::<GatewayWindows>()
            .page_load(view, &self.lifetime, url, started);
    }

    pub fn start(&self, view: Webview, ready: impl Fn(&Webview) + Send + Sync + 'static) {
        let registration = self.clone();
        let ready: DocumentReady = Arc::new(ready);
        tauri::async_runtime::spawn(async move {
            let app = registration.app.clone();
            let label = registration.label.clone();
            let lifetime = registration.lifetime.clone();
            let observer_app = app.clone();
            let observer_label = label.clone();
            let observer_lifetime = lifetime.clone();
            let observed =
                crate::native_browser_platform::observe_navigation_events(&view, move |native| {
                    let event = observer_app
                        .state::<GatewayWindows>()
                        .routing
                        .lock()
                        .ok()
                        .and_then(|mut state| {
                            state.native_document_event(&observer_label, &observer_lifetime, native)
                        });
                    let Some(event) = event else {
                        return;
                    };
                    match native {
                        NavigationEvent::Succeeded => {
                            schedule_document_success(&observer_app, event, Arc::clone(&ready))
                        }
                        NavigationEvent::Failed => schedule_document_failure(&observer_app, event),
                        NavigationEvent::Started => {}
                    }
                })
                .await;
            let _ = on_main(&app, move |app| {
                let owner = app.state::<GatewayWindows>();
                let target = {
                    let mut state = owner.routing.lock().map_err(|_| STALE)?;
                    let Some(doc) = state
                        .windows
                        .get_mut(&label)
                        .and_then(|route| route.document.as_mut())
                        .filter(|doc| {
                            doc.lifetime == lifetime && doc.phase == NavigationPhase::Preparing
                        })
                    else {
                        return Ok(());
                    };
                    if observed.is_err() {
                        None
                    } else {
                        doc.phase = NavigationPhase::Active;
                        doc.queued_url.take()
                    }
                };
                if let Some(target) = target {
                    if view.navigate(target).is_ok() {
                        return Ok(());
                    }
                }
                let event = owner
                    .routing
                    .lock()
                    .map_err(|_| STALE)?
                    .document_failed(&label, &lifetime);
                if let Some(event) = event {
                    schedule_document_failure(app, event);
                }
                Ok(())
            })
            .await;
        });
    }
}

#[cfg(any(target_os = "windows", test))]
#[derive(Default)]
struct BrowserDataCleanup {
    pending: Mutex<usize>,
    idle: Condvar,
}

#[cfg(any(target_os = "windows", test))]
impl BrowserDataCleanup {
    fn wait(&self) {
        let deadline = Instant::now() + Duration::from_secs(10);
        let mut pending = self.pending.lock().expect("browser data cleanup");
        while *pending > 0 {
            let Some(remaining) = deadline.checked_duration_since(Instant::now()) else {
                break;
            };
            let (next, timed) = self
                .idle
                .wait_timeout(pending, remaining)
                .expect("browser data cleanup");
            pending = next;
            if timed.timed_out() {
                break;
            }
        }
    }
}

#[cfg(any(target_os = "windows", test))]
struct TemporaryBrowserData {
    path: PathBuf,
    cleanup: Arc<BrowserDataCleanup>,
}

#[cfg(any(target_os = "windows", test))]
impl TemporaryBrowserData {
    fn create(parent: &Path, cleanup: Arc<BrowserDataCleanup>) -> Result<Arc<Self>, String> {
        std::fs::create_dir_all(parent)
            .map_err(|_| "Could not create private Gateway browser storage.")?;
        let path = parent.join(uuid::Uuid::new_v4().to_string());
        // create_dir establishes ownership; an existing directory is never adopted.
        std::fs::create_dir(&path)
            .map_err(|_| "Could not create private Gateway browser storage.")?;
        *cleanup.pending.lock().expect("browser data cleanup") += 1;
        Ok(Arc::new(Self { path, cleanup }))
    }
}

#[cfg(any(target_os = "windows", test))]
impl Drop for TemporaryBrowserData {
    fn drop(&mut self) {
        let path = self.path.clone();
        let cleanup = Arc::clone(&self.cleanup);
        tauri::async_runtime::spawn_blocking(move || {
            // WebView2 may release its browser-process handles after controller
            // destruction. Retry only this known, task-owned native directory.
            let deadline = Instant::now() + Duration::from_secs(5);
            loop {
                match std::fs::remove_dir_all(&path) {
                    Ok(()) => break,
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => break,
                    Err(_) if Instant::now() < deadline => {
                        std::thread::sleep(Duration::from_millis(250))
                    }
                    Err(_) => {
                        eprintln!("Temporary Gateway browser storage could not be removed.");
                        break;
                    }
                }
            }
            *cleanup.pending.lock().expect("browser data cleanup") -= 1;
            cleanup.idle.notify_all();
        });
    }
}

#[cfg(any(target_os = "windows", test))]
fn isolated_browser_document(label: &str, target: &str) -> bool {
    label != "main" || target != PRIMARY
}

fn matches_route(candidate: &Url, expected: &Url) -> bool {
    if !crate::external_browser_url_allowed(candidate) || candidate.origin() != expected.origin() {
        return false;
    }
    let base = expected.path().trim_end_matches('/');
    base.is_empty()
        || candidate.path() == base
        || candidate
            .path()
            .strip_prefix(base)
            .is_some_and(|suffix| suffix.starts_with('/'))
}

fn scoped_script(document: &Document, body: &str) -> String {
    let origin = json!(document.url.origin().ascii_serialization());
    let base = json!(document.url.path().trim_end_matches('/'));
    format!("(() => {{ if (window !== window.top || location.origin !== {origin}) return; const base={base}; if (base && location.pathname !== base && !location.pathname.startsWith(base+'/')) return; {body} }})();")
}

impl GatewayWindows {
    pub fn new(namespace: &str) -> Self {
        Self {
            profiles: GatewayProfiles::new(namespace),
            routing: Mutex::new(Routing::default()),
            menus: Mutex::new(Vec::new()),
            idle: Condvar::new(),
            #[cfg(target_os = "windows")]
            browser_cleanup: Arc::new(BrowserDataCleanup::default()),
        }
    }

    pub fn primary_selected(
        &self,
        app: &AppHandle,
        url: &Url,
        auth_script: Option<String>,
        ownership: GatewayOwnership,
    ) -> Result<bool, String> {
        let (follows, reconnects) = {
            let mut state = self.routing.lock().map_err(|_| STALE)?;
            let changed = state
                .primary
                .as_ref()
                .is_none_or(|previous| previous.url != *url || previous.auth_script != auth_script);
            if changed {
                state.primary_generation = state.primary_generation.wrapping_add(1);
            }
            state.primary = Some(Route {
                url: url.clone(),
                auth_script,
            });
            state.primary_ownership = Some(ownership);
            let labels = if changed {
                state.primary_refresh_targets()
            } else {
                Vec::new()
            };
            let reconnects = labels
                .into_iter()
                .map(|label| state.refresh_primary(&label))
                .collect::<Vec<_>>();
            (state.follows_primary(), reconnects)
        };
        for intent in reconnects {
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                let label = intent.label.clone();
                if let Err(error) = select_intent(app.clone(), intent).await {
                    show_error(&app, &label, &error);
                }
            });
        }
        self.publish(app);
        Ok(follows)
    }

    pub fn main_is_primary(&self, _app: &AppHandle) -> bool {
        self.routing
            .lock()
            .is_ok_and(|state| state.follows_primary())
    }

    pub fn main_has_selected_gateway(&self) -> bool {
        self.routing.lock().is_ok_and(|state| {
            state
                .windows
                .get("main")
                .is_some_and(|route| route.target != PRIMARY)
        })
    }

    #[cfg(target_os = "linux")]
    pub fn present_main_dashboard(&self, app: &AppHandle) -> Result<bool, String> {
        let presentation = self.routing.lock().map_err(|_| STALE)?.main_presentation();
        match presentation {
            MainPresentation::Preserve => Ok(true),
            MainPresentation::LegacyFallback => Ok(false),
            MainPresentation::ReloadRemotePrimary => {
                if !self.ready_document(app, "main") {
                    return Ok(false);
                }
                let view = app
                    .get_webview("main")
                    .ok_or("The dashboard is no longer available.")?;
                let current = view
                    .url()
                    .map_err(|_| "Could not read the current dashboard address.")?;
                view.navigate(current).map_err(|_| {
                    "Could not reload the current dashboard. Open Connection Settings to retry."
                })?;
                Ok(true)
            }
        }
    }

    pub fn suspend_document(&self, app: &AppHandle, label: &str) {
        if let Ok(mut state) = self.routing.lock() {
            state.suspend_document(label);
        }
        if label == "main" {
            app.state::<crate::native_browser_bridge::NativeBrowserBridgeState>()
                .clear(app);
        }
    }

    pub fn authorized_source(&self, label: &str, url: &Url) -> bool {
        if label == SETTINGS {
            return local_settings_url(url);
        }
        if local_settings_url(url)
            && self.routing.lock().is_ok_and(|state| {
                state
                    .windows
                    .get(label)
                    .is_some_and(|route| route.recovery.is_some())
            })
        {
            return true;
        }
        self.routing.lock().is_ok_and(|state| {
            state
                .windows
                .get(label)
                .and_then(|route| route.document.as_ref())
                .is_some_and(|doc| {
                    doc.phase != NavigationPhase::Failed && matches_route(url, &doc.url)
                })
        })
    }

    fn profile_source(&self, view: &Webview) -> bool {
        view.url().is_ok_and(|url| local_settings_url(&url))
            && (view.label() == SETTINGS
                || self.routing.lock().is_ok_and(|state| {
                    state
                        .windows
                        .get(view.label())
                        .is_some_and(|route| route.recovery.is_some())
                }))
    }

    pub fn prepare_document(
        &self,
        app: &AppHandle,
        label: &str,
        target_id: &str,
        url: &Url,
    ) -> Result<DocumentRegistration, String> {
        if !crate::external_browser_url_allowed(url) {
            return Err("Invalid Gateway dashboard address.".into());
        }
        let origin = url.origin().ascii_serialization();
        let grant = {
            let state = self.routing.lock().map_err(|_| STALE)?;
            !state.granted.contains(&(label.to_string(), origin.clone()))
        };
        if grant {
            app.add_capability(
                CapabilityBuilder::new(format!("gateways-{}", uuid::Uuid::new_v4()))
                    .local(false)
                    .remote(format!("{origin}/*"))
                    .webview(label)
                    .permission("allow-gateway-request"),
            )
            .map_err(|_| "Could not enable Gateway selection in this window.")?;
            self.routing
                .lock()
                .map_err(|_| STALE)?
                .granted
                .insert((label.to_string(), origin));
        }
        let lifetime = uuid::Uuid::new_v4().to_string();
        let profile_revision = if target_id == PRIMARY
            || self
                .routing
                .lock()
                .map_err(|_| STALE)?
                .discovered
                .contains_key(target_id)
        {
            None
        } else {
            Some(self.profiles.get(target_id)?.revision)
        };
        #[cfg(target_os = "windows")]
        let browser_data = if isolated_browser_document(label, target_id) {
            let parent = app
                .path()
                .app_cache_dir()
                .map_err(|_| "Could not locate private Gateway browser storage.")?
                .join("gateway-webviews");
            Some(TemporaryBrowserData::create(
                &parent,
                Arc::clone(&self.browser_cleanup),
            )?)
        } else {
            None
        };
        {
            let mut state = self.routing.lock().map_err(|_| STALE)?;
            let primary_generation = (target_id == PRIMARY).then_some(state.primary_generation);
            let route = state.windows.entry(label.to_string()).or_default();
            let completion = route
                .pending
                .as_ref()
                .filter(|pending| {
                    pending.intent.target == target_id && pending.action == PendingAction::Switch
                })
                .map(|pending| pending.completion)
                .or_else(|| {
                    (route.target == target_id)
                        .then(|| route.document.as_ref().and_then(|doc| doc.completion))
                        .flatten()
                })
                .unwrap_or_default();
            route.generation = route.generation.wrapping_add(1);
            route.pending = None;
            route.target = target_id.to_string();
            route.primary_generation = primary_generation;
            route.recovery = None;
            route.document = Some(Document {
                lifetime: lifetime.clone(),
                nonce: None,
                url: url.clone(),
                phase: NavigationPhase::Preparing,
                navigation: 0,
                native_navigation: None,
                queued_url: Some(url.clone()),
                completion: Some(completion),
                profile_revision,
                #[cfg(target_os = "windows")]
                _browser_data: browser_data.clone(),
            });
        }
        let config = json!({ "origin":url.origin().ascii_serialization(), "base":url.path().trim_end_matches('/'), "snapshot":self.snapshot(label) });
        Ok(DocumentRegistration {
            app: app.clone(),
            label: label.to_string(),
            script: format!(
                "{}\n({})({config});",
                include_str!("../../ui/gateway-notice.js"),
                include_str!("../../ui/gateway-switch.js")
            ),
            lifetime,
            #[cfg(target_os = "windows")]
            browser_data,
        })
    }

    pub fn page_load(&self, webview: Webview, lifetime: &str, url: &Url, started: bool) {
        if !started || url.as_str() == "about:blank" {
            return;
        }
        let current = self.routing.lock().is_ok_and(|mut state| {
            let Some(doc) = state
                .windows
                .get_mut(webview.label())
                .and_then(|route| route.document.as_mut())
            else {
                return false;
            };
            if doc.lifetime != lifetime || doc.phase != NavigationPhase::Active {
                return false;
            }
            doc.nonce = None;
            true
        });
        if current {
            crate::window_chrome::loading(&webview);
        }
    }

    pub fn navigate_document(&self, view: &Webview, url: Url) -> Result<bool, String> {
        let queued = {
            let mut state = self.routing.lock().map_err(|_| STALE)?;
            let Some(doc) = state
                .windows
                .get_mut(view.label())
                .and_then(|route| route.document.as_mut())
            else {
                return Ok(false);
            };
            if doc.phase == NavigationPhase::Preparing {
                doc.queued_url = Some(url.clone());
                true
            } else {
                false
            }
        };
        if !queued {
            view.navigate(url)
                .map_err(|_| "Could not navigate the Gateway document.")?;
        }
        Ok(true)
    }

    fn remember_now(&self, id: Option<&str>) -> Result<(), String> {
        let mut state = self.routing.lock().map_err(|_| STALE)?;
        state.selection_sequence = state.selection_sequence.wrapping_add(1);
        state.selection_target = Some(id.unwrap_or(PRIMARY).to_string());
        drop(state);
        self.profiles.remember(id)
    }

    fn authorize(&self, webview: &Webview, token: &str) -> Result<DocumentAuthority, String> {
        let url = webview.url().map_err(|_| STALE)?;
        let state = self.routing.lock().map_err(|_| STALE)?;
        let doc = state
            .windows
            .get(webview.label())
            .and_then(|route| route.document.as_ref())
            .ok_or(STALE)?;
        if doc.nonce.as_deref() != Some(token) || !matches_route(&url, &doc.url) {
            return Err(STALE.into());
        }
        Ok(DocumentAuthority {
            label: webview.label().to_string(),
            lifetime: doc.lifetime.clone(),
            nonce: token.to_string(),
        })
    }

    fn ready_document(&self, app: &AppHandle, label: &str) -> bool {
        let token = self.routing.lock().ok().and_then(|state| {
            state
                .windows
                .get(label)
                .and_then(|route| route.document.as_ref())
                .and_then(|doc| doc.nonce.clone())
        });
        let Some(token) = token else {
            return false;
        };
        app.get_webview(label)
            .is_some_and(|view| self.authorize(&view, &token).is_ok())
    }

    pub fn closed(&self, app: &AppHandle, label: &str) {
        let retired = self
            .routing
            .lock()
            .ok()
            .and_then(|mut state| {
                state.retire_initial_document(label);
                state.windows.remove(label)
            })
            .and_then(|route| route.tunnel);
        retire_tunnel(app, retired);
    }

    pub fn cancel_pending(&self, app: &AppHandle, label: &str) {
        if let Ok(mut state) = self.routing.lock() {
            if label == "main" {
                state.explicit_selection();
            }
            state.cancel(label);
        }
        schedule_primary_refresh(app, label);
    }

    fn commit_tunnel(
        &self,
        app: &AppHandle,
        label: &str,
        tunnel: Option<SshTunnel>,
    ) -> Result<(), String> {
        let transferred = {
            let mut state = self.routing.lock().map_err(|_| STALE)?;
            match state.windows.get_mut(label) {
                Some(route) => Ok(std::mem::replace(&mut route.tunnel, tunnel)),
                None => Err(tunnel),
            }
        };
        match transferred {
            Ok(retired) => {
                retire_tunnel(app, retired);
                Ok(())
            }
            Err(unpublished) => {
                retire_tunnel(app, unpublished);
                Err(STALE.into())
            }
        }
    }

    pub fn shutdown(&self, app: &AppHandle) {
        #[cfg(target_os = "windows")]
        let isolated = self
            .routing
            .lock()
            .map(|state| {
                state
                    .windows
                    .iter()
                    .filter(|(_, route)| {
                        route
                            .document
                            .as_ref()
                            .is_some_and(|document| document._browser_data.is_some())
                    })
                    .map(|(label, _)| label.clone())
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        let retired = if let Ok(mut state) = self.routing.lock() {
            state.closing = true;
            std::mem::take(&mut state.windows)
                .into_values()
                .filter_map(|route| route.tunnel)
                .collect::<Vec<_>>()
        } else {
            Vec::new()
        };
        for tunnel in retired {
            retire_tunnel(app, Some(tunnel));
        }
        #[cfg(target_os = "windows")]
        for label in isolated {
            if let Some(view) = app.get_webview(&label) {
                let _ = view.close();
            }
        }
    }

    pub fn wait_closed(&self) {
        if let Ok(mut state) = self.routing.lock() {
            while state.preparing > 0 {
                let Ok(next) = self.idle.wait(state) else {
                    return;
                };
                state = next;
            }
        }
        #[cfg(target_os = "windows")]
        self.browser_cleanup.wait();
    }

    fn snapshot(&self, label: &str) -> Value {
        let profiles = self.profiles.list().unwrap_or_default();
        let Ok(state) = self.routing.lock() else {
            return json!({"gateways":[],"currentId":PRIMARY});
        };
        let mut gateways = vec![
            json!({"id":PRIMARY,"name":"Primary Gateway","kind":state.primary_kind(),"isPrimary":true,"canPromote":false,"health":"unknown"}),
        ];
        gateways.extend(profiles.into_iter().map(|profile| json!({"id":profile.id,"name":profile.name,"kind":"remote","isPrimary":false,"canPromote":profile.has_token,"health":"unknown"})));
        gateways.extend(state.discovered.iter().map(|(id,(name,_))| json!({"id":id,"name":name,"kind":"remote","isPrimary":false,"canPromote":false,"health":"unknown"})));
        let current = state
            .windows
            .get(label)
            .map(|route| route.target.as_str())
            .filter(|id| !id.is_empty())
            .unwrap_or(PRIMARY);
        json!({"gateways":gateways,"currentId":current})
    }

    pub fn publish(&self, app: &AppHandle) {
        let handle = app.clone();
        let _ = app
            .run_on_main_thread(move || handle.state::<GatewayWindows>().publish_current(&handle));
    }

    fn publish_current(&self, app: &AppHandle) {
        let documents = self
            .routing
            .lock()
            .map(|state| {
                state
                    .windows
                    .iter()
                    .filter_map(|(label, route)| {
                        route
                            .document
                            .as_ref()
                            .filter(|doc| doc.nonce.is_some())
                            .map(|doc| (label.clone(), doc.clone()))
                    })
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        for (label, doc) in documents {
            if let Some(view) = app.get_webview(&label) {
                let snapshot = self.snapshot(&label);
                let _ = view.eval(scoped_script(&doc, &format!("window.dispatchEvent(new CustomEvent('openclaw:native-gateways-changed',{{detail:{snapshot}}}));")));
            }
        }
        if let Ok(menus) = self.menus.lock() {
            for menu in menus.iter() {
                let _ = fill_menu(app, menu, &self.snapshot("main"));
            }
        }
    }
}

// Route publication and catalog changes run on the UI thread. Preparations may
// await SSH, but they must reacquire the live intent and profile revision there.
async fn on_main<T: Send + 'static>(
    app: &AppHandle,
    action: impl FnOnce(&AppHandle) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    let handle = app.clone();
    app.run_on_main_thread(move || {
        let _ = tx.send(action(&handle));
    })
    .map_err(|_| STALE)?;
    rx.await.map_err(|_| STALE)?
}

struct Prepared {
    route: Route,
    profile: Option<SavedGateway>,
    primary_generation: Option<u64>,
    tunnel: Option<SshTunnel>,
}

struct WindowWork(AppHandle);

impl WindowWork {
    fn begin(app: &AppHandle) -> Result<Self, String> {
        let owner = app.state::<GatewayWindows>();
        let mut state = owner.routing.lock().map_err(|_| STALE)?;
        if state.closing {
            return Err(STALE.into());
        }
        state.preparing += 1;
        Ok(Self(app.clone()))
    }
}

fn retire_tunnel(app: &AppHandle, tunnel: Option<SshTunnel>) {
    let Some(tunnel) = tunnel else {
        return;
    };
    let owner = app.state::<GatewayWindows>();
    if let Ok(mut state) = owner.routing.lock() {
        state.preparing += 1;
    }
    let work = WindowWork(app.clone());
    tauri::async_runtime::spawn_blocking(move || {
        let _work = work;
        drop(tunnel);
    });
}

impl Drop for WindowWork {
    fn drop(&mut self) {
        let owner = self.0.state::<GatewayWindows>();
        if let Ok(mut state) = owner.routing.lock() {
            state.preparing -= 1;
            owner.idle.notify_all();
        };
    }
}

fn prepare(app: &AppHandle, intent: &Intent) -> Result<Prepared, String> {
    let owner = app.state::<GatewayWindows>();
    if !owner.routing.lock().map_err(|_| STALE)?.current(intent) {
        return Err(STALE.into());
    }
    if intent.target == PRIMARY {
        let state = owner.routing.lock().map_err(|_| STALE)?;
        return Ok(Prepared {
            route: state
                .primary
                .clone()
                .ok_or("The Primary Gateway is not ready yet.")?,
            profile: None,
            primary_generation: Some(state.primary_generation),
            tunnel: None,
        });
    }
    if let Some((_, url)) = owner
        .routing
        .lock()
        .map_err(|_| STALE)?
        .discovered
        .get(&intent.target)
    {
        return Ok(Prepared {
            route: Route {
                url: url.clone(),
                auth_script: None,
            },
            profile: None,
            primary_generation: None,
            tunnel: None,
        });
    }
    let profile = owner.profiles.get(&intent.target)?;
    let request = &profile.request;
    remote_gateway::validate_request(request)?;
    let (tunnel, gateway) = if request.transport == "ssh" {
        let (tunnel, url) = remote_gateway::start_tunnel(request, None, || {
            !owner
                .routing
                .lock()
                .is_ok_and(|state| state.current(intent))
        })?;
        (Some(tunnel), url)
    } else {
        (
            None,
            remote_gateway::normalize_gateway_url(
                request.url.as_deref().ok_or("Enter the Gateway URL.")?,
            )?,
        )
    };
    let url = remote_gateway::dashboard_url(&gateway)?;
    let auth_script = Some(crate::native_auth_initialization_script(
        &url, &gateway, request,
    )?);
    Ok(Prepared {
        route: Route { url, auth_script },
        profile: Some(profile),
        primary_generation: None,
        tunnel,
    })
}

fn revision_current(owner: &GatewayWindows, profile: Option<&SavedGateway>) -> bool {
    profile.is_none_or(|saved| {
        owner
            .profiles
            .get(&saved.id)
            .is_ok_and(|current| current.revision == saved.revision)
    })
}

fn source_current(app: &AppHandle, owner: &GatewayWindows, intent: &Intent) -> bool {
    intent.source_url.as_ref().is_none_or(|expected| {
        app.get_webview(&intent.label)
            .is_some_and(|view| view.url().is_ok_and(|url| url == *expected))
    }) && intent.source.as_ref().is_none_or(|source| {
        app.get_webview(&source.label).is_some_and(|view| {
            owner
                .authorize(&view, &source.nonce)
                .is_ok_and(|authority| authority.lifetime == source.lifetime)
        })
    })
}

async fn select(
    app: AppHandle,
    label: String,
    target: String,
    source: Option<DocumentAuthority>,
    remember: bool,
) -> Result<(), String> {
    let intent = on_main(&app, move |app| {
        let owner = app.state::<GatewayWindows>();
        if app.get_window(&label).is_none() {
            return Err(STALE.into());
        }
        if let Some(source) = &source {
            let view = app.get_webview(&source.label).ok_or(STALE)?;
            if owner.authorize(&view, &source.nonce)?.lifetime != source.lifetime {
                return Err(STALE.into());
            }
        }
        if remember || source.is_some() {
            owner
                .routing
                .lock()
                .map_err(|_| STALE)?
                .explicit_selection();
        }
        let disposition = owner
            .routing
            .lock()
            .map_err(|_| STALE)?
            .admit_selection(&label, &target, !remember, remember);
        match disposition {
            SelectionDisposition::Pending => return Ok(None),
            SelectionDisposition::Reuse => {
                if let Err(error) = owner.remember_now(if target.starts_with("manual-") {
                    Some(&target)
                } else {
                    None
                }) {
                    show_error(app, &label, &error);
                }
                return Ok(None);
            }
            SelectionDisposition::Replace => {}
        }
        let mut state = owner.routing.lock().map_err(|_| STALE)?;
        let intent = state.begin(&label, &target, source);
        state.upgrade_selection(&intent, remember);
        Ok(Some(intent))
    })
    .await?;
    match intent {
        Some(intent) => select_intent(app, intent).await,
        None => Ok(()),
    }
}

async fn select_intent(app: AppHandle, intent: Intent) -> Result<(), String> {
    let preparing_app = app.clone();
    let preparing_intent = intent.clone();
    let _work = WindowWork::begin(&app)?;
    let prepared =
        tauri::async_runtime::spawn_blocking(move || prepare(&preparing_app, &preparing_intent))
            .await
            .map_err(|_| "Could not prepare the Gateway window.".to_string())
            .and_then(|result| result);
    let mut prepared = match prepared {
        Ok(prepared) => prepared,
        Err(error) => {
            report_selection_failure(&app, &intent, &error).await;
            cancel_intent(&app, &intent);
            return Err(error);
        }
    };
    let pending = Arc::new(Mutex::new(prepared.tunnel.take()));
    let publishing = Arc::clone(&pending);
    let cleanup = intent.clone();
    let result = on_main(&app, move |app| {
        let owner = app.state::<GatewayWindows>();
        let current = {
            let state = owner.routing.lock().map_err(|_| STALE)?;
            state.current(&intent)
                && prepared
                    .primary_generation
                    .is_none_or(|generation| generation == state.primary_generation)
        };
        if !current
            || !source_current(app, &owner, &intent)
            || !revision_current(&owner, prepared.profile.as_ref())
            || app.get_window(&intent.label).is_none()
        {
            return Err(STALE.into());
        }
        if intent.label == "main" {
            crate::replace_dashboard_webview(
                app,
                prepared.route.url,
                prepared.route.auth_script,
                &intent.target,
            )?
        } else {
            replace_auxiliary(app, &intent.label, &intent.target, prepared.route)?
        };
        owner.commit_tunnel(
            app,
            &intent.label,
            publishing.lock().map_err(|_| STALE)?.take(),
        )?;
        owner.publish(app);
        Ok(())
    })
    .await;
    let leftover = pending.lock().map_err(|_| STALE)?.take();
    retire_tunnel(&app, leftover);
    if result.is_err() {
        if let Err(error) = &result {
            report_selection_failure(&app, &cleanup, error).await;
        }
        cancel_intent(&app, &cleanup);
    }
    result
}

fn cancel_intent(app: &AppHandle, intent: &Intent) {
    let owner = app.state::<GatewayWindows>();
    if let Ok(mut state) = owner.routing.lock() {
        state.cancel_intent(intent);
    };
    schedule_primary_refresh(app, &intent.label);
    let failed = owner.routing.lock().ok().and_then(|state| {
        state
            .windows
            .get(&intent.label)
            .and_then(|route| route.document.as_ref())
            .filter(|doc| doc.phase == NavigationPhase::Failed)
            .and_then(|doc| state.document_event(&intent.label, &doc.lifetime))
    });
    if let Some(event) = failed {
        schedule_document_failure(app, event);
    }
}

fn schedule_document_success(app: &AppHandle, event: DocumentEvent, ready: DocumentReady) {
    let app = app.clone();
    // Native callbacks can run inside WebView construction or navigation.
    // Finish on a later main-thread turn after the native callback returns.
    tauri::async_runtime::spawn(async move {
        let _ = on_main(&app, move |app| finish_document(app, event, ready)).await;
    });
}

fn finish_document(
    app: &AppHandle,
    event: DocumentEvent,
    ready: DocumentReady,
) -> Result<(), String> {
    let owner = app.state::<GatewayWindows>();
    let (target, profile_revision) = {
        let state = owner.routing.lock().map_err(|_| STALE)?;
        if !state.document_event_current(&event) {
            return Ok(());
        }
        let route = &state.windows[&event.label];
        (
            route.target.clone(),
            route
                .document
                .as_ref()
                .and_then(|doc| doc.profile_revision.clone()),
        )
    };
    if profile_revision.as_ref().is_some_and(|expected| {
        !owner
            .profiles
            .get(&target)
            .is_ok_and(|profile| profile.revision == *expected)
    }) {
        let failed =
            owner.routing.lock().ok().and_then(|mut state| {
                state.document_failed(&event.label, &event.document_lifetime)
            });
        if let Some(failed) = failed {
            schedule_document_failure(app, failed);
        }
        return Ok(());
    }
    let webview = app.get_webview(&event.label).ok_or(STALE)?;
    let url = webview.url().map_err(|_| STALE)?;
    let completed = owner
        .routing
        .lock()
        .map_err(|_| STALE)?
        .complete_document(&event, &url);
    let Some((doc, completion, notice)) = completed else {
        return Ok(());
    };
    let sequence = owner.routing.lock().map_err(|_| STALE)?.selection_sequence;
    if completion.remembers(sequence) {
        if let Err(error) = owner
            .profiles
            .remember(profile_revision.is_some().then_some(target.as_str()))
        {
            show_error(app, &event.label, &error);
        }
    }
    let detail = json!({"token":doc.nonce,"snapshot":owner.snapshot(&event.label)});
    let notice = notice
        .map(|message| notice_script(&message))
        .unwrap_or_default();
    let ready_script = format!("window.dispatchEvent(new CustomEvent('openclaw:gateway-ready',{{detail:{detail}}}));{notice}");
    let _ = webview.eval(scoped_script(&doc, &ready_script));
    if completion.presents(sequence) {
        let _ = webview.window().show();
        let _ = webview.window().set_focus();
    }
    ready(&webview);
    owner.publish(app);
    if event.label == "main" {
        startup(app);
    }
    Ok(())
}

fn schedule_document_failure(app: &AppHandle, event: DocumentEvent) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let _ = on_main(&app, move |app| {
            let owner = app.state::<GatewayWindows>();
            let recovery = owner
                .routing
                .lock()
                .map_err(|_| STALE)?
                .begin_document_recovery(&event);
            let Some((intent, present)) = recovery else {
                return Ok(());
            };
            if let Some(view) = app.get_webview(&event.label) {
                crate::window_chrome::loading(&view);
            }
            if intent.target == PRIMARY {
                owner.commit_tunnel(app, &event.label, None)?;
                let result =
                    crate::recover_primary_navigation(app, &event.label, LOAD_FAILURE, present);
                owner
                    .routing
                    .lock()
                    .map_err(|_| STALE)?
                    .cancel_intent(&intent);
                result?;
            } else {
                open_profile_recovery(app, &intent, LOAD_FAILURE)?;
                if present {
                    if let Some(window) = app.get_window(&event.label) {
                        let _ = window.show();
                        let _ = window.set_focus();
                    }
                }
            }
            Ok(())
        })
        .await;
    });
}

async fn report_selection_failure(app: &AppHandle, intent: &Intent, error: &str) {
    let intent = intent.clone();
    let error = error.to_string();
    let _ = on_main(app, move |app| {
        let owner = app.state::<GatewayWindows>();
        {
            let mut state = owner.routing.lock().map_err(|_| STALE)?;
            if !state.current(&intent) {
                return Ok(());
            }
            let route = state.windows.get_mut(&intent.label).ok_or(STALE)?;
            if route.recovery.is_none() {
                return Ok(());
            }
            route.notice = Some(error);
        }
        publish_recovery(app, &intent.label);
        Ok(())
    })
    .await;
}

fn publish_recovery(app: &AppHandle, label: &str) {
    let owner = app.state::<GatewayWindows>();
    let config=owner.routing.lock().ok().and_then(|state|state.windows.get(label).filter(|route|route.recovery.is_some()).map(|route|json!({
        "id":(route.target!=PRIMARY).then_some(&route.target),"error":route.notice.as_deref().unwrap_or("")
    })));
    let Some(config) = config else {
        return;
    };
    let Some(view) = app.get_webview(label) else {
        return;
    };
    let Ok(url) = view.url() else {
        return;
    };
    if !local_settings_url(&url) {
        return;
    }
    let expected = json!(url.as_str());
    let _=view.eval(format!("if(window===window.top && location.href==={expected}) {{window.__OPENCLAW_GATEWAY_RECOVERY__={config};window.dispatchEvent(new CustomEvent('openclaw:gateway-recovery',{{detail:{config}}}));}}"));
}

fn notify_profile_view(view: &Webview, detail: &Value) {
    let app = view.app_handle();
    if !app.state::<GatewayWindows>().profile_source(view) {
        return;
    }
    let Ok(url) = view.url() else {
        return;
    };
    let expected = json!(url.as_str());
    let _=view.eval(format!("if(window===window.top && location.href==={expected}) window.dispatchEvent(new CustomEvent('openclaw:gateway-profiles-changed',{{detail:{detail}}}));"));
}

fn publish_profile_catalog(
    app: &AppHandle,
    source: &str,
    previous_id: Option<&str>,
    id: Option<&str>,
) {
    let mut detail = serde_json::Map::new();
    if let Some(id) = previous_id {
        detail.insert("previousId".into(), json!(id));
    }
    if let Some(id) = id {
        detail.insert("id".into(), json!(id));
    }
    let detail = Value::Object(detail);
    let owner = app.state::<GatewayWindows>();
    let mut labels = vec![SETTINGS.to_string()];
    if let Ok(state) = owner.routing.lock() {
        labels.extend(
            state
                .windows
                .iter()
                .filter(|(_, route)| route.recovery.is_some())
                .map(|(label, _)| label.clone()),
        );
    }
    for label in labels {
        if label != source {
            if let Some(view) = app.get_webview(&label) {
                notify_profile_view(&view, &detail);
            }
        }
    }
}

fn open_profile_recovery(app: &AppHandle, intent: &Intent, error: &str) -> Result<(), String> {
    let owner = app.state::<GatewayWindows>();
    let label = &intent.label;
    let target = owner
        .profiles
        .list()
        .ok()
        .and_then(|profiles| {
            profiles
                .into_iter()
                .find(|profile| profile.id == intent.target)
        })
        .map(|profile| profile.id);
    let window = app.get_window(label).ok_or(STALE)?;
    let reuse = owner
        .routing
        .lock()
        .map_err(|_| STALE)?
        .windows
        .get(label)
        .is_some_and(|route| route.recovery.is_some())
        && app
            .get_webview(label)
            .is_some_and(|view| view.url().is_ok_and(|url| local_settings_url(&url)));
    let retired = owner
        .routing
        .lock()
        .map_err(|_| STALE)?
        .enter_profile_recovery(intent, target.as_deref())?;
    retire_tunnel(app, retired);
    if let Some(route) = owner
        .routing
        .lock()
        .map_err(|_| STALE)?
        .windows
        .get_mut(label)
    {
        route.notice = Some(error.to_string());
    }
    if reuse {
        publish_recovery(app, label);
        return Ok(());
    }
    if label == "main" {
        app.state::<crate::native_browser_bridge::NativeBrowserBridgeState>()
            .clear(app);
    }
    if let Some(previous) = app.get_webview(label) {
        crate::window_chrome::loading(&previous);
        crate::native_browser_platform::detach_surface(&previous)?;
        previous
            .close()
            .map_err(|_| "Could not close the retired Gateway document.")?;
    }
    let capability = CapabilityBuilder::new(format!("gateway-recovery-{}", uuid::Uuid::new_v4()))
        .local(true)
        .webview(label)
        .permission("allow-gateway-profile-request")
        .permission("allow-window-chrome-request");
    #[cfg(not(target_os = "macos"))]
    let capability = capability.permission("allow-window-chrome-drag");
    app.add_capability(capability)
        .map_err(|_| "Could not enable Gateway recovery controls.")?;
    let config = json!({"id":target,"error":error});
    let script = format!(
        "{}\nif(window===window.top) window.__OPENCLAW_GATEWAY_RECOVERY__={config};",
        crate::window_chrome::initialization_script(None, false)
    );
    let recovery_label = label.to_string();
    let builder = WebviewBuilder::new(label, WebviewUrl::App("gateways.html".into()))
        .initialization_script(script)
        .on_navigation(local_settings_url)
        .on_page_load(move |view, payload| {
            if matches!(payload.event(), PageLoadEvent::Finished) {
                publish_recovery(view.app_handle(), &recovery_label);
            }
        })
        .auto_resize();
    let size = window
        .inner_size()
        .map_err(|_| "Could not measure the recovery window.")?;
    let view=window.add_child(builder,LogicalPosition::new(0,0),size).map_err(|_|"Could not open Gateway recovery. Use Manage Gateways from the native menu to fix this connection.")?;
    #[cfg(target_os = "macos")]
    crate::window_chrome_macos::install_webview(&view)
        .map_err(|_| "Could not prepare recovery window controls.")?;
    crate::window_chrome::observe_history(&view);
    Ok(())
}

fn schedule_primary_refresh(app: &AppHandle, label: &str) {
    let app_handle = app.clone();
    let label = label.to_string();
    let _ = app.run_on_main_thread(move || {
        if let Err(error) = reconcile_primary(&app_handle, &label) {
            show_error(&app_handle, &label, &error);
        }
    });
}

fn reconcile_primary(app: &AppHandle, label: &str) -> Result<(), String> {
    let owner = app.state::<GatewayWindows>();
    let (route, document_url) = {
        let state = owner.routing.lock().map_err(|_| STALE)?;
        if !state.needs_primary_refresh(label) {
            return Ok(());
        }
        (
            state.primary.clone().ok_or(STALE)?,
            state
                .windows
                .get(label)
                .and_then(|route| route.document.as_ref())
                .map(|document| document.url.clone()),
        )
    };
    let current = app.get_webview(label).and_then(|view| view.url().ok());
    let allowed = current.is_some_and(|url| match &document_url {
        Some(expected) => matches_route(&url, expected),
        None => {
            label == "main"
                && app
                    .state::<crate::DesktopState>()
                    .main_window_has_local_url(&url)
                && !app
                    .state::<crate::DesktopState>()
                    .main_window_has_connection_settings_url(&url)
        }
    });
    if !allowed {
        return Ok(());
    }
    if label == "main" {
        crate::replace_dashboard_webview(app, route.url, route.auth_script, PRIMARY)?;
    } else {
        replace_auxiliary(app, label, PRIMARY, route)?;
    }
    owner.commit_tunnel(app, label, None)?;
    Ok(())
}

fn replace_auxiliary(
    app: &AppHandle,
    label: &str,
    target: &str,
    route: Route,
) -> Result<Webview, String> {
    let owner = app.state::<GatewayWindows>();
    let window = app.get_window(label).ok_or(STALE)?;
    if let Some(previous) = app.get_webview(label) {
        crate::window_chrome::loading(&previous);
        crate::native_browser_platform::detach_surface(&previous)?;
        previous
            .close()
            .map_err(|_| "Could not replace the Gateway dashboard.")?;
    }
    let size = window
        .inner_size()
        .map_err(|_| "Could not measure the Gateway window.")?;
    crate::window_chrome::grant(app, label, &route.url)?;
    let registration = owner.prepare_document(app, label, target, &route.url)?;
    let script = format!(
        "{}\n{}\n{}",
        route.auth_script.unwrap_or_default(),
        crate::window_chrome::initialization_script(Some(&route.url), false),
        registration.script
    );
    let browser_app = app.clone();
    let page_registration = registration.clone();
    let builder = registration
        .configure(WebviewBuilder::new(label, registration.initial_url()))
        .incognito(true)
        .initialization_script(script)
        .auto_resize()
        .on_new_window(move |url, _| {
            crate::open_external_browser(&browser_app, &url);
            NewWindowResponse::Deny
        })
        .on_page_load(move |view, payload| {
            page_registration.page_load(
                view,
                payload.url(),
                matches!(payload.event(), PageLoadEvent::Started),
            );
        });
    let view = window
        .add_child(builder, LogicalPosition::new(0, 0), size)
        .map_err(|_| "Could not open the Gateway dashboard.")?;
    #[cfg(target_os = "macos")]
    crate::window_chrome_macos::install_webview(&view)
        .map_err(|_| "Could not prepare Gateway window controls.")?;
    crate::window_chrome::observe_history(&view);
    registration.start(view.clone(), |_| {});
    Ok(view)
}

async fn open_window(
    app: AppHandle,
    target: String,
    reuse: bool,
    source: Option<DocumentAuthority>,
) -> Result<(), String> {
    let (label, intent, created) = on_main(&app, move |app| {
        let owner = app.state::<GatewayWindows>();
        if let Some(source) = &source {
            let view = app.get_webview(&source.label).ok_or(STALE)?;
            if owner.authorize(&view, &source.nonce)?.lifetime != source.lifetime {
                return Err(STALE.into());
            }
        }
        owner
            .routing
            .lock()
            .map_err(|_| STALE)?
            .explicit_selection();
        if reuse {
            let existing = owner
                .routing
                .lock()
                .map_err(|_| STALE)?
                .window_for_target(&target);
            if let Some(label) = existing {
                if let Some(window) = app.get_window(&label) {
                    let force = !owner.ready_document(app, &label);
                    let disposition = owner
                        .routing
                        .lock()
                        .map_err(|_| STALE)?
                        .admit_selection(&label, &target, force, true);
                    match disposition {
                        SelectionDisposition::Pending => return Ok((label, None, false)),
                        SelectionDisposition::Reuse => {
                            window
                                .show()
                                .map_err(|_| "Could not show the Gateway window.")?;
                            let _ = window.unminimize();
                            window
                                .set_focus()
                                .map_err(|_| "Could not focus the Gateway window.")?;
                            if let Err(error) =
                                owner.remember_now(if target.starts_with("manual-") {
                                    Some(&target)
                                } else {
                                    None
                                })
                            {
                                show_error(app, &label, &error);
                            }
                            return Ok((label, None, false));
                        }
                        SelectionDisposition::Replace => {
                            let mut state = owner.routing.lock().map_err(|_| STALE)?;
                            let intent = state.begin(&label, &target, source);
                            state.upgrade_selection(&intent, true);
                            return Ok((label, Some(intent), false));
                        }
                    }
                }
            }
        }
        let label = format!("gateway-{}", uuid::Uuid::new_v4());
        let name = if target == PRIMARY {
            "Primary Gateway".to_string()
        } else if let Ok(profile) = owner.profiles.get(&target) {
            profile.name
        } else {
            owner
                .routing
                .lock()
                .map_err(|_| STALE)?
                .discovered
                .get(&target)
                .map(|(name, _)| name.clone())
                .ok_or("That Gateway is no longer available.")?
        };
        create_gateway_window(app, &label, &name)?;
        let mut state = owner.routing.lock().map_err(|_| STALE)?;
        let intent = state.begin(&label, &target, source);
        state.upgrade_selection(&intent, true);
        Ok((label, Some(intent), true))
    })
    .await?;
    let Some(intent) = intent else {
        return Ok(());
    };
    let result = select_intent(app.clone(), intent).await;
    if created && result.is_err() {
        let _ = on_main(&app, move |app| {
            let owner = app.state::<GatewayWindows>();
            let unused = owner
                .routing
                .lock()
                .map_err(|_| STALE)?
                .windows
                .get(&label)
                .is_some_and(|route| {
                    route.document.is_none() && route.pending.is_none() && route.recovery.is_none()
                });
            if unused {
                owner.closed(app, &label);
                if let Some(window) = app.get_window(&label) {
                    let _ = window.close();
                }
            }
            Ok(())
        })
        .await;
    }
    result
}

fn create_gateway_window(app: &AppHandle, label: &str, name: &str) -> Result<(), String> {
    let window = WindowBuilder::new(app, label)
        .title(format!("{name} — {}", app.package_info().name))
        .inner_size(1100.0, 780.0)
        .min_inner_size(720.0, 520.0)
        .visible(false)
        .build()
        .map_err(|_| "Could not create the Gateway window.")?;
    crate::window_chrome::install(&window)
        .map_err(|_| "Could not prepare Gateway window controls.".to_string())
}

#[cfg(target_os = "linux")]
pub(crate) fn show_primary_url(app: &AppHandle, target: Url) -> Result<(), String> {
    show_primary_route(app, Some(target))
}

pub(crate) fn show_primary(app: &AppHandle) -> Result<(), String> {
    let owner = app.state::<GatewayWindows>();
    let available = {
        let state = owner.routing.lock().map_err(|_| STALE)?;
        if state.closing {
            return Err(STALE.into());
        }
        state.primary.is_some()
    };
    if !available {
        crate::tray::open_dashboard(app);
        return Ok(());
    }
    show_primary_route(app, None)
}

fn show_primary_route(app: &AppHandle, mut target: Option<Url>) -> Result<(), String> {
    let owner = app.state::<GatewayWindows>();
    let (primary, generation, existing) = {
        let mut state = owner.routing.lock().map_err(|_| STALE)?;
        if state.closing {
            return Err(STALE.into());
        }
        let primary = state
            .primary
            .clone()
            .ok_or("The Primary Gateway is not ready yet.")?;
        if target
            .as_ref()
            .is_some_and(|target| !matches_route(target, &primary.url))
        {
            return Err("This session no longer belongs to the Primary Gateway.".into());
        }
        state.explicit_selection();
        (primary, state.primary_generation, state.primary_window())
    };
    let (label, replace, created) =
        match existing.filter(|(label, _)| app.get_window(label).is_some()) {
            Some((label, replace)) => {
                let replace = replace || !owner.ready_document(app, &label);
                (label, replace, false)
            }
            None => {
                let label = format!("gateway-{}", uuid::Uuid::new_v4());
                create_gateway_window(app, &label, "Primary Gateway")?;
                (label, true, true)
            }
        };
    let result: Result<(), String> = (|| {
        owner.cancel_pending(app, &label);
        if replace && primary.auth_script.is_none() {
            if let Some(target) = &mut target {
                // Local dashboard bootstrap consumes the CLI's #token. A new
                // private window must receive it on its first session page.
                if target.fragment().is_none() {
                    target.set_fragment(primary.url.fragment());
                }
            }
        }
        let view = if replace || app.get_webview(&label).is_none() {
            if label == "main" {
                crate::replace_dashboard_webview(app, primary.url, primary.auth_script, PRIMARY)?
            } else {
                replace_auxiliary(app, &label, PRIMARY, primary)?
            }
        } else {
            app.get_webview(&label).ok_or(STALE)?
        };
        owner.commit_tunnel(app, &label, None)?;
        {
            let state = owner.routing.lock().map_err(|_| STALE)?;
            if state.closing
                || state.primary_generation != generation
                || !state.windows.get(&label).is_some_and(|route| {
                    route.target == PRIMARY && route.primary_generation == Some(generation)
                })
            {
                return Err(STALE.into());
            }
        }
        if let Some(target) = target {
            if !view.url().is_ok_and(|url| url == target) {
                owner.navigate_document(&view, target)?;
            }
        }
        view.window()
            .show()
            .map_err(|_| "Could not show the Primary Gateway window.")?;
        let _ = view.window().unminimize();
        view.window()
            .set_focus()
            .map_err(|_| "Could not focus the Primary Gateway window.")?;
        owner.publish(app);
        Ok(())
    })();
    if let Err(error) = &result {
        if created {
            owner.closed(app, &label);
            if let Some(window) = app.get_window(&label) {
                let _ = window.close();
            }
        }
        show_error(app, "main", error);
    }
    result
}

pub(crate) fn restore_selected_main(app: &AppHandle) -> Result<(), String> {
    let view = app.get_webview("main").ok_or(STALE)?;
    let url = view.url().map_err(|_| STALE)?;
    if !app
        .state::<crate::DesktopState>()
        .main_window_has_connection_settings_url(&url)
    {
        return Err("The connection settings document changed.".into());
    }
    let intent = app
        .state::<GatewayWindows>()
        .routing
        .lock()
        .map_err(|_| STALE)?
        .reserve_saved_restore(url.clone());
    let Some(intent) = intent else {
        return Ok(());
    };
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(error) = select_intent(app.clone(), intent).await {
            if error != STALE {
                if let Some(view) = app.get_webview("main") {
                    let expected = json!(url.as_str());
                    let notice = notice_script(&error);
                    let _ = view.eval(format!(
                        "if (window === window.top && location.href === {expected}) {{{notice}}}"
                    ));
                }
            }
        }
    });
    Ok(())
}

pub(crate) async fn open_discovered(app: AppHandle, url: Url, name: String) -> Result<(), String> {
    let id = crate::discovery::gateway_window_label(&url);
    let target = id.clone();
    on_main(&app, move |app| {
        app.state::<GatewayWindows>()
            .routing
            .lock()
            .map_err(|_| STALE)?
            .discovered
            .insert(id, (name, url));
        Ok(())
    })
    .await?;
    open_window(app, target, true, None).await
}

fn local_settings_url(url: &Url) -> bool {
    ((url.scheme() == "tauri" && url.host_str() == Some("localhost"))
        || (matches!(url.scheme(), "http" | "https") && url.host_str() == Some("tauri.localhost")))
        && url.path() == "/gateways.html"
}

pub(crate) fn open_settings(app: &AppHandle) -> Result<(), String> {
    app.state::<GatewayWindows>()
        .routing
        .lock()
        .map_err(|_| STALE)?
        .explicit_selection();
    schedule_primary_refresh(app, "main");
    if let Some(window) = app.get_window(SETTINGS) {
        if let Some(view) = app.get_webview(SETTINGS) {
            notify_profile_view(&view, &json!({}));
        }
        window
            .show()
            .map_err(|_| "Could not show Gateway settings.")?;
        return window
            .set_focus()
            .map_err(|_| "Could not focus Gateway settings.".into());
    }
    let window =
        tauri::WebviewWindowBuilder::new(app, SETTINGS, WebviewUrl::App("gateways.html".into()))
            .title(format!("Gateways — {}", app.package_info().name))
            .inner_size(800.0, 680.0)
            .min_inner_size(560.0, 480.0)
            .initialization_script(crate::window_chrome::initialization_script(None, false))
            .on_navigation(local_settings_url)
            .build()
            .map_err(|_| "Could not open Gateway settings.")?;
    crate::window_chrome::install(&window.as_ref().window())
        .map_err(|_| "Could not prepare Gateway settings controls.")?;
    #[cfg(target_os = "macos")]
    crate::window_chrome_macos::install_webview(window.as_ref())
        .map_err(|_| "Could not prepare Gateway settings controls.")?;
    Ok(())
}

#[tauri::command]
pub(crate) async fn gateway_request(
    app: AppHandle,
    webview: Webview,
    message: Value,
    token: String,
) -> Result<Value, String> {
    let source = app.state::<GatewayWindows>().authorize(&webview, &token)?;
    let label = webview.label().to_string();
    let action = message
        .get("type")
        .and_then(Value::as_str)
        .ok_or("Missing Gateway action.")?;
    let target = message
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or(PRIMARY)
        .to_string();
    match action {
        "select" | "reconnect" => {
            let remember = action == "select";
            select(app, label, target, Some(source), remember).await?;
        }
        "open-window" => {
            open_window(app, target, false, Some(source)).await?;
        }
        "reconnect-cancel" => {
            on_main(&app, move |app| {
                let view = app.get_webview(&label).ok_or(STALE)?;
                let owner = app.state::<GatewayWindows>();
                owner.authorize(&view, &source.nonce)?;
                owner.cancel_pending(app, &label);
                Ok(())
            })
            .await?
        }
        "open-settings" => {
            on_main(&app, move |app| {
                let view = app.get_webview(&label).ok_or(STALE)?;
                app.state::<GatewayWindows>()
                    .authorize(&view, &source.nonce)?;
                open_settings(app)
            })
            .await?
        }
        "set-primary" => {
            let profile = app.state::<GatewayWindows>().profiles.get(&target)?;
            if profile
                .request
                .token
                .as_deref()
                .is_none_or(|token| token.trim().is_empty())
            {
                return Err("Only a Gateway with a saved token can be made Primary.".into());
            }
            let intent = on_main(&app, move |app| {
                let owner = app.state::<GatewayWindows>();
                let view = app.get_webview(&label).ok_or(STALE)?;
                owner.authorize(&view, &source.nonce)?;
                owner
                    .routing
                    .lock()
                    .map_err(|_| STALE)?
                    .explicit_selection();
                let intent = owner
                    .routing
                    .lock()
                    .map_err(|_| STALE)?
                    .begin_promotion(&label, &target, source);
                Ok(intent)
            })
            .await?;
            let guard = PromotionGuard {
                intent: intent.clone(),
                profile_id: profile.id.clone(),
                profile_revision: profile.revision.clone(),
            };
            let result = async {
                if !crate::confirm_gateway_primary(&app, &profile.name).await? {
                    return Ok(());
                }
                let confirmed = guard.clone();
                on_main(&app, move |app| {
                    if confirmed.current(app) {
                        Ok(())
                    } else {
                        Err(STALE.into())
                    }
                })
                .await?;
                crate::promote_gateway_profile(&app, profile.request, guard).await
            }
            .await;
            cancel_intent(&app, &intent);
            result?;
        }
        _ => return Err("Unknown Gateway action.".into()),
    }
    Ok(Value::Null)
}

#[tauri::command]
pub(crate) async fn gateway_profile_request(
    app: AppHandle,
    webview: Webview,
    message: Value,
) -> Result<Value, String> {
    if !app.state::<GatewayWindows>().profile_source(&webview) {
        return Err("Saved Gateways can only be managed from Gateway settings.".into());
    }
    let label = webview.label().to_string();
    let action = message
        .get("action")
        .and_then(Value::as_str)
        .ok_or("Missing saved Gateway action.")?
        .to_string();
    if action == "open" {
        let id = message
            .get("id")
            .and_then(Value::as_str)
            .ok_or("Choose a saved Gateway.")?
            .to_string();
        app.state::<GatewayWindows>().profiles.get(&id)?;
        if label == SETTINGS {
            open_window(app, id, false, None).await?;
        } else {
            let intent = on_main(&app, move |app| {
                let view = app.get_webview(&label).ok_or(STALE)?;
                let owner = app.state::<GatewayWindows>();
                if !owner.profile_source(&view) {
                    return Err(STALE.into());
                }
                let url = view.url().map_err(|_| STALE)?;
                let mut state = owner.routing.lock().map_err(|_| STALE)?;
                state.explicit_selection();
                let mut intent = state.begin(&label, &id, None);
                intent.source_url = Some(url);
                state.upgrade_selection(&intent, true);
                Ok(intent)
            })
            .await?;
            select_intent(app, intent).await?;
        }
        return Ok(Value::Null);
    }
    let (result, reconnects) = on_main(&app, move |app| {
        let view = app.get_webview(&label).ok_or(STALE)?;
        if !app.state::<GatewayWindows>().profile_source(&view) {
            return Err(STALE.into());
        }
        let owner = app.state::<GatewayWindows>();
        let id = message.get("id").and_then(Value::as_str);
        let mut affected = Vec::new();
        let mut replacement = None;
        let mut remember_edited = false;
        let result = match action.as_str() {
            "list" => {
                json!({"profiles":owner.profiles.list()?,"selectedId":owner.profiles.selected()?})
            }
            "save" => {
                let name = message
                    .get("name")
                    .and_then(Value::as_str)
                    .ok_or("Enter a Gateway name.")?;
                let request: RemoteGatewayRequest = serde_json::from_value(
                    message
                        .get("connection")
                        .cloned()
                        .ok_or("Enter a Gateway connection.")?,
                )
                .map_err(|_| "Invalid Gateway connection.")?;
                let selected_before = owner.profiles.selected()?;
                if let Some(id) = id {
                    let state = owner.routing.lock().map_err(|_| STALE)?;
                    remember_edited = state.remembers_edited_target(id)
                        || (selected_before.as_deref() == Some(id)
                            && state
                                .selection_target
                                .as_deref()
                                .is_none_or(|target| target == id));
                }
                let profile = owner.profiles.save(name, id, request)?;
                if remember_edited {
                    owner.routing.lock().map_err(|_| STALE)?.selection_target =
                        Some(profile.id.clone());
                }
                owner
                    .routing
                    .lock()
                    .map_err(|_| STALE)?
                    .explicit_selection();
                affected = owner
                    .routing
                    .lock()
                    .map_err(|_| STALE)?
                    .invalidate_profile(id.unwrap_or(&profile.id));
                replacement = Some(profile.id.clone());
                serde_json::to_value(profile)
                    .map_err(|_| "Could not read saved Gateway details.")?
            }
            "remove" => {
                let id = id.ok_or("Choose a saved Gateway.")?;
                owner.profiles.remove(id)?;
                owner
                    .routing
                    .lock()
                    .map_err(|_| STALE)?
                    .explicit_selection();
                affected = owner
                    .routing
                    .lock()
                    .map_err(|_| STALE)?
                    .invalidate_profile(id);
                Value::Null
            }
            _ => return Err("Unknown saved Gateway action.".into()),
        };
        let mut reconnects = Vec::new();
        for label in affected {
            if replacement.is_none() && label != "main" {
                owner.closed(app, &label);
                if let Some(window) = app.get_window(&label) {
                    let _ = window.close();
                }
            } else {
                let target = replacement.as_deref().unwrap_or(PRIMARY);
                let retiring = owner
                    .routing
                    .lock()
                    .map_err(|_| STALE)?
                    .begin(&label, target, None);
                if remember_edited {
                    owner
                        .routing
                        .lock()
                        .map_err(|_| STALE)?
                        .remember_edited_selection(&retiring);
                }
                if let Err(error) = open_profile_recovery(app, &retiring, "") {
                    show_error(app, view.label(), &error);
                    continue;
                }
                reconnects.push(
                    owner
                        .routing
                        .lock()
                        .map_err(|_| STALE)?
                        .begin(&label, target, None),
                );
            }
        }
        if matches!(action.as_str(), "save" | "remove") {
            publish_profile_catalog(app, &label, id, replacement.as_deref());
        }
        owner.publish(app);
        Ok((result, reconnects))
    })
    .await?;
    for intent in reconnects {
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            let label = intent.label.clone();
            if let Err(error) = select_intent(app.clone(), intent).await {
                show_error(&app, &label, &error);
            }
        });
    }
    Ok(result)
}

fn notice_script(message: &str) -> String {
    let detail = json!({ "message": message });
    format!("window.dispatchEvent(new CustomEvent('openclaw:gateway-notice',{{detail:{detail}}}));")
}

fn show_error(app: &AppHandle, label: &str, error: &str) {
    let owner = app.state::<GatewayWindows>();
    let mut local_notice = true;
    let document = owner.routing.lock().ok().and_then(|mut state| {
        let route = state.windows.get_mut(label)?;
        if let Some(document) = route.document.as_ref().filter(|doc| doc.nonce.is_some()) {
            local_notice = false;
            Some(document.clone())
        } else {
            local_notice = route.document.is_none();
            route.notice = Some(error.to_string());
            None
        }
    });
    let Some(view) = app.get_webview(label) else {
        return;
    };
    let notice = notice_script(error);
    if let Some(doc) = document {
        let _ = view.eval(scoped_script(&doc, &notice));
    } else if local_notice {
        let mut local = app.state::<crate::DesktopState>().inner.local_url.clone();
        local.set_query(None);
        local.set_fragment(None);
        let index = local.to_string();
        local.set_path("/gateways.html");
        let allowed = json!([index, local.as_str()]);
        let _=view.eval(format!("if(window===window.top){{const current=new URL(location.href);current.search='';current.hash='';if({allowed}.includes(current.href)){{{notice}}}}}"));
    }
}

fn fill_menu(app: &AppHandle, menu: &Submenu<tauri::Wry>, snapshot: &Value) -> tauri::Result<()> {
    for item in menu.items()? {
        menu.remove(&item)?;
    }
    if let Some(gateways) = snapshot.get("gateways").and_then(Value::as_array) {
        for (index, gateway) in gateways.iter().enumerate() {
            let (Some(id), Some(name)) = (gateway["id"].as_str(), gateway["name"].as_str()) else {
                continue;
            };
            let accelerator = (index < 9).then(|| format!("CmdOrCtrl+{}", index + 1));
            menu.append(&MenuItem::with_id(
                app,
                format!("gateway-focus:{id}"),
                name,
                true,
                accelerator,
            )?)?;
            let accelerator = (index < 9).then(|| format!("CmdOrCtrl+Alt+{}", index + 1));
            menu.append(&MenuItem::with_id(
                app,
                format!("gateway-new:{id}"),
                format!("Open {name} in New Window"),
                true,
                accelerator,
            )?)?;
        }
    }
    menu.append(&PredefinedMenuItem::separator(app)?)?;
    menu.append(&MenuItem::with_id(
        app,
        "gateway-manage",
        "Manage Gateways…",
        true,
        None::<&str>,
    )?)?;
    Ok(())
}

pub(crate) fn menu(app: &AppHandle) -> tauri::Result<Submenu<tauri::Wry>> {
    let menu = Submenu::with_id(
        app,
        format!("gateway-menu-{}", uuid::Uuid::new_v4()),
        "Gateways",
        true,
    )?;
    let owner = app.state::<GatewayWindows>();
    fill_menu(app, &menu, &owner.snapshot("main"))?;
    owner
        .menus
        .lock()
        .expect("Gateway menus")
        .push(menu.clone());
    Ok(menu)
}

pub(crate) fn handle_menu(app: &AppHandle, id: &str) -> bool {
    if id == "gateway-manage" {
        if let Err(error) = open_settings(app) {
            show_error(app, "main", &error);
        }
        return true;
    }
    let (target, reuse) = if let Some(id) = id.strip_prefix("gateway-focus:") {
        (id, true)
    } else if let Some(id) = id.strip_prefix("gateway-new:") {
        (id, false)
    } else {
        return false;
    };
    let app = app.clone();
    let target = target.to_string();
    tauri::async_runtime::spawn(async move {
        if let Err(error) = open_window(app.clone(), target, reuse, None).await {
            show_error(&app, "main", &error);
        }
    });
    true
}

pub(crate) fn startup(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let reserved = on_main(&app, |app| {
            let owner = app.state::<GatewayWindows>();
            {
                let mut state = owner.routing.lock().map_err(|_| STALE)?;
                if state.closing || !matches!(state.initial_selection, InitialSelection::Waiting) {
                    return Ok(None);
                }
                if state
                    .windows
                    .get("main")
                    .is_some_and(|route| route.document.is_some())
                {
                    // WKWebView has no URL before its first navigation commits.
                    // Registered documents already own readiness and source identity.
                    return Ok(state.reserve_initial_selection(None));
                }
            }
            let local = app
                .get_webview("main")
                .and_then(|view| view.url().ok())
                .filter(|url| {
                    app.state::<crate::DesktopState>()
                        .main_window_has_local_url(url)
                });
            if local.as_ref().is_some_and(|url| {
                app.state::<crate::DesktopState>()
                    .main_window_has_connection_settings_url(url)
            }) {
                owner
                    .routing
                    .lock()
                    .map_err(|_| STALE)?
                    .explicit_selection();
                return Ok(None);
            }
            let intent = owner
                .routing
                .lock()
                .map_err(|_| STALE)?
                .reserve_initial_selection(local);
            Ok(intent)
        })
        .await;
        let Ok(Some(intent)) = reserved else {
            return;
        };
        let reading_app = app.clone();
        let selected = tauri::async_runtime::spawn_blocking(move || {
            reading_app.state::<GatewayWindows>().profiles.selected()
        })
        .await
        .map_err(|_| "Could not restore the saved Gateway selection.".to_string())
        .and_then(|result| result);
        let completion = intent.clone();
        let resolved = on_main(&app, move |app| {
            let owner = app.state::<GatewayWindows>();
            if !owner.routing.lock().map_err(|_| STALE)?.current(&intent)
                || !source_current(app, &owner, &intent)
            {
                owner
                    .routing
                    .lock()
                    .map_err(|_| STALE)?
                    .finish_initial_selection(&intent);
                reconcile_primary(app, "main")?;
                return Ok(None);
            }
            let target = match selected {
                Ok(selected) => selected,
                Err(error) => {
                    show_error(app, "main", &error);
                    None
                }
            };
            let next = owner
                .routing
                .lock()
                .map_err(|_| STALE)?
                .resolve_initial_selection(&intent, target.as_deref());
            if next.is_none() {
                reconcile_primary(app, "main")?;
            }
            Ok(next)
        })
        .await;
        match resolved {
            Ok(Some(intent)) => {
                let completion = intent.clone();
                if let Err(error) = select_intent(app.clone(), intent).await {
                    if error != STALE {
                        show_error(&app, "main", &error);
                    }
                }
                if let Ok(mut state) = app.state::<GatewayWindows>().routing.lock() {
                    state.finish_initial_selection(&completion);
                }
            }
            Ok(None) => {}
            Err(error) => {
                if let Ok(mut state) = app.state::<GatewayWindows>().routing.lock() {
                    state.finish_initial_selection(&completion);
                }
                if error != STALE {
                    show_error(&app, "main", &error);
                }
            }
        }
    });
}

pub(crate) fn local_page_load(view: Webview, url: &Url, started: bool) {
    let app = view.app_handle();
    let owner = app.state::<GatewayWindows>();
    if owner.routing.lock().is_ok_and(|state| {
        state
            .windows
            .get(view.label())
            .is_some_and(|route| route.document.is_some())
    }) {
        return;
    }
    if view.label() != "main"
        || !{
            app.state::<crate::DesktopState>()
                .main_window_has_local_url(url)
        }
    {
        return;
    }
    if app
        .state::<crate::DesktopState>()
        .main_window_has_connection_settings_url(url)
    {
        if let Ok(mut state) = owner.routing.lock() {
            state.settings_page_load(started);
        }
        return;
    }
    if started {
        if let Ok(mut state) = owner.routing.lock() {
            state.retire_initial_document("main");
            state.cancel("main");
        }
    } else {
        let notice = owner.routing.lock().ok().and_then(|state| {
            state
                .windows
                .get(view.label())
                .and_then(|route| route.notice.clone())
        });
        if let Some(notice) = notice {
            show_error(app, view.label(), &notice);
        }
        startup(app);
    }
}

pub(crate) fn bootstrap_admitted(app: &AppHandle) {
    if let Ok(mut state) = app.state::<GatewayWindows>().routing.lock() {
        state.bootstrap_admitted();
    }
    startup(app);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn document(lifetime: &str) -> Document {
        Document {
            lifetime: lifetime.into(),
            nonce: Some("ready-nonce".into()),
            url: Url::parse("https://gateway.example/team").unwrap(),
            phase: NavigationPhase::Active,
            navigation: 1,
            native_navigation: None,
            queued_url: None,
            completion: None,
            profile_revision: None,
            #[cfg(target_os = "windows")]
            _browser_data: None,
        }
    }

    fn loading_document(lifetime: &str, completion: SelectionCompletion) -> Document {
        Document {
            nonce: None,
            completion: Some(completion),
            ..document(lifetime)
        }
    }

    #[test]
    fn native_results_use_their_captured_start_when_new_policy_precedes_native_start() {
        for old_result in [NavigationEvent::Succeeded, NavigationEvent::Failed] {
            let mut state = Routing::default();
            state.selection_sequence = 1;
            state.windows.insert(
                "main".into(),
                WindowRoute {
                    target: "saved-b".into(),
                    document: Some(loading_document(
                        "loading",
                        SelectionCompletion::Explicit(1),
                    )),
                    ..Default::default()
                },
            );
            let url = document("unused").url;
            assert!(state
                .native_document_event("main", "loading", NavigationEvent::Started)
                .is_none());
            assert!(state.document_navigation("main", "loading", &url));
            assert!(state
                .native_document_event("main", "loading", old_result)
                .is_none());
            assert!(!state.can_reuse("main", "saved-b"));
            let doc = state.windows["main"].document.as_ref().unwrap();
            assert!(doc.phase == NavigationPhase::Active);
            assert_eq!(
                doc.completion,
                Some(SelectionCompletion::Explicit(1)),
                "a superseded result cannot consume remembered-selection or focus intent"
            );

            state.native_document_event("main", "loading", NavigationEvent::Started);
            let finished = state
                .native_document_event("main", "loading", NavigationEvent::Succeeded)
                .unwrap();
            let (_, completion, _) = state.complete_document(&finished, &url).unwrap();
            assert!(completion.remembers(1));
            assert!(completion.presents(1));
            assert!(
                state
                    .native_document_event("main", "loading", NavigationEvent::Succeeded)
                    .is_none(),
                "a native completion is consumed once"
            );
        }
    }

    #[test]
    fn bootstrap_and_failed_error_page_events_cannot_authorize_a_dashboard() {
        let mut state = Routing::default();
        let mut doc = loading_document("loading", SelectionCompletion::Automatic);
        doc.phase = NavigationPhase::Preparing;
        state.windows.insert(
            "main".into(),
            WindowRoute {
                document: Some(doc),
                ..Default::default()
            },
        );
        let url = document("unused").url;
        assert!(!state.document_navigation("main", "loading", &url));
        assert!(state
            .native_document_event("main", "loading", NavigationEvent::Started)
            .is_none());
        assert!(state
            .native_document_event("main", "loading", NavigationEvent::Succeeded)
            .is_none());
        state
            .windows
            .get_mut("main")
            .unwrap()
            .document
            .as_mut()
            .unwrap()
            .phase = NavigationPhase::Active;
        state.native_document_event("main", "loading", NavigationEvent::Started);
        let failed = state
            .native_document_event("main", "loading", NavigationEvent::Failed)
            .unwrap();
        assert!(state.failed_document(&failed));
        assert!(!state.document_navigation("main", "loading", &url));
        assert!(state
            .native_document_event("main", "loading", NavigationEvent::Started)
            .is_none());
        assert!(state
            .native_document_event("main", "loading", NavigationEvent::Succeeded)
            .is_none());
        assert!(!state.can_reuse("main", PRIMARY));
    }

    #[test]
    fn failed_navigation_cannot_become_ready_or_remembered_by_a_late_finished_callback() {
        let mut state = Routing::default();
        state.selection_sequence = 1;
        state.windows.insert(
            "main".into(),
            WindowRoute {
                target: "saved-b".into(),
                document: Some(loading_document(
                    "loading",
                    SelectionCompletion::Explicit(1),
                )),
                ..Default::default()
            },
        );
        let url = document("unused").url;
        let finished = state.document_event("main", "loading").unwrap();
        let failed = state.document_failed("main", "loading").unwrap();
        assert!(state.complete_document(&finished, &url).is_none());
        assert!(!state.can_reuse("main", "saved-b"));
        assert!(state.document_failed("main", "loading").is_none());
        let (recovery, present) = state.begin_document_recovery(&failed).unwrap();
        assert!(
            present,
            "the current explicit choice must present its recovery"
        );
        state
            .enter_profile_recovery(&recovery, Some("saved-b"))
            .unwrap();
        let retry = state.begin("main", "saved-b", None);
        let completion = state.selection_completion(&retry);
        assert!(completion.remembers(state.selection_sequence));
        assert!(
            !completion.presents(state.selection_sequence),
            "an automatic retry must not steal focus"
        );
    }

    #[test]
    fn queued_failure_and_finished_callbacks_cannot_replace_a_new_document_or_navigation() {
        for change in ["navigation", "document", "window", "close"] {
            let mut state = Routing::default();
            state.windows.insert(
                "main".into(),
                WindowRoute {
                    target: "saved-b".into(),
                    document: Some(loading_document("old", SelectionCompletion::Automatic)),
                    ..Default::default()
                },
            );
            let old = if change == "navigation" {
                state.document_event("main", "old").unwrap()
            } else {
                state.document_failed("main", "old").unwrap()
            };
            let url = document("unused").url;
            match change {
                "navigation" => {
                    assert!(state.document_navigation("main", "old", &url));
                }
                "document" => {
                    state.windows.get_mut("main").unwrap().document = Some(document("new"));
                }
                "window" => {
                    state.windows.insert(
                        "main".into(),
                        WindowRoute {
                            document: Some(document("old")),
                            ..Default::default()
                        },
                    );
                }
                "close" => {
                    state.windows.remove("main");
                }
                _ => unreachable!(),
            }
            assert!(
                state.begin_document_recovery(&old).is_none(),
                "{change} must fence queued recovery"
            );
            assert!(
                state.complete_document(&old, &url).is_none(),
                "{change} must fence queued success"
            );
        }
    }

    #[test]
    fn failed_document_yields_to_a_new_selection_but_recovers_if_that_selection_is_cancelled() {
        let mut state = Routing::default();
        state.selection_sequence = 1;
        state.windows.insert(
            "main".into(),
            WindowRoute {
                target: "saved-b".into(),
                document: Some(loading_document("failed", SelectionCompletion::Explicit(1))),
                ..Default::default()
            },
        );
        let failed = state.document_failed("main", "failed").unwrap();
        let newer = state.begin("main", "saved-c", None);
        state.upgrade_selection(&newer, true);
        assert!(state.begin_document_recovery(&failed).is_none());
        assert!(state.current(&newer));
        state.cancel_intent(&newer);
        let (recovery, present) = state.begin_document_recovery(&failed).unwrap();
        assert_eq!(recovery.target, "saved-b");
        assert!(!present);
        assert!(!state
            .selection_completion(&recovery)
            .remembers(state.selection_sequence));
    }

    #[test]
    fn explicitly_rejoining_a_loading_window_supersedes_newer_choices_only_when_requested() {
        for rejoin in [false, true] {
            let mut state = Routing::default();
            state.windows.insert(
                "gateway-b".into(),
                WindowRoute {
                    target: "saved-b".into(),
                    document: Some(loading_document("b", SelectionCompletion::Automatic)),
                    ..Default::default()
                },
            );
            assert_eq!(
                state.admit_selection("gateway-b", "saved-b", true, true),
                SelectionDisposition::Pending
            );
            let other = state.begin("gateway-c", "saved-c", None);
            state.upgrade_selection(&other, true);
            let newer_sequence = state.selection_sequence;
            assert_eq!(
                state.admit_selection("gateway-b", "saved-b", true, rejoin),
                SelectionDisposition::Pending
            );
            assert_eq!(state.selection_sequence > newer_sequence, rejoin);
            assert!(
                !state.can_reuse("gateway-b", "saved-b"),
                "joining must wait for a successful document"
            );
            let event = state.document_event("gateway-b", "b").unwrap();
            let (_, completion, _) = state
                .complete_document(&event, &document("unused").url)
                .unwrap();
            assert_eq!(completion.remembers(state.selection_sequence), rejoin);
            assert_eq!(completion.presents(state.selection_sequence), rejoin);
            assert_eq!(
                state
                    .selection_completion(&other)
                    .remembers(state.selection_sequence),
                !rejoin
            );
        }
    }

    #[test]
    fn edited_selection_survives_repeated_failure_recovery_until_a_new_explicit_choice() {
        let mut state = Routing::default();
        state.selection_sequence = 7;
        for target in ["saved-b", "saved-c"] {
            state.selection_target = Some(target.into());
            let edited = state.begin("main", target, None);
            state.remember_edited_selection(&edited);
            state.enter_profile_recovery(&edited, Some(target)).unwrap();
            let retry = state.begin("main", target, None);
            let completion = state.selection_completion(&retry);
            assert!(completion.remembers(7));
            assert!(!completion.presents(7));
            // Begin from the document installed by a successful native builder.
            let route = state.windows.get_mut("main").unwrap();
            route.pending = None;
            route.recovery = None;
            route.document = Some(loading_document(target, completion));
            let failed = state.document_failed("main", target).unwrap();
            let (recovery, present) = state.begin_document_recovery(&failed).unwrap();
            assert!(!present);
            state
                .enter_profile_recovery(&recovery, Some(target))
                .unwrap();
            assert!(state.remembers_edited_target(target));
        }
        let newer = state.begin("gateway-other", "saved-d", None);
        state.upgrade_selection(&newer, true);
        assert!(!state.remembers_edited_target("saved-c"));
        let retry = state.begin("main", "saved-c", None);
        assert!(!state
            .selection_completion(&retry)
            .remembers(state.selection_sequence));
    }

    #[test]
    fn selection_is_latest_wins_and_window_scoped() {
        let mut state = Routing::default();
        state.windows.insert(
            "main".into(),
            WindowRoute {
                target: PRIMARY.into(),
                document: Some(document("first")),
                ..Default::default()
            },
        );
        let first = state.begin(
            "main",
            "alpha",
            Some(DocumentAuthority {
                label: "main".into(),
                lifetime: "first".into(),
                nonce: "ready-nonce".into(),
            }),
        );
        let other = state.begin("gateway-other", "gamma", None);
        let last = state.begin(
            "main",
            "beta",
            Some(DocumentAuthority {
                label: "main".into(),
                lifetime: "first".into(),
                nonce: "ready-nonce".into(),
            }),
        );
        assert!(!state.current(&first));
        assert!(state.current(&last));
        assert!(state.current(&other));
        assert_eq!(
            state.windows["main"].target, PRIMARY,
            "preparation must not change the selected or Primary route"
        );
        state.cancel("main");
        assert!(!state.current(&last));
        assert!(state.current(&other));
    }

    #[test]
    fn document_navigation_replacement_close_and_profile_removal_revoke_pending_work() {
        for change in ["navigate", "replace", "close", "remove"] {
            let mut state = Routing::default();
            state.windows.insert(
                "main".into(),
                WindowRoute {
                    target: "alpha".into(),
                    document: Some(document("first")),
                    ..Default::default()
                },
            );
            let pending = state.begin(
                "main",
                "alpha",
                Some(DocumentAuthority {
                    label: "main".into(),
                    lifetime: "first".into(),
                    nonce: "ready-nonce".into(),
                }),
            );
            match change {
                "navigate" => {
                    state
                        .windows
                        .get_mut("main")
                        .unwrap()
                        .document
                        .as_mut()
                        .unwrap()
                        .nonce = None
                }
                "replace" => {
                    state.windows.get_mut("main").unwrap().document = Some(document("second"))
                }
                "close" => {
                    state.windows.remove("main");
                }
                "remove" => {
                    assert_eq!(state.invalidate_profile("alpha"), ["main"]);
                }
                _ => unreachable!(),
            }
            assert!(
                !state.current(&pending),
                "{change} must retire prepared credentials and SSH tunnels"
            );
        }
    }

    #[test]
    fn dashboard_authority_stays_inside_its_origin_and_path() {
        let expected = Url::parse("https://gateway.example/team").unwrap();
        for (url, allowed) in [
            ("https://gateway.example/team", true),
            ("https://gateway.example/team/chat/main", true),
            ("https://gateway.example/teamwork", false),
            ("https://gateway.example/", false),
            ("https://other.example/team", false),
            ("http://gateway.example/team", false),
            ("https://user@gateway.example/team", false),
        ] {
            assert_eq!(
                matches_route(&Url::parse(url).unwrap(), &expected),
                allowed,
                "{url}"
            );
        }
        assert!(local_settings_url(
            &Url::parse("tauri://localhost/gateways.html").unwrap()
        ));
        assert!(!local_settings_url(
            &Url::parse("https://gateway.example/gateways.html").unwrap()
        ));
    }

    #[test]
    fn new_window_preparation_loses_authority_when_its_source_document_closes() {
        let mut state = Routing::default();
        state.windows.insert(
            "main".into(),
            WindowRoute {
                target: PRIMARY.into(),
                document: Some(document("first")),
                ..Default::default()
            },
        );
        let source = DocumentAuthority {
            label: "main".into(),
            lifetime: "first".into(),
            nonce: "ready-nonce".into(),
        };
        let requested = state.begin("gateway-new", "saved", Some(source));
        let independent = state.begin("gateway-menu", "saved", None);
        assert!(state.current(&requested));
        state.windows.remove("main");
        assert!(
            !state.current(&requested),
            "a delayed open must not outlive its authorizing document"
        );
        assert!(
            state.current(&independent),
            "a native menu open owns its own lifetime"
        );
        state.closing = true;
        assert!(
            !state.current(&independent),
            "application shutdown also retires menu preparations"
        );
    }

    #[test]
    fn primary_refresh_cannot_take_over_a_pending_saved_selection() {
        let mut state = Routing::default();
        assert!(state.follows_primary());
        state.windows.insert(
            "main".into(),
            WindowRoute {
                target: PRIMARY.into(),
                document: Some(document("first")),
                ..Default::default()
            },
        );
        let selection = state.begin("main", "saved", None);
        assert!(!state.follows_primary());
        let unrelated = state.begin("gateway-other", "other", None);
        assert!(state.invalidate_profile("saved").is_empty());
        assert!(!state.current(&selection));
        assert!(state.current(&unrelated));
        assert!(
            state.follows_primary(),
            "cancellation leaves the displayed Primary route in place"
        );
    }

    #[test]
    fn queued_promotion_requires_the_confirmed_profile_revision_and_live_window_intent() {
        let mut state = Routing::default();
        state.windows.insert(
            "main".into(),
            WindowRoute {
                target: PRIMARY.into(),
                document: Some(document("confirmed")),
                ..Default::default()
            },
        );
        let profile = SavedGateway {
            id: "saved".into(),
            revision: "first-revision".into(),
            name: "Studio".into(),
            request: RemoteGatewayRequest {
                transport: "direct".into(),
                url: Some("https://gateway.example".into()),
                token: Some("fixture-token".into()),
                password: None,
                ssh_target: None,
                remote_port: None,
                tls_fingerprint: None,
            },
        };
        let intent = state.begin(
            "main",
            &profile.id,
            Some(DocumentAuthority {
                label: "main".into(),
                lifetime: "confirmed".into(),
                nonce: "ready-nonce".into(),
            }),
        );
        let guard = PromotionGuard {
            intent,
            profile_id: profile.id.clone(),
            profile_revision: profile.revision.clone(),
        };
        let queued = guard.clone();
        assert!(queued.matches(&state, &profile));
        let mut edited = profile.clone();
        edited.revision = "replacement-revision".into();
        assert!(
            !queued.matches(&state, &edited),
            "credential edits retire queued promotion"
        );
        edited = profile.clone();
        edited.id = "replacement-endpoint".into();
        assert!(
            !queued.matches(&state, &edited),
            "a replacement endpoint cannot inherit confirmation"
        );
        state.begin("main", "another-gateway", None);
        assert!(
            !queued.matches(&state, &profile),
            "a later window selection retires confirmation"
        );
    }

    fn starting_primary() -> Routing {
        let mut state = Routing {
            primary: Some(Route {
                url: Url::parse("http://127.0.0.1:18789").unwrap(),
                auth_script: None,
            }),
            ..Default::default()
        };
        let mut loading = document("first");
        loading.nonce = None;
        state.windows.insert(
            "main".into(),
            WindowRoute {
                target: PRIMARY.into(),
                document: Some(loading),
                ..Default::default()
            },
        );
        state.bootstrap_admitted();
        state
    }

    #[test]
    fn initial_selection_waits_for_current_primary_document_and_runs_once() {
        let mut state = starting_primary();
        assert!(
            state.reserve_initial_selection(None).is_none(),
            "early bootstrap must not consume restoration"
        );
        state.windows.get_mut("main").unwrap().document = Some(document("ready"));
        let lookup = state
            .reserve_initial_selection(None)
            .expect("ready Primary reserves restoration");
        assert!(
            state.reserve_initial_selection(None).is_none(),
            "duplicate ready callbacks cannot reserve twice"
        );
        let selection = state
            .resolve_initial_selection(&lookup, Some("saved"))
            .unwrap();
        assert!(!state.current(&lookup));
        assert!(state.current(&selection));
        state.finish_initial_selection(&selection);
        state.windows.get_mut("main").unwrap().document = Some(document("primary-reconnect"));
        assert!(
            state.reserve_initial_selection(None).is_none(),
            "Primary reconnect must not reapply the last auxiliary selection"
        );
        assert_eq!(state.windows["main"].target, PRIMARY);
    }

    #[test]
    fn saved_selection_can_restore_while_primary_is_unavailable() {
        let mut state = starting_primary();
        state.primary = None;
        state.windows.get_mut("main").unwrap().document = Some(document("ready"));
        assert!(
            state.reserve_initial_selection(None).is_some(),
            "saved selection must not depend on Primary connecting successfully"
        );
    }

    #[test]
    fn explicit_selection_retires_initial_restoration_before_and_after_vault_resolution() {
        for resolved in [false, true] {
            let mut state = starting_primary();
            state.windows.get_mut("main").unwrap().document = Some(document("ready"));
            let mut startup = state.reserve_initial_selection(None).unwrap();
            if resolved {
                startup = state
                    .resolve_initial_selection(&startup, Some("remembered"))
                    .unwrap();
            }
            state.explicit_selection();
            let chosen = state.begin("gateway-other", "explicit", None);
            assert!(
                !state.current(&startup),
                "late startup work cannot overwrite an explicit auxiliary choice"
            );
            assert!(state
                .resolve_initial_selection(&startup, Some("remembered"))
                .is_none());
            state.finish_initial_selection(&startup);
            assert!(
                state.current(&chosen),
                "startup cleanup must preserve newer work"
            );
            assert!(state.reserve_initial_selection(None).is_none());
        }
        let mut state = starting_primary();
        state.explicit_selection();
        state.windows.get_mut("main").unwrap().document = Some(document("ready"));
        assert!(
            state.reserve_initial_selection(None).is_none(),
            "a pre-ready user choice also owns startup"
        );
    }

    #[test]
    fn absent_initial_selection_leaves_primary_and_does_not_retry_on_reconnect() {
        let mut state = starting_primary();
        state.windows.get_mut("main").unwrap().document = Some(document("ready"));
        let initial = state.reserve_initial_selection(None).unwrap();
        assert!(state.resolve_initial_selection(&initial, None).is_none());
        assert_eq!(state.windows["main"].target, PRIMARY);
        assert!(state.follows_primary());
        state.windows.get_mut("main").unwrap().document = Some(document("reconnected"));
        assert!(state.reserve_initial_selection(None).is_none());
    }

    #[test]
    fn primary_kind_uses_connection_ownership_instead_of_loopback_address() {
        let mut state = starting_primary();
        state.primary_ownership = Some(GatewayOwnership::Remote);
        assert_eq!(state.primary_kind(), "remote");
        state.primary_ownership = Some(GatewayOwnership::Local);
        assert_eq!(state.primary_kind(), "local");
    }

    #[test]
    fn primary_capability_uses_a_primary_window_and_replaces_only_stale_primary_documents() {
        let mut state = starting_primary();
        state.primary_generation = 4;
        state.windows.get_mut("main").unwrap().target = "saved-studio".into();
        assert!(
            state.primary_window().is_none(),
            "a saved dashboard must never receive Primary session navigation"
        );
        state.windows.insert(
            "gateway-primary".into(),
            WindowRoute {
                target: PRIMARY.into(),
                primary_generation: Some(4),
                document: Some(document("primary")),
                ..Default::default()
            },
        );
        assert_eq!(
            state.primary_window(),
            Some(("gateway-primary".into(), false)),
            "opening Primary again must preserve its current document"
        );
        state.primary_generation = 5;
        assert_eq!(
            state.primary_window(),
            Some(("gateway-primary".into(), true)),
            "a changed Primary route must replace old authentication before navigation"
        );
        assert_eq!(state.windows["main"].target, "saved-studio");
    }

    #[test]
    fn settings_return_restores_the_window_target_and_yields_to_later_selection() {
        let mut state = starting_primary();
        state.windows.get_mut("main").unwrap().target = "saved-studio".into();
        let local = Url::parse("tauri://localhost/index.html?mode=connectionSettings").unwrap();
        let restore = state.reserve_saved_restore(local.clone()).unwrap();
        assert_eq!(restore.target, "saved-studio");
        assert_eq!(restore.source_url, Some(local));
        assert!(state.current(&restore));
        state.begin("main", "new-choice", None);
        assert!(
            !state.current(&restore),
            "settings completion cannot override a newer window selection"
        );
        state.windows.get_mut("main").unwrap().target = PRIMARY.into();
        assert!(state
            .reserve_saved_restore(
                Url::parse("tauri://localhost/index.html?mode=connectionSettings").unwrap()
            )
            .is_none());
    }

    #[test]
    fn private_browser_directories_are_unique_and_retire_only_after_the_document_lease() {
        let parent = std::env::temp_dir().join(format!(
            "openclaw-browser-storage-test-{}",
            uuid::Uuid::new_v4()
        ));
        let cleanup = Arc::new(BrowserDataCleanup::default());
        let first = TemporaryBrowserData::create(&parent, Arc::clone(&cleanup)).unwrap();
        let second = TemporaryBrowserData::create(&parent, Arc::clone(&cleanup)).unwrap();
        assert_ne!(
            first.path, second.path,
            "separate WebView2 environments require separate directories"
        );
        let first_path = first.path.clone();
        let second_path = second.path.clone();
        std::fs::write(first.path.join("Cookies"), "first-profile").unwrap();
        std::fs::write(second.path.join("Cookies"), "second-profile").unwrap();
        std::fs::write(parent.join("unrelated"), "keep").unwrap();
        let native_callback = Arc::clone(&first);
        drop(first);
        assert!(
            first_path.exists(),
            "replacing the route alone must not remove a live WebView's storage"
        );
        drop(native_callback);
        drop(second);
        cleanup.wait();
        assert!(!first_path.exists());
        assert!(!second_path.exists());
        assert_eq!(
            std::fs::read_to_string(parent.join("unrelated")).unwrap(),
            "keep"
        );
        std::fs::remove_dir_all(parent).unwrap();
    }

    #[test]
    fn windows_browser_isolation_excludes_only_the_primary_main_document() {
        assert!(!isolated_browser_document("main", PRIMARY));
        assert!(isolated_browser_document("main", "saved-profile"));
        assert!(isolated_browser_document("gateway-secondary", PRIMARY));
        assert!(isolated_browser_document(
            "gateway-secondary",
            "saved-profile"
        ));
    }

    #[test]
    fn failed_switch_and_native_reselection_require_the_latest_primary_document() {
        let mut state = starting_primary();
        state.windows.get_mut("main").unwrap().document = Some(document("ready"));
        state.windows.get_mut("main").unwrap().primary_generation = Some(0);
        assert!(state.can_reuse("main", PRIMARY));
        state.begin("main", "slow-saved", None);
        state.primary_generation = 1;
        assert!(
            !state.needs_primary_refresh("main"),
            "in-flight user selection owns the shell"
        );
        state.cancel("main");
        assert!(
            state.needs_primary_refresh("main"),
            "failed or cancelled selection must apply deferred Primary refresh"
        );
        assert!(
            !state.can_reuse("main", PRIMARY),
            "native focus and no-op select cannot keep stale credentials"
        );
        state.windows.get_mut("main").unwrap().primary_generation = Some(1);
        assert!(!state.needs_primary_refresh("main"));
        assert!(state.can_reuse("main", PRIMARY));
    }

    #[test]
    fn failed_profile_edit_retires_old_principal_into_managed_local_recovery() {
        let mut state = starting_primary();
        state.windows.get_mut("main").unwrap().target = "saved".into();
        state.windows.get_mut("main").unwrap().document = Some(document("original"));
        let original = DocumentAuthority {
            label: "main".into(),
            lifetime: "original".into(),
            nonce: "ready-nonce".into(),
        };
        state.invalidate_profile("saved");
        let edited = state.begin("main", "saved", None);
        assert!(state.current(&edited));
        assert!(!state.source_current(&original));
        state
            .enter_profile_recovery(&edited, Some("saved"))
            .unwrap();
        assert_eq!(state.windows["main"].target, "saved");
        assert!(state.windows["main"].recovery.is_some());
        assert!(
            state.windows["main"].document.is_none(),
            "retired authentication must leave the shell"
        );
        assert!(!state.current(&edited));
        assert!(
            !state.follows_primary(),
            "Primary updates must preserve the profile recovery editor"
        );
        let retry = state.begin("main", "saved", None);
        assert!(state.current(&retry));
    }

    #[test]
    fn endpoint_edit_recovery_binds_the_current_intent_instead_of_the_old_direct_profile() {
        let mut state = starting_primary();
        state.windows.get_mut("main").unwrap().target = "manual-direct-studio".into();
        state.windows.get_mut("main").unwrap().document = Some(document("direct-principal"));
        state.invalidate_profile("manual-direct-studio");
        let ssh_edit = state.begin("main", "manual-ssh-studio", None);
        state
            .enter_profile_recovery(&ssh_edit, Some("manual-ssh-studio"))
            .unwrap();
        assert_eq!(state.windows["main"].target, "manual-ssh-studio");
        assert!(state.windows["main"].document.is_none());
        assert!(state.windows["main"].recovery.is_some());
        assert!(!state.current(&ssh_edit));
        assert!(state
            .enter_profile_recovery(&ssh_edit, Some("manual-direct-studio"))
            .is_err());
    }

    #[test]
    fn missing_or_deleted_edit_targets_cannot_regain_remote_authority() {
        let mut state = starting_primary();
        state.windows.get_mut("main").unwrap().target = "removed-profile".into();
        state.windows.get_mut("main").unwrap().document = Some(document("old-principal"));
        state.invalidate_profile("removed-profile");
        let pending = state.begin("main", "removed-profile", None);
        state.invalidate_profile("removed-profile");
        assert!(
            state
                .enter_profile_recovery(&pending, Some("removed-profile"))
                .is_err(),
            "deletion retires pending recovery too"
        );
        let fallback = state.begin("main", PRIMARY, None);
        state.enter_profile_recovery(&fallback, None).unwrap();
        assert_eq!(state.windows["main"].target, PRIMARY);
        assert!(state.windows["main"].document.is_none());
        assert!(state.windows["main"].recovery.is_some());
        assert!(
            !state.follows_primary(),
            "the generic local editor remains available until another explicit choice"
        );
    }

    #[test]
    fn first_run_page_restores_saved_selection_without_primary_configuration() {
        let mut state = Routing::default();
        state.bootstrap_admitted();
        let local = Url::parse("tauri://localhost/index.html?mode=missingCli").unwrap();
        let lookup = state
            .reserve_initial_selection(Some(local.clone()))
            .unwrap();
        let selected = state
            .resolve_initial_selection(&lookup, Some("saved-studio"))
            .unwrap();
        assert_eq!(selected.source_url, Some(local));
        assert_eq!(selected.target, "saved-studio");
        assert!(state.current(&selected));
        state.explicit_selection();
        assert!(!state.current(&selected));
    }

    #[test]
    fn synchronous_edit_retirement_survives_replacement_cancellation() {
        let mut state = starting_primary();
        state.windows.get_mut("main").unwrap().target = "direct-profile".into();
        state.windows.get_mut("main").unwrap().document = Some(document("old-authentication"));
        state.invalidate_profile("direct-profile");
        let edit = state.begin("main", "ssh-profile", None);
        state
            .enter_profile_recovery(&edit, Some("ssh-profile"))
            .unwrap();
        assert!(
            state.windows["main"].document.is_none(),
            "save retires the old principal before SSH preparation"
        );
        let slow = state.begin("main", "ssh-profile", None);
        state.cancel("main");
        assert!(!state.current(&slow));
        assert!(state.windows["main"].recovery.is_some());
        assert!(state.windows["main"].document.is_none());
        assert_eq!(state.windows["main"].target, "ssh-profile");
    }

    #[test]
    fn local_startup_without_saved_selection_reconciles_a_primary_that_became_ready() {
        let mut state = Routing::default();
        state.bootstrap_admitted();
        let initial = state
            .reserve_initial_selection(Some(Url::parse("tauri://localhost/index.html").unwrap()))
            .unwrap();
        state.primary = starting_primary().primary;
        state.primary_generation = 1;
        assert!(!state.needs_primary_refresh("main"));
        state.resolve_initial_selection(&initial, None);
        assert_eq!(state.windows["main"].target, PRIMARY);
        assert!(state.windows["main"].document.is_none());
        assert!(
            state.needs_primary_refresh("main"),
            "ready Primary must leave the local setup page after empty or failed lookup"
        );
    }

    #[test]
    fn explicit_primary_selection_rebuilds_its_recovery_editor() {
        let mut state = starting_primary();
        let removed = state.begin("main", PRIMARY, None);
        state.enter_profile_recovery(&removed, None).unwrap();
        assert!(
            !state.needs_primary_refresh("main"),
            "background Primary updates keep recovery usable"
        );
        assert_eq!(
            state.admit_selection("main", PRIMARY, false, true),
            SelectionDisposition::Replace
        );
    }

    #[test]
    fn selection_admission_cancels_a_different_target_but_joins_the_same_pending_target() {
        let mut state = starting_primary();
        state.windows.get_mut("main").unwrap().document = Some(document("ready-primary"));
        state.windows.get_mut("main").unwrap().primary_generation = Some(state.primary_generation);
        let pending = state.begin("main", "saved-b", None);
        assert_eq!(
            state.admit_selection("main", PRIMARY, false, true),
            SelectionDisposition::Reuse
        );
        assert!(
            !state.current(&pending),
            "focusing visible A must retire pending B"
        );
        let same = state.begin("main", "saved-b", None);
        assert_eq!(
            state.admit_selection("main", "saved-b", false, true),
            SelectionDisposition::Pending
        );
        assert!(
            state.current(&same),
            "joining pending B must neither cancel it nor count as a completed selection"
        );
        assert_eq!(state.windows["main"].target, PRIMARY);
    }

    #[test]
    fn local_restore_waits_for_bootstrap_admission_and_retries_after_automatic_failure_navigation()
    {
        let local = Url::parse("tauri://localhost/index.html").unwrap();
        let failure = Url::parse("tauri://localhost/index.html?mode=remoteError").unwrap();
        let mut state = Routing::default();
        assert!(
            state
                .reserve_initial_selection(Some(local.clone()))
                .is_none(),
            "local load must not replace the page before bootstrap is admitted"
        );
        state.bootstrap_admitted();
        let lookup = state.reserve_initial_selection(Some(local)).unwrap();
        state.retire_initial_document("main");
        state.cancel("main");
        let retry = state.reserve_initial_selection(Some(failure)).unwrap();
        state.finish_initial_selection(&lookup);
        assert!(!state.current(&lookup));
        assert!(
            state.current(&retry),
            "late first reply cannot finish the rearmed attempt"
        );
        let selected = state
            .resolve_initial_selection(&retry, Some("saved-b"))
            .unwrap();
        assert!(state.current(&selected));
    }

    #[test]
    fn recreated_local_main_cannot_inherit_an_old_restore_ticket_even_at_the_same_url() {
        let local = Url::parse("tauri://localhost/index.html?mode=remoteError").unwrap();
        let mut state = Routing::default();
        state.bootstrap_admitted();
        let old = state
            .reserve_initial_selection(Some(local.clone()))
            .unwrap();
        state.retire_initial_document("main");
        state.windows.remove("main");
        let replacement = state.reserve_initial_selection(Some(local)).unwrap();
        assert_eq!(
            old.generation, replacement.generation,
            "the same label can restart its local generation"
        );
        assert_ne!(old.window_lifetime, replacement.window_lifetime);
        state.finish_initial_selection(&old);
        assert!(!state.current(&old));
        assert!(state.current(&replacement));
    }

    #[test]
    fn explicit_settings_selection_and_close_remain_terminal_across_bootstrap_and_loads() {
        for admitted in [false, true] {
            let mut state = Routing::default();
            if admitted {
                state.bootstrap_admitted();
                state
                    .reserve_initial_selection(Some(
                        Url::parse("tauri://localhost/index.html").unwrap(),
                    ))
                    .unwrap();
            }
            state.explicit_selection();
            state.cancel("main");
            state.bootstrap_admitted();
            state.retire_initial_document("main");
            assert!(state
                .reserve_initial_selection(Some(
                    Url::parse("tauri://localhost/index.html?mode=connectionSettings").unwrap()
                ))
                .is_none());
        }
    }

    #[test]
    fn primary_settings_suspension_keeps_selected_gateway_and_retires_its_document() {
        let mut state = starting_primary();
        state.windows.get_mut("main").unwrap().target = "saved-b".into();
        state.windows.get_mut("main").unwrap().document = Some(document("saved-b-document"));
        let old = state.begin("main", "saved-c", None);
        state.suspend_document("main");
        assert_eq!(state.windows["main"].target, "saved-b");
        assert!(state.windows["main"].document.is_none());
        assert!(!state.current(&old));
        assert!(!state.follows_primary());
        let local = Url::parse("tauri://localhost/index.html?mode=connectionSettings").unwrap();
        let restore = state.reserve_saved_restore(local).unwrap();
        assert_eq!(restore.target, "saved-b");
        assert!(state.current(&restore));
    }

    #[test]
    fn settings_finished_does_not_cancel_an_already_requested_return_to_saved_gateway() {
        let mut state = starting_primary();
        state.windows.get_mut("main").unwrap().target = "saved-b".into();
        state.suspend_document("main");
        let restore = state
            .reserve_saved_restore(
                Url::parse("tauri://localhost/index.html?mode=connectionSettings").unwrap(),
            )
            .unwrap();
        state.settings_page_load(false);
        assert!(
            state.current(&restore),
            "a late Finished callback must not cancel the return requested by the settings page"
        );
        state.settings_page_load(true);
        assert!(
            !state.current(&restore),
            "a genuinely new settings navigation retires the old return"
        );
    }

    #[test]
    fn primary_reuse_excludes_an_uncommitted_auxiliary_opening_a_different_gateway() {
        let mut state = starting_primary();
        state.windows.get_mut("main").unwrap().target = "saved-main".into();
        let independent = state.begin("gateway-pending-ssh", "saved-ssh", None);
        assert!(state.primary_window().is_none());
        assert!(state.window_for_target(PRIMARY).is_none());
        assert!(state.current(&independent));
        state.windows.get_mut("main").unwrap().target = PRIMARY.into();
        state.windows.get_mut("main").unwrap().primary_generation = Some(state.primary_generation);
        state.windows.get_mut("main").unwrap().document = Some(document("committed-primary"));
        let main_switch = state.begin("main", "another-saved", None);
        assert_eq!(state.primary_window(), Some(("main".into(), false)));
        assert_eq!(
            state.admit_selection("main", PRIMARY, false, true),
            SelectionDisposition::Reuse
        );
        assert!(!state.current(&main_switch));
        assert!(
            state.current(&independent),
            "focusing committed Primary must not cancel the independent SSH window"
        );
    }

    #[test]
    fn joining_automatic_reconnect_upgrades_only_its_successful_completion() {
        let mut state = starting_primary();
        state.windows.get_mut("main").unwrap().target = "saved-b".into();
        let automatic = state.begin("main", "saved-b", None);
        assert!(!matches!(
            state.selection_completion(&automatic),
            SelectionCompletion::Explicit(_)
        ));
        assert_eq!(
            state.admit_selection("main", "saved-b", true, true),
            SelectionDisposition::Pending
        );
        assert!(state.current(&automatic));
        assert!(
            matches!(
                state.selection_completion(&automatic),
                SelectionCompletion::Explicit(_)
            ),
            "menu join must preserve focus and remembered-selection intent"
        );
        state.upgrade_selection(&automatic, false);
        assert!(
            matches!(
                state.selection_completion(&automatic),
                SelectionCompletion::Explicit(_)
            ),
            "the automatic worker must not downgrade the joined user request"
        );
        state.cancel("main");
        assert!(
            !matches!(
                state.selection_completion(&automatic),
                SelectionCompletion::Explicit(_)
            ),
            "failed/cancelled work cannot consume that intent"
        );
    }

    #[test]
    fn primary_refresh_keeps_pending_source_authority_and_explicit_completion() {
        let mut state = starting_primary();
        state.windows.get_mut("main").unwrap().document = Some(document("source"));
        let source = DocumentAuthority {
            label: "main".into(),
            lifetime: "source".into(),
            nonce: "ready-nonce".into(),
        };
        let old = state.begin("gateway-primary", PRIMARY, Some(source));
        state.upgrade_selection(&old, true);
        let sequence = state.selection_sequence;
        let refreshed = state.refresh_primary("gateway-primary");
        assert_eq!(
            state.selection_sequence, sequence,
            "automatic reprepare must preserve the admitted selection order"
        );
        assert!(!state.current(&old));
        assert!(matches!(
            state.selection_completion(&refreshed),
            SelectionCompletion::Explicit(_)
        ));
        state.windows.get_mut("main").unwrap().document = None;
        assert!(
            !state.current(&refreshed),
            "automatic endpoint refresh must not discard the original source authority"
        );
    }

    #[test]
    fn primary_reuse_requires_a_ready_document_and_switches_do_not_join_promotions() {
        let mut state = starting_primary();
        state.windows.get_mut("main").unwrap().primary_generation = Some(state.primary_generation);
        assert_eq!(
            state.primary_window(),
            Some(("main".into(), true)),
            "a nonready Primary must be rebuilt, not merely focused"
        );
        state.windows.get_mut("main").unwrap().document = Some(document("ready"));
        let source = DocumentAuthority {
            label: "main".into(),
            lifetime: "ready".into(),
            nonce: "ready-nonce".into(),
        };
        let promotion = state.begin_promotion("main", "saved-b", source);
        assert_eq!(
            state.admit_selection("main", "saved-b", false, true),
            SelectionDisposition::Replace
        );
        assert!(
            !state.current(&promotion),
            "selecting a dashboard is independent of changing Primary"
        );
    }

    #[test]
    fn expired_source_cleanup_retires_its_own_slot_without_cancelling_newer_work() {
        let mut state = starting_primary();
        state.windows.get_mut("main").unwrap().document = Some(document("source"));
        let source = DocumentAuthority {
            label: "main".into(),
            lifetime: "source".into(),
            nonce: "ready-nonce".into(),
        };
        let expired = state.begin("gateway-pending", "saved-b", Some(source.clone()));
        state.windows.get_mut("main").unwrap().document = None;
        assert!(!state.current(&expired));
        state.cancel_intent(&expired);
        assert!(
            state.windows["gateway-pending"].pending.is_none(),
            "lost source authority must not leave a dead pending slot"
        );
        let stale = state.begin("gateway-pending", "saved-b", Some(source));
        assert_eq!(
            state.admit_selection("gateway-pending", "saved-b", true, true),
            SelectionDisposition::Replace
        );
        let fresh = state.begin("gateway-pending", "saved-b", None);
        state.cancel_intent(&stale);
        assert!(
            state.current(&fresh),
            "late stale cleanup must preserve the new native request"
        );
    }

    #[test]
    fn abandoned_startup_lookup_preserves_deferred_primary_but_yields_to_a_new_saved_choice() {
        let mut state = Routing::default();
        state.bootstrap_admitted();
        let lookup = state
            .reserve_initial_selection(Some(Url::parse("tauri://localhost/index.html").unwrap()))
            .unwrap();
        state.primary = starting_primary().primary;
        state.primary_generation = 1;
        state.explicit_selection();
        state.finish_initial_selection(&lookup);
        assert!(
            state.needs_primary_refresh("main"),
            "opening the manager cancels restoration without discarding ready Primary navigation"
        );
        let newer = state.begin("main", "saved-choice", None);
        state.finish_initial_selection(&lookup);
        assert!(!state.needs_primary_refresh("main"));
        assert!(
            state.current(&newer),
            "late lookup cancellation must not override a newer selected Gateway"
        );
    }

    #[test]
    fn primary_change_reprepares_saved_to_primary_selection_in_main_and_auxiliary_windows() {
        for label in ["main", "gateway-saved"] {
            let mut state = starting_primary();
            state.windows.insert(
                label.into(),
                WindowRoute {
                    target: "saved-b".into(),
                    document: Some(document("saved-b")),
                    ..Default::default()
                },
            );
            let source = DocumentAuthority {
                label: label.into(),
                lifetime: "saved-b".into(),
                nonce: "ready-nonce".into(),
            };
            let old = state.begin(label, PRIMARY, Some(source));
            state.upgrade_selection(&old, true);
            state.primary_generation += 1;
            assert!(
                state.primary_refresh_targets().contains(&label.to_string()),
                "{label} must follow its pending Primary choice even though B is still displayed"
            );
            let new = state.refresh_primary(label);
            assert!(!state.current(&old));
            assert!(state.current(&new));
            assert!(matches!(
                state.selection_completion(&new),
                SelectionCompletion::Explicit(_)
            ));
            assert_eq!(
                state.windows[label].target, "saved-b",
                "repreparation must retain B until the new Primary document commits"
            );
            state.windows.get_mut(label).unwrap().document = None;
            assert!(!state.current(&new));
        }
    }

    #[test]
    fn primary_refresh_only_reprepares_live_primary_switches_or_committed_auxiliary_primary() {
        let mut state = starting_primary();
        state.windows.get_mut("main").unwrap().document = Some(document("main-source"));
        state.windows.get_mut("main").unwrap().primary_generation = Some(0);
        let main = state.begin("main", PRIMARY, None);
        assert!(
            !state.follows_primary(),
            "pending owner must complete instead of a second root-main replacement"
        );
        state.windows.insert(
            "gateway-committed".into(),
            WindowRoute {
                primary_generation: Some(0),
                document: Some(document("committed")),
                ..Default::default()
            },
        );
        state.begin("gateway-independent", "saved-b", None);
        state
            .windows
            .insert("gateway-empty".into(), WindowRoute::default());
        let source = DocumentAuthority {
            label: "main".into(),
            lifetime: "main-source".into(),
            nonce: "ready-nonce".into(),
        };
        state.begin_promotion("gateway-promotion", PRIMARY, source.clone());
        state.begin(
            "gateway-expired",
            PRIMARY,
            Some(DocumentAuthority {
                lifetime: "expired".into(),
                ..source
            }),
        );
        assert_eq!(
            state.primary_refresh_targets(),
            ["gateway-committed", "main"]
        );
        assert!(state.current(&main));
    }

    #[test]
    fn legacy_open_preserves_selected_recovery_and_pending_main_but_reloads_idle_remote_primary() {
        let mut state = starting_primary();
        assert_eq!(state.main_presentation(), MainPresentation::LegacyFallback);
        state.primary_ownership = Some(GatewayOwnership::Remote);
        state.windows.get_mut("main").unwrap().document = Some(document("ready"));
        state.windows.get_mut("main").unwrap().primary_generation = Some(state.primary_generation);
        assert_eq!(
            state.main_presentation(),
            MainPresentation::ReloadRemotePrimary
        );
        state.begin("main", "saved-b", None);
        assert_eq!(state.main_presentation(), MainPresentation::Preserve);
        state.cancel("main");
        state.windows.get_mut("main").unwrap().target = "saved-b".into();
        assert_eq!(state.main_presentation(), MainPresentation::Preserve);
        state.windows.get_mut("main").unwrap().target = PRIMARY.into();
        state.windows.get_mut("main").unwrap().recovery = Some(SelectionCompletion::Automatic);
        assert_eq!(state.main_presentation(), MainPresentation::Preserve);
        state.closing = true;
        assert_eq!(state.main_presentation(), MainPresentation::Preserve);
    }
}
