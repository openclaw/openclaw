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
pub use crate::model::gateway_menu::GatewayStatus;
use crate::model::gateway_menu::{
    MenuRow, NativeMenuEntry, menu_rows, native_entries, profile_statuses,
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

#[derive(Action, Clone, PartialEq, Deserialize)]
#[action(namespace = openclaw, no_json)]
pub struct NewGatewayWindow {
    pub index: usize,
}

struct GatewayWindow {
    handle: AnyWindowHandle,
    view_id: EntityId,
}

pub struct GatewayWindows {
    runtime: Handle,
    pub profiles: Vec<GatewayProfile>,
    pub primary: Option<String>,
    windows: BTreeMap<String, Vec<GatewayWindow>>,
    statuses: BTreeMap<EntityId, (String, GatewayStatus)>,
    menu_rows: Option<Vec<MenuRow>>,
    focused: Option<String>,
    manager: Option<AnyWindowHandle>,
}
impl Global for GatewayWindows {}

pub fn snapshot(current: Option<&str>, cx: &App) -> Vec<MenuRow> {
    let Some(fleet) = cx.try_global::<GatewayWindows>() else {
        return Vec::new();
    };
    let statuses = profile_statuses(
        fleet
            .statuses
            .values()
            .map(|(id, status)| (id.as_str(), *status)),
    );
    menu_rows(
        &fleet.profiles,
        fleet.primary.as_deref(),
        current,
        &statuses,
    )
}

pub fn set_primary(id: &str, cx: &mut App) -> Result<(), String> {
    ProfileStore::load()?.set_primary(id)?;
    reload(cx)
}

pub fn open_id(id: &str, cx: &mut App) {
    if let Some(profile) = cx
        .global::<GatewayWindows>()
        .profiles
        .iter()
        .find(|p| p.id == id)
        .cloned()
    {
        open_profile(profile, cx);
    }
}

pub fn install(runtime: Handle, store: &ProfileStore, cx: &mut App) {
    cx.set_global(GatewayWindows {
        runtime,
        profiles: store.list(),
        primary: store.primary_id().map(str::to_owned),
        windows: BTreeMap::new(),
        statuses: BTreeMap::new(),
        menu_rows: None,
        focused: None,
        manager: None,
    });
    for index in 0..9 {
        cx.bind_keys([
            KeyBinding::new(&format!("cmd-{}", index + 1), OpenGateway { index }, None),
            KeyBinding::new(
                &format!("cmd-alt-{}", index + 1),
                NewGatewayWindow { index },
                None,
            ),
        ]);
    }
    cx.on_action(|action: &OpenGateway, cx| {
        if let Some(row) = snapshot(None, cx).get(action.index) {
            open_id(&row.id, cx);
        }
    });
    cx.on_action(|action: &NewGatewayWindow, cx| {
        if let Some(row) = snapshot(None, cx).get(action.index)
            && let Some(profile) = cx
                .global::<GatewayWindows>()
                .profiles
                .iter()
                .find(|p| p.id == row.id)
                .cloned()
        {
            let config = config::for_profile(&profile);
            open(Some(profile), config, cx);
        }
    });
    cx.on_action(|_: &crate::ManageGateways, cx| manage(cx));
    cx.on_window_closed(|cx, _| {
        let remaining = cx.windows();
        let fleet = cx.global_mut::<GatewayWindows>();
        fleet.windows.retain(|_, windows| {
            windows.retain(|window| remaining.contains(&window.handle));
            !windows.is_empty()
        });
        fleet.statuses.retain(|view, _| {
            fleet
                .windows
                .values()
                .flatten()
                .any(|window| window.view_id == *view)
        });
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
        cx.refresh_windows();
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
    cx.refresh_windows();
    Ok(())
}

pub fn focus(profile: Option<&str>, cx: &mut App) {
    if cx.try_global::<GatewayWindows>().is_none() {
        return;
    }
    let active = cx.active_window();
    if let Some(id) = profile
        && let Some(windows) = cx.global_mut::<GatewayWindows>().windows.get_mut(id)
        && let Some(index) = windows
            .iter()
            .position(|window| Some(window.handle) == active)
    {
        let window = windows.remove(index);
        windows.push(window);
    }
    let fleet = cx.global::<GatewayWindows>();
    if fleet.focused.as_deref() == profile {
        return;
    }
    cx.global_mut::<GatewayWindows>().focused = profile.map(str::to_owned);
    refresh_menus(cx);
}

pub fn status<T: 'static>(profile: Option<&str>, status: GatewayStatus, cx: &mut Context<T>) {
    let Some(id) = profile else {
        return;
    };
    let Some(fleet) = cx.try_global::<GatewayWindows>() else {
        return;
    };
    let view_id = cx.entity_id();
    if fleet
        .statuses
        .get(&view_id)
        .is_some_and(|(_, previous)| *previous == status)
    {
        return;
    }
    cx.global_mut::<GatewayWindows>()
        .statuses
        .insert(view_id, (id.to_owned(), status));
    refresh_menus(cx);
    cx.refresh_windows();
}

pub fn close_profile(id: &str, cx: &mut App) -> bool {
    let windows = cx
        .global_mut::<GatewayWindows>()
        .windows
        .remove(id)
        .unwrap_or_default();
    let mut closed = false;
    for window in windows {
        closed |= window
            .handle
            .update(cx, |_, window, _| window.remove_window())
            .is_ok();
    }
    closed
}

pub fn open_profile(profile: GatewayProfile, cx: &mut App) {
    let handles: Vec<_> = cx
        .global::<GatewayWindows>()
        .windows
        .get(&profile.id)
        .map(|windows| windows.iter().rev().map(|window| window.handle).collect())
        .unwrap_or_default();
    for handle in handles {
        if handle
            .update(cx, |_, window, _| {
                if activates() {
                    window.activate_window();
                }
            })
            .is_ok()
        {
            focus(Some(&profile.id), cx);
            if activates() {
                cx.activate(true);
            }
            return;
        }
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
    let mut view_id = None;
    match cx.open_window(
        WindowOptions {
            window_bounds: Some(WindowBounds::Windowed(bounds)),
            window_min_size: Some(metrics::GATEWAY_MIN_SIZE),
            app_id: Some("ai.openclaw.gpui".into()),
            focus: activates(),
            ..TitleBar::window_options()
        },
        |window, cx| {
            window.set_window_title(&title);
            crate::ui::theme::apply(window, cx);
            let view = cx.new(|cx| crate::ui::AppView::new(runtime, config, profile, window, cx));
            view_id = Some(view.entity_id());
            cx.new(|cx| Root::new(view, window, cx))
        },
    ) {
        Ok(handle) => {
            if let (Some(id), Some(view_id)) = (id, view_id) {
                cx.global_mut::<GatewayWindows>()
                    .windows
                    .entry(id.clone())
                    .or_default()
                    .push(GatewayWindow {
                        handle: handle.into(),
                        view_id,
                    });
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
    let rows = snapshot(fleet.focused.as_deref(), cx);
    let structure_changed = fleet.menu_rows.as_ref().is_none_or(|previous| {
        previous.len() != rows.len()
            || !previous
                .iter()
                .zip(&rows)
                .all(|(a, b)| a.has_same_structure(b))
    });
    if structure_changed || !cfg!(target_os = "macos") {
        let items = native_entries(&rows).into_iter().map(|entry| match entry {
            NativeMenuEntry::Gateway {
                index,
                new_window: false,
            } => MenuItem::action(rows[index].name.clone(), OpenGateway { index })
                .checked(rows[index].checked),
            NativeMenuEntry::Gateway {
                index,
                new_window: true,
            } => MenuItem::action(rows[index].new_window_title(), NewGatewayWindow { index }),
            NativeMenuEntry::Separator => MenuItem::separator(),
            NativeMenuEntry::Manage => MenuItem::action("Manage Gateways…", crate::ManageGateways),
        });
        crate::set_menus(Menu::new("Gateways").items(items), cx);
    }
    #[cfg(target_os = "macos")]
    crate::gateway_menu_macos::update(&rows);
    cx.global_mut::<GatewayWindows>().menu_rows = Some(rows);
}
