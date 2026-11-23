use crate::cli::OpenClawCli;
use crate::gateway_ws::{GatewayClient, GatewayGeneration};
use crate::{main_window, notify, DesktopState};
use serde::Deserialize;
use std::collections::HashSet;
use tauri::{AppHandle, Manager};

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
enum ApprovalKind {
    Node,
    Device,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PendingApproval {
    kind: ApprovalKind,
    request_id: String,
    label: String,
}

impl PendingApproval {
    pub fn notification_body(&self) -> String {
        let kind = match self.kind {
            ApprovalKind::Node => "Node",
            ApprovalKind::Device => "Device",
        };
        format!(
            "{kind} pairing request from {} — open OpenClaw to approve",
            self.label
        )
    }
}

#[derive(Default)]
pub struct PendingApprovalState {
    visible: HashSet<String>,
}

pub struct PendingApprovalDiff {
    pub new: Vec<PendingApproval>,
    pub count: usize,
}

impl PendingApprovalState {
    // Only successful snapshots replace `visible`; failed polls retain dedupe state.
    pub fn update(&mut self, current: Vec<PendingApproval>) -> PendingApprovalDiff {
        let mut visible = HashSet::with_capacity(current.len());
        let new = current
            .into_iter()
            .filter(|request| {
                visible.insert(request.request_id.clone())
                    && !self.visible.contains(&request.request_id)
            })
            .collect();
        let count = visible.len();
        self.visible = visible;
        PendingApprovalDiff { new, count }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct NodePendingRequest {
    request_id: String,
    node_id: String,
    display_name: Option<String>,
}

#[cfg(target_os = "linux")]
#[derive(Deserialize)]
struct NodePairingList {
    pending: Vec<NodePendingRequest>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DevicePendingRequest {
    request_id: String,
    device_id: String,
    display_name: Option<String>,
    client_id: Option<String>,
}

#[derive(Deserialize)]
struct DevicePairingList {
    #[serde(default)]
    pending: Vec<DevicePendingRequest>,
}

fn fetch(cli: &OpenClawCli) -> Result<Vec<PendingApproval>, String> {
    let nodes = cli
        .json::<Vec<NodePendingRequest>, _, _>(["nodes", "pending", "--json"])
        .map_err(|error| error.to_string())?;
    let devices = cli
        .json::<DevicePairingList, _, _>(["devices", "list", "--json"])
        .map_err(|error| error.to_string())?;

    Ok(approvals(nodes, devices))
}

fn approvals(nodes: Vec<NodePendingRequest>, devices: DevicePairingList) -> Vec<PendingApproval> {
    let nodes = nodes.into_iter().map(|request| PendingApproval {
        kind: ApprovalKind::Node,
        request_id: request.request_id,
        label: preferred_label([request.display_name.as_deref(), Some(&request.node_id)]),
    });
    let devices = devices.pending.into_iter().map(|request| PendingApproval {
        kind: ApprovalKind::Device,
        request_id: request.request_id,
        label: preferred_label([
            request.display_name.as_deref(),
            request.client_id.as_deref(),
            Some(&request.device_id),
        ]),
    });
    nodes.chain(devices).collect()
}

pub(crate) fn poll_cli(state: &DesktopState, app: &AppHandle, cli: &OpenClawCli, generation: u64) {
    match fetch(cli) {
        Ok(pending) => publish(state, app, generation, None, pending),
        Err(error) => eprintln!("Could not poll pending approvals: {error}"),
    }
}

#[cfg(target_os = "linux")]
pub(crate) fn poll_native(state: &DesktopState, app: &AppHandle, generation: u64) -> bool {
    let gateway = app.state::<GatewayClient>();
    let Some(route) = gateway.local_watchdog_generation() else {
        return false;
    };
    // Owned recovery pages may still need CLI service facts and a dashboard URL.
    let dashboard = main_window(app)
        .ok()
        .and_then(|view| view.url().ok())
        .is_some_and(|url| !state.main_window_has_local_url(&url));
    if !dashboard {
        return false;
    }
    let Ok((nodes, devices)) = tauri::async_runtime::block_on(gateway.pairing_lists(route)) else {
        return false;
    };
    let (Ok(nodes), Ok(devices)) = (
        serde_json::from_value::<NodePairingList>(nodes),
        serde_json::from_value::<DevicePairingList>(devices),
    ) else {
        return false;
    };
    publish(
        state,
        app,
        generation,
        Some(route),
        approvals(nodes.pending, devices),
    );
    true
}

fn publish(
    state: &DesktopState,
    app: &AppHandle,
    generation: u64,
    route: Option<GatewayGeneration>,
    pending: Vec<PendingApproval>,
) {
    let diff = {
        let navigation = state.inner.navigation.lock().expect("navigation");
        if !navigation.watchdog_is_current(generation) {
            return;
        }
        let update = || {
            Ok(state
                .inner
                .pending_approvals
                .lock()
                .expect("pending approval mutex poisoned")
                .update(pending))
        };
        match route {
            Some(route) => app.state::<GatewayClient>().with_generation(route, update),
            None => update(),
        }
    };
    let Ok(diff) = diff else {
        return;
    };
    state.with_tray(|tray| tray.update_pending_count(diff.count));
    if main_window(app).is_ok_and(|view| matches!(view.window().is_focused(), Ok(false))) {
        for request in diff.new {
            notify::notify(app, "OpenClaw", &request.notification_body());
        }
    }
}

fn preferred_label<'a>(candidates: impl IntoIterator<Item = Option<&'a str>>) -> String {
    candidates
        .into_iter()
        .flatten()
        .map(str::trim)
        .find(|value| !value.is_empty())
        .unwrap_or("unknown")
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::{ApprovalKind, PendingApproval, PendingApprovalState};

    fn request(kind: ApprovalKind, id: &str, label: &str) -> PendingApproval {
        PendingApproval {
            kind,
            request_id: id.to_string(),
            label: label.to_string(),
        }
    }

    #[test]
    fn state_deduplicates_snapshot_and_retained_ids_and_forgets_removed_ids() {
        let node = request(ApprovalKind::Node, "request-1", "Kitchen Mac");
        let device = request(ApprovalKind::Device, "request-2", "Browser");
        let mut state = PendingApprovalState::default();

        let first = state.update(vec![
            node.clone(),
            node.clone(),
            request(ApprovalKind::Device, "request-1", "Browser"),
            device.clone(),
        ]);
        assert_eq!(first.new, vec![node.clone(), device.clone()]);
        assert_eq!(first.count, 2);

        let retained = state.update(vec![device.clone()]);
        assert!(retained.new.is_empty());
        assert_eq!(retained.count, 1);

        let returned = state.update(vec![node.clone(), device]);
        assert_eq!(returned.new, vec![node]);
        assert_eq!(returned.count, 2);
    }

    #[test]
    fn notification_copy_names_request_kind_and_source() {
        assert_eq!(
            request(ApprovalKind::Node, "request-1", "Kitchen Mac").notification_body(),
            "Node pairing request from Kitchen Mac — open OpenClaw to approve"
        );
        assert_eq!(
            request(ApprovalKind::Device, "request-2", "Browser").notification_body(),
            "Device pairing request from Browser — open OpenClaw to approve"
        );
    }
}
