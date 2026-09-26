use std::collections::BTreeMap;

use gpui_kit::{
    component::{Root, TitleBar},
    *,
};
use serde::Deserialize;
use tokio::runtime::Handle;

use crate::gateway::{
    config::{self, ConnectionConfig},
    profiles::{GatewayProfile, ProfileStore},
};
use crate::ui::theme::tokens::window as metrics;

/// `OPENCLAW_GPUI_BACKGROUND=1` opens and reuses windows without activating the
/// app, so UI automation (Peekaboo background input) never steals focus.
fn activates() -> bool {
    std::env::var_os("OPENCLAW_GPUI_BACKGROUND").as_deref() != Some(std::ffi::OsStr::new("1"))
}

#[derive(Action, Clone, PartialEq, Deserialize)]
#[action(namespace = openclaw, no_json)]
pub struct OpenGateway {
    pub index: usize,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum GatewayStatus {
    Connected,
    Connecting,
    NeedsSignIn,
    #[default]
    Offline,
}

impl GatewayStatus {
    fn label(self) -> &'static str {
        match self {
            Self::Connected => "🟢",
            Self::Connecting => "🟡",
            Self::NeedsSignIn => "🟠",
            Self::Offline => "⚪",
        }
    }
}

pub struct GatewayWindows {
    runtime: Handle,
    pub profiles: Vec<GatewayProfile>,
    pub primary: Option<String>,
    windows: BTreeMap<String, AnyWindowHandle>,
    statuses: BTreeMap<String, GatewayStatus>,
    focused: Option<String>,
    manager: Option<AnyWindowHandle>,
}
impl Global for GatewayWindows {}

#[derive(Debug, PartialEq, Eq)]
pub struct MenuRow {
    pub id: String,
    pub name: String,
    pub number: Option<usize>,
    pub primary: bool,
    pub checked: bool,
    pub status: GatewayStatus,
}

pub fn menu_rows(
    profiles: &[GatewayProfile],
    primary: Option<&str>,
    focused: Option<&str>,
    statuses: &BTreeMap<String, GatewayStatus>,
) -> Vec<MenuRow> {
    let mut ordered: Vec<_> = profiles.iter().collect();
    ordered.sort_by_key(|p| (Some(p.id.as_str()) != primary, p.order, &p.id));
    ordered
        .iter()
        .enumerate()
        .map(|(index, p)| MenuRow {
            id: p.id.clone(),
            name: p.name.clone(),
            number: (index < 9).then_some(index + 1),
            primary: Some(p.id.as_str()) == primary,
            checked: Some(p.id.as_str()) == focused,
            status: statuses.get(&p.id).copied().unwrap_or_default(),
        })
        .collect()
}

pub fn install(runtime: Handle, store: &ProfileStore, cx: &mut App) {
    cx.set_global(GatewayWindows {
        runtime,
        profiles: store.list(),
        primary: store.primary_id().map(str::to_owned),
        windows: BTreeMap::new(),
        statuses: BTreeMap::new(),
        focused: None,
        manager: None,
    });
    for index in 0..9 {
        cx.bind_keys([KeyBinding::new(
            &format!("cmd-{}", index + 1),
            OpenGateway { index },
            None,
        )]);
    }
    cx.on_action(|action: &OpenGateway, cx| {
        let profile = cx
            .global::<GatewayWindows>()
            .profiles
            .get(action.index)
            .cloned();
        if let Some(profile) = profile {
            open_profile(profile, cx);
        }
    });
    cx.on_action(|_: &crate::ManageGateways, cx| manage(cx));
    cx.on_window_closed(|cx, _| {
        let remaining = cx.windows();
        let fleet = cx.global_mut::<GatewayWindows>();
        fleet.windows.retain(|_, handle| remaining.contains(handle));
        fleet
            .statuses
            .retain(|id, _| fleet.windows.contains_key(id));
        if fleet
            .focused
            .as_ref()
            .is_some_and(|id| !fleet.windows.contains_key(id))
        {
            fleet.focused = None;
        }
        if fleet
            .manager
            .is_some_and(|handle| !remaining.contains(&handle))
        {
            fleet.manager = None;
        }
        refresh_menus(cx);
        if remaining.is_empty() {
            cx.quit();
        }
    })
    .detach();
    refresh_menus(cx);
}

pub fn reload(cx: &mut App) -> Result<(), String> {
    let store = ProfileStore::load()?;
    let fleet = cx.global_mut::<GatewayWindows>();
    fleet.profiles = store.list();
    fleet.primary = store.primary_id().map(str::to_owned);
    refresh_menus(cx);
    Ok(())
}

pub fn focus(profile: Option<&str>, cx: &mut App) {
    let Some(fleet) = cx.try_global::<GatewayWindows>() else {
        return;
    };
    if fleet.focused.as_deref() == profile {
        return;
    }
    cx.global_mut::<GatewayWindows>().focused = profile.map(str::to_owned);
    refresh_menus(cx);
}

pub fn status(profile: Option<&str>, status: GatewayStatus, cx: &mut App) {
    let Some(id) = profile else {
        return;
    };
    let Some(fleet) = cx.try_global::<GatewayWindows>() else {
        return;
    };
    if fleet.statuses.get(id) == Some(&status) {
        return;
    }
    cx.global_mut::<GatewayWindows>()
        .statuses
        .insert(id.to_owned(), status);
    refresh_menus(cx);
}

pub fn close_profile(id: &str, cx: &mut App) -> bool {
    let handle = cx.global_mut::<GatewayWindows>().windows.remove(id);
    handle.is_some_and(|handle| {
        handle
            .update(cx, |_, window, _| window.remove_window())
            .is_ok()
    })
}

pub fn open_profile(profile: GatewayProfile, cx: &mut App) {
    if let Some(handle) = cx
        .global::<GatewayWindows>()
        .windows
        .get(&profile.id)
        .copied()
        && handle
            .update(cx, |_, window, _| {
                if activates() {
                    window.activate_window();
                }
            })
            .is_ok()
    {
        if activates() {
            cx.activate(true);
        }
        return;
    }
    let config = config::for_profile(&profile);
    open(Some(profile), config, cx);
}

pub fn open(
    profile: Option<GatewayProfile>,
    config: Result<ConnectionConfig, String>,
    cx: &mut App,
) {
    let runtime = cx.global::<GatewayWindows>().runtime.clone();
    let title = profile.as_ref().map_or("OpenClaw", |p| &p.name).to_owned();
    let id = profile.as_ref().map(|p| p.id.clone());
    let bounds = Bounds::centered(None, metrics::GATEWAY_SIZE, cx);
    match cx.open_window(
        WindowOptions {
            window_bounds: Some(WindowBounds::Windowed(bounds)),
            window_min_size: Some(metrics::GATEWAY_MIN_SIZE),
            app_id: Some("org.openclaw.gpui".into()),
            focus: activates(),
            ..TitleBar::window_options()
        },
        |window, cx| {
            window.set_window_title(&title);
            crate::ui::theme::apply(window, cx);
            let view = cx.new(|cx| crate::ui::AppView::new(runtime, config, profile, window, cx));
            cx.new(|cx| Root::new(view, window, cx))
        },
    ) {
        Ok(handle) => {
            if let Some(id) = id {
                cx.global_mut::<GatewayWindows>()
                    .windows
                    .insert(id.clone(), handle.into());
                focus(Some(&id), cx);
            }
            if activates() {
                cx.activate(true);
            }
        }
        Err(error) => log::error!("Could not open Gateway window: {error}"),
    }
}

pub fn manage(cx: &mut App) {
    if let Some(handle) = cx.global::<GatewayWindows>().manager
        && handle
            .update(cx, |_, window, _| {
                if activates() {
                    window.activate_window();
                }
            })
            .is_ok()
    {
        if activates() {
            cx.activate(true);
        }
        return;
    }
    let bounds = Bounds::centered(None, metrics::MANAGER_SIZE, cx);
    match cx.open_window(
        WindowOptions {
            window_bounds: Some(WindowBounds::Windowed(bounds)),
            window_min_size: Some(metrics::MANAGER_MIN_SIZE),
            focus: activates(),
            ..TitleBar::window_options()
        },
        |window, cx| {
            window.set_window_title("Manage Gateways");
            crate::ui::theme::apply(window, cx);
            let view = cx.new(|cx| crate::ui::gateway_manager::GatewayManager::new(window, cx));
            cx.new(|cx| Root::new(view, window, cx))
        },
    ) {
        Ok(handle) => {
            cx.global_mut::<GatewayWindows>().manager = Some(handle.into());
            focus(None, cx);
            if activates() {
                cx.activate(true);
            }
        }
        Err(error) => log::error!("Could not open Manage Gateways: {error}"),
    }
}

fn refresh_menus(cx: &mut App) {
    let fleet = cx.global::<GatewayWindows>();
    let rows = menu_rows(
        &fleet.profiles,
        fleet.primary.as_deref(),
        fleet.focused.as_deref(),
        &fleet.statuses,
    );
    let mut items = Vec::new();
    for (index, row) in rows.iter().enumerate() {
        items.push(
            MenuItem::action(
                format!("{}  {}", row.status.label(), row.name),
                OpenGateway { index },
            )
            .checked(row.checked),
        );
        if row.primary && rows.len() > 1 {
            items.push(MenuItem::separator());
        }
    }
    if !rows.is_empty() {
        items.push(MenuItem::separator());
    }
    items.push(MenuItem::action("Manage Gateways…", crate::ManageGateways));
    crate::set_menus(Menu::new("Gateways").items(items), cx);
}

#[cfg(test)]
mod tests {
    use super::{GatewayStatus, menu_rows};
    use crate::gateway::profiles::{GatewayKind, GatewayProfile};
    use std::collections::BTreeMap;

    #[test]
    fn menu_keeps_primary_first_numbers_nine_and_checks_only_focused_profile() {
        let profiles: Vec<_> = (0..11)
            .map(|n| GatewayProfile {
                id: format!("g{n}"),
                name: format!("Gateway {n}"),
                order: n,
                kind: GatewayKind::Direct {
                    url: format!("wss://g{n}.example/"),
                },
            })
            .collect();
        let statuses = BTreeMap::from([("g3".into(), GatewayStatus::Connected)]);
        let rows = menu_rows(&profiles, Some("g5"), Some("g3"), &statuses);
        assert_eq!(
            rows.iter().map(|r| r.id.as_str()).collect::<Vec<_>>(),
            [
                "g5", "g0", "g1", "g2", "g3", "g4", "g6", "g7", "g8", "g9", "g10"
            ]
        );
        assert!(rows[0].primary);
        assert!(!rows[0].checked);
        assert!(rows[4].checked);
        assert_eq!(rows[4].status, GatewayStatus::Connected);
        assert_eq!(rows.iter().filter(|r| r.checked).count(), 1);
        assert_eq!(
            rows.iter().filter_map(|r| r.number).collect::<Vec<_>>(),
            (1..=9).collect::<Vec<_>>()
        );
        assert!(
            menu_rows(&profiles, Some("g5"), None, &statuses)
                .iter()
                .all(|r| !r.checked)
        );
    }
}
