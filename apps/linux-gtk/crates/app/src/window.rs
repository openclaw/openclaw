use gtk4::{self, gio, glib, Orientation, SelectionMode};
use libadwaita as adw;
use libadwaita::prelude::*;

use crate::state::{AppState, SharedClient};
use crate::views;

/// Full sidebar nav items matching dashboard-lit.
/// (id, label, icon_name)
const NAV_ITEMS: &[(&str, &str, &str)] = &[
    // Chat
    ("chat", "Chat", "chat-bubble-text-symbolic"),
    // Control
    ("overview", "Overview", "utilities-system-monitor-symbolic"),
    ("channels", "Channels", "network-transmit-symbolic"),
    ("instances", "Instances", "network-server-symbolic"),
    ("sessions", "Sessions", "view-list-symbolic"),
    ("usage", "Usage", "preferences-system-time-symbolic"),
    ("cron", "Cron", "alarm-symbolic"),
    ("retros", "Retrospectives", "help-browser-symbolic"),
    ("workflows", "Workflows", "media-playlist-consecutive-symbolic"),
    // Agent
    ("agents", "Agents", "system-users-symbolic"),
    ("skills", "Skills", "starred-symbolic"),
    // Settings
    ("config", "Config", "document-edit-symbolic"),
    ("settings", "Settings", "emblem-system-symbolic"),
    ("debug", "Debug", "dialog-warning-symbolic"),
    ("logs", "Logs", "utilities-terminal-symbolic"),
    ("control-room", "Control Room", "computer-symbolic"),
    ("about", "About", "help-about-symbolic"),
];

pub struct OpenClawWindow;

impl OpenClawWindow {
    pub fn build(
        app: &adw::Application,
        state: AppState,
        client: SharedClient,
    ) -> adw::ApplicationWindow {
        let window = adw::ApplicationWindow::builder()
            .application(app)
            .title("OpenClaw")
            .default_width(1100)
            .default_height(700)
            .icon_name("ai.openclaw.desktop")
            .build();

        // Top-level stack: onboarding vs main.
        // NOTE: No Crossfade transition — cross-monitor moves with different
        // scale factors have triggered X11 BadDrawable during the fade redraw.
        let root_stack = gtk4::Stack::builder()
            .transition_type(gtk4::StackTransitionType::None)
            .build();

        let main_layout = Self::build_main_layout(state.clone(), client.clone());
        root_stack.add_named(&main_layout, Some("main"));

        // Onboarding
        let rs = root_stack.clone();
        let onboarding = views::onboarding::OnboardingView::new(
            state.clone(),
            client.clone(),
            move || rs.set_visible_child_name("main"),
        );
        let onboard_wrap = adw::ToolbarView::new();
        onboard_wrap.add_top_bar(
            &adw::HeaderBar::builder()
                .title_widget(&gtk4::Label::new(Some("OpenClaw")))
                .build(),
        );
        onboard_wrap.set_content(Some(onboarding.widget()));
        root_stack.add_named(&onboard_wrap, Some("onboarding"));

        // Show main by default. Only fall back to onboarding if we have no
        // token configured at all (fresh install).
        // NOTE: avoid flipping root_stack on a timer while widgets are still
        // being realized — cross-stack mid-frame switches with ToolbarView
        // children have triggered X11 BadDrawable on XRender picture reuse.
        let has_token = std::env::var("OPENCLAW_GATEWAY_TOKEN").is_ok()
            || dirs::home_dir()
                .map(|h| h.join(".openclaw/openclaw.json"))
                .and_then(|p| std::fs::read_to_string(&p).ok())
                .map(|s| s.contains("\"token\"") && !s.contains("\"token\": null"))
                .unwrap_or(false);
        if has_token {
            root_stack.set_visible_child_name("main");
        } else {
            root_stack.set_visible_child_name("onboarding");
        }

        window.set_content(Some(&root_stack));

        // ===== RESPONSIVE BREAKPOINTS (libadwaita) =====
        // Collapse the sidebar when the window gets narrow (phone/split-screen).
        // This is the canonical libadwaita responsive pattern used by
        // GNOME Weather, Files, Software, etc.
        Self::install_breakpoints(&window, &main_layout);

        window
    }

    /// Install libadwaita breakpoints on the window so the split view
    /// automatically collapses on narrow screens / when the window is resized.
    fn install_breakpoints(
        window: &adw::ApplicationWindow,
        split_view: &adw::OverlaySplitView,
    ) {
        // Breakpoint 1: narrow (< 600sp) — collapse sidebar into a drawer.
        let narrow = adw::Breakpoint::new(adw::BreakpointCondition::new_length(
            adw::BreakpointConditionLengthType::MaxWidth,
            600.0,
            adw::LengthUnit::Sp,
        ));
        narrow.add_setter(split_view, "collapsed", Some(&true.to_value()));
        // Hide the sidebar by default on narrow so the user isn't staring at it
        // on first paint; they can open it via the header button we add below.
        narrow.add_setter(split_view, "show-sidebar", Some(&false.to_value()));
        window.add_breakpoint(narrow);
    }

    fn build_main_layout(state: AppState, client: SharedClient) -> adw::OverlaySplitView {
        // ===== SIDEBAR =====
        // Use ToolbarView directly — no extra Box wrapper. Let OverlaySplitView
        // control width via min/max/fraction so it stays responsive.
        let sidebar_toolbar = adw::ToolbarView::new();
        let sidebar_header = adw::HeaderBar::builder()
            .show_end_title_buttons(false)
            .show_start_title_buttons(false)
            .build();

        let logo = gtk4::Label::builder()
            .label("OpenClaw")
            .css_classes(vec!["title-4".to_string()])
            .build();
        sidebar_header.set_title_widget(Some(&logo));

        // Hamburger menu
        let app_menu = gio::Menu::new();
        let section1 = gio::Menu::new();
        section1.append(Some("Preferences"), Some("app.preferences"));
        section1.append(Some("Documentation"), Some("app.docs"));
        app_menu.append_section(None, &section1);
        let section2 = gio::Menu::new();
        section2.append(Some("About OpenClaw"), Some("app.about"));
        app_menu.append_section(None, &section2);

        let menu_btn = gtk4::MenuButton::builder()
            .icon_name("open-menu-symbolic")
            .menu_model(&app_menu)
            .css_classes(vec!["flat".to_string()])
            .build();
        sidebar_header.pack_end(&menu_btn);

        sidebar_toolbar.add_top_bar(&sidebar_header);

        // Nav list
        let nav_list = gtk4::ListBox::builder()
            .selection_mode(SelectionMode::Single)
            .css_classes(vec!["navigation-sidebar".to_string()])
            .vexpand(true)
            .build();

        Self::add_group_header(&nav_list, "Chat");
        Self::add_nav_row(&nav_list, "chat", "Chat", "chat-bubble-text-symbolic");

        Self::add_group_header(&nav_list, "Control");
        Self::add_nav_row(&nav_list, "overview", "Overview", "utilities-system-monitor-symbolic");
        Self::add_nav_row(&nav_list, "channels", "Channels", "network-transmit-symbolic");
        Self::add_nav_row(&nav_list, "instances", "Instances", "network-server-symbolic");
        Self::add_nav_row(&nav_list, "sessions", "Sessions", "view-list-symbolic");
        Self::add_nav_row(&nav_list, "usage", "Usage", "preferences-system-time-symbolic");
        Self::add_nav_row(&nav_list, "cron", "Cron", "alarm-symbolic");
        Self::add_nav_row(&nav_list, "retros", "Retrospectives", "help-browser-symbolic");
        Self::add_nav_row(&nav_list, "workflows", "Workflows", "media-playlist-consecutive-symbolic");

        Self::add_group_header(&nav_list, "Agent");
        Self::add_nav_row(&nav_list, "agents", "Agents", "system-users-symbolic");
        Self::add_nav_row(&nav_list, "skills", "Skills", "starred-symbolic");

        Self::add_group_header(&nav_list, "Settings");
        Self::add_nav_row(&nav_list, "config", "Config", "document-edit-symbolic");
        Self::add_nav_row(&nav_list, "settings", "Settings", "emblem-system-symbolic");
        Self::add_nav_row(&nav_list, "debug", "Debug", "dialog-warning-symbolic");
        Self::add_nav_row(&nav_list, "logs", "Logs", "utilities-terminal-symbolic");
        Self::add_nav_row(&nav_list, "control-room", "Control Room", "computer-symbolic");
        Self::add_nav_row(&nav_list, "about", "About", "help-about-symbolic");

        if let Some(chat_row) = nav_list.row_at_index(1) {
            nav_list.select_row(Some(&chat_row));
        }

        let nav_scroll = gtk4::ScrolledWindow::builder()
            .child(&nav_list)
            .hscrollbar_policy(gtk4::PolicyType::Never)
            .vexpand(true)
            .build();

        // Sidebar footer
        let footer = gtk4::Box::builder()
            .orientation(Orientation::Vertical)
            .spacing(4)
            .margin_start(12)
            .margin_end(12)
            .margin_top(8)
            .margin_bottom(8)
            .build();

        let status_row = gtk4::Box::builder()
            .orientation(Orientation::Horizontal)
            .spacing(6)
            .build();

        let status_dot = gtk4::Label::builder()
            .label("\u{25CF}")
            .css_classes(vec!["status-dot".to_string(), "disconnected".to_string()])
            .build();

        let status_text = gtk4::Label::builder()
            .label("Connecting...")
            .css_classes(vec!["caption".to_string(), "dim-label".to_string()])
            .halign(gtk4::Align::Start)
            .hexpand(true)
            .ellipsize(gtk4::pango::EllipsizeMode::End)
            .build();

        status_row.append(&status_dot);
        status_row.append(&status_text);

        // Service status row (systemd openclaw-gateway.service)
        let service_row = gtk4::Box::builder()
            .orientation(Orientation::Horizontal)
            .spacing(6)
            .build();

        let service_dot = gtk4::Label::builder()
            .label("\u{25CF}")
            .css_classes(vec!["status-dot".to_string(), "disconnected".to_string()])
            .build();

        let service_text = gtk4::Label::builder()
            .label("Service: checking...")
            .css_classes(vec!["caption".to_string(), "dim-label".to_string()])
            .halign(gtk4::Align::Start)
            .hexpand(true)
            .ellipsize(gtk4::pango::EllipsizeMode::End)
            .build();

        service_row.append(&service_dot);
        service_row.append(&service_text);

        let docs_btn = gtk4::LinkButton::builder()
            .label("Docs")
            .uri("https://docs.openclaw.ai")
            .halign(gtk4::Align::Start)
            .build();
        docs_btn.add_css_class("caption");

        footer.append(&status_row);
        footer.append(&service_row);
        footer.append(&docs_btn);

        // Assemble sidebar
        let sidebar_content = gtk4::Box::new(Orientation::Vertical, 0);
        sidebar_content.append(&nav_scroll);
        sidebar_content.append(&gtk4::Separator::new(Orientation::Horizontal));
        sidebar_content.append(&footer);

        sidebar_toolbar.set_content(Some(&sidebar_content));

        // ===== CONTENT =====
        let content_toolbar = adw::ToolbarView::new();

        // Content header bar with page title, agent/session dropdowns, and connection chip
        let content_header = adw::HeaderBar::new();

        // Sidebar toggle button — shown when sidebar is collapsed (responsive).
        let sidebar_toggle = gtk4::ToggleButton::builder()
            .icon_name("sidebar-show-symbolic")
            .tooltip_text("Toggle sidebar")
            .css_classes(vec!["flat".to_string()])
            .build();
        content_header.pack_start(&sidebar_toggle);

        let page_title = gtk4::Label::builder()
            .label("Chat")
            .css_classes(vec!["title-3".to_string()])
            .build();
        content_header.set_title_widget(Some(&page_title));

        // Agent selector dropdown. Max width caps prevent a long agent
        // name from blowing the header layout out at narrow widths.
        let agent_dropdown = gtk4::DropDown::from_strings(&["Default Agent"]);
        agent_dropdown.set_valign(gtk4::Align::Center);
        agent_dropdown.set_css_classes(&["flat"]);
        agent_dropdown.set_width_request(140);

        // Session selector dropdown
        let session_dropdown = gtk4::DropDown::from_strings(&["default"]);
        session_dropdown.set_valign(gtk4::Align::Center);
        session_dropdown.set_css_classes(&["flat"]);
        session_dropdown.set_width_request(180);

        // Refresh button — triggers a fresh fetch of
        // agents/sessions/models/channels caches from the gateway.
        let refresh_btn = gtk4::Button::builder()
            .icon_name("view-refresh-symbolic")
            .tooltip_text("Reload agents, sessions, models, and channels")
            .css_classes(vec!["flat".to_string()])
            .valign(gtk4::Align::Center)
            .build();

        // Connection indicator chip
        let conn_chip = gtk4::Label::builder()
            .label("...")
            .css_classes(vec!["status-chip".to_string()])
            .valign(gtk4::Align::Center)
            .build();

        // pack_end packs right-to-left: conn_chip pins furthest right,
        // then session dropdown, agent dropdown, refresh. Group
        // dropdowns in one subcontainer so they collapse together when
        // the header needs to shrink.
        let dropdowns_row = gtk4::Box::builder()
            .orientation(Orientation::Horizontal)
            .spacing(4)
            .valign(gtk4::Align::Center)
            .build();
        dropdowns_row.append(&agent_dropdown);
        dropdowns_row.append(&session_dropdown);

        content_header.pack_end(&conn_chip);
        content_header.pack_end(&refresh_btn);
        content_header.pack_end(&dropdowns_row);

        content_toolbar.add_top_bar(&content_header);

        // Content stack — one child per view.
        // hhomogeneous/vhomogeneous=false so the stack doesn't force all 17
        // child views to realize + allocate up front (that hammer-prerender
        // pass is what creates the flood of Pixmaps that triggers
        // XRenderComposite BadDrawable on X11).
        // Also no transition — same reason: no cross-child compositing.
        let content_stack = gtk4::Stack::builder()
            .transition_type(gtk4::StackTransitionType::None)
            .hhomogeneous(false)
            .vhomogeneous(false)
            .vexpand(true)
            .hexpand(true)
            .build();

        // Build all views
        let chat_view = views::chat::ChatView::new(state.clone(), client.clone());
        content_stack.add_named(chat_view.widget(), Some("chat"));

        let overview_view = views::overview::OverviewView::new(state.clone());
        content_stack.add_named(overview_view.widget(), Some("overview"));

        let channels_view = views::channels::ChannelsView::new(state.clone(), client.clone());
        content_stack.add_named(channels_view.widget(), Some("channels"));

        let sessions_view = views::sessions::SessionsView::new(state.clone(), client.clone());
        content_stack.add_named(sessions_view.widget(), Some("sessions"));

        let agents_view = views::agents::AgentsView::new(state.clone(), client.clone());
        content_stack.add_named(agents_view.widget(), Some("agents"));

        let skills_view = views::skills::SkillsView::new(client.clone());
        content_stack.add_named(skills_view.widget(), Some("skills"));

        let usage_view = views::usage::UsageView::new(client.clone());
        content_stack.add_named(usage_view.widget(), Some("usage"));

        let cron_view = views::cron::CronView::new(client.clone());
        content_stack.add_named(cron_view.widget(), Some("cron"));

        let settings_view = views::settings::SettingsView::new(state.clone(), client.clone());
        content_stack.add_named(settings_view.widget(), Some("settings"));

        let about_view = views::about::AboutView::new();
        content_stack.add_named(about_view.widget(), Some("about"));

        let instances_view = views::instances::InstancesView::new(client.clone());
        content_stack.add_named(instances_view.widget(), Some("instances"));

        let retros_view = views::retros::RetrosView::new(client.clone());
        content_stack.add_named(retros_view.widget(), Some("retros"));

        let workflows_view = views::workflows::WorkflowsView::new(client.clone());
        content_stack.add_named(workflows_view.widget(), Some("workflows"));

        let config_view = views::config::ConfigView::new(client.clone());
        content_stack.add_named(config_view.widget(), Some("config"));

        let debug_view = views::debug::DebugView::new(state.clone(), client.clone());
        content_stack.add_named(debug_view.widget(), Some("debug"));

        let logs_view = views::logs::LogsView::new(client.clone());
        content_stack.add_named(logs_view.widget(), Some("logs"));

        let control_room_view = views::control_room::ControlRoomView::new(state.clone(), client.clone());
        content_stack.add_named(control_room_view.widget(), Some("control-room"));

        content_toolbar.set_content(Some(&content_stack));

        // ===== SPLIT VIEW =====
        let split_view = adw::OverlaySplitView::builder()
            .sidebar(&sidebar_toolbar)
            .content(&content_toolbar)
            .min_sidebar_width(200.0)
            .max_sidebar_width(260.0)
            .sidebar_width_fraction(0.22)
            .build();

        // Bind toggle button <-> sidebar visibility (two-way sync).
        split_view
            .bind_property("show-sidebar", &sidebar_toggle, "active")
            .bidirectional()
            .sync_create()
            .build();

        // -- Refresh button: re-fetch snapshot RPCs --
        let state_refresh = state.clone();
        let client_refresh = client.clone();
        refresh_btn.connect_clicked(move |_| {
            crate::bridge::EventBridge::refresh_snapshot(
                state_refresh.clone(),
                client_refresh.clone(),
            );
        });

        // -- Sidebar selection -> stack switch --
        let stack_ref = content_stack;
        let pt = page_title;
        let sv = split_view.clone();
        nav_list.connect_row_selected(move |_, row| {
            if let Some(row) = row {
                let id = row.widget_name();
                if !id.is_empty() && !id.starts_with("__group") {
                    stack_ref.set_visible_child_name(&id);
                    let title = NAV_ITEMS
                        .iter()
                        .find(|(i, _, _)| *i == id.as_str())
                        .map(|(_, l, _)| *l)
                        .unwrap_or("OpenClaw");
                    pt.set_label(title);

                    // On narrow screens, collapse sidebar after selection
                    if sv.is_collapsed() {
                        sv.set_show_sidebar(false);
                    }
                }
            }
        });

        // Make group headers unselectable
        nav_list.set_filter_func(|_| true);
        nav_list.connect_row_activated(|list, row| {
            let name = row.widget_name();
            if name.starts_with("__group")
                && let Some(selected) = list.selected_row()
            {
                list.select_row(Some(&selected));
            }
        });

        // -- Agent dropdown: selection -> load sessions --
        // When the user picks an agent we want to:
        //  (a) fetch that agent's sessions pre-sorted by `updatedAt` desc,
        //  (b) filter out system noise (heartbeat, :run: subkeys),
        //  (c) pick the MOST RECENT interactive session as the initial
        //      selection — not a synthetic "default" — so the chat view
        //      shows history the user actually wrote.
        //
        // Sessions are kept as (key, display_label) pairs so the dropdown
        // shows a friendly label while the state.selected_session carries
        // the canonical key.
        let state_agent = state.clone();
        let client_agent = client.clone();
        let sd_ref = session_dropdown.clone();
        agent_dropdown.connect_selected_notify(move |dd| {
            let idx = dd.selected();
            let agents = state_agent.agents();
            if let Some(agent) = agents.get(idx as usize) {
                let agent_id = agent
                    .get("id")
                    .and_then(|v| v.as_str())
                    .unwrap_or("default")
                    .to_string();

                state_agent.set_selected_agent(Some(agent_id.clone()));

                if let Some(gw) = client_agent.lock().unwrap().clone() {
                    let sd = sd_ref.clone();
                    let state_inner = state_agent.clone();
                    glib::spawn_future_local(async move {
                        let params = serde_json::json!({
                            "agentId": agent_id,
                            "limit": 50,
                            "includeLastMessage": true,
                        });
                        match gw.request("sessions.list", params).await {
                            Ok(payload) => {
                                let sessions = payload
                                    .get("sessions")
                                    .and_then(|s| s.as_array())
                                    .cloned()
                                    .unwrap_or_default();
                                let choices =
                                    crate::session_filter::build_session_choices(
                                        &agent_id, &sessions,
                                    );
                                let labels: Vec<&str> =
                                    choices.iter().map(|c| c.label.as_str()).collect();
                                let string_list =
                                    gtk4::StringList::new(&labels);
                                sd.set_model(Some(&string_list));
                                sd.set_selected(0);
                                if let Some(first) = choices.first() {
                                    state_inner
                                        .set_selected_session(Some(first.key.clone()));
                                }
                                let keys: Vec<String> =
                                    choices.into_iter().map(|c| c.key).collect();
                                unsafe {
                                    sd.set_data::<Vec<String>>("session-keys", keys);
                                }
                            }
                            Err(_) => {
                                let string_list = gtk4::StringList::new(&["default"]);
                                sd.set_model(Some(&string_list));
                            }
                        }
                    });
                }
            }
        });

        // -- Session dropdown: selection -> update state --
        // We stash the canonical session keys on the dropdown as GObject
        // data when the agent changes. The displayed label may be a shorter
        // displayName; the key is what the gateway RPCs need.
        let state_sess = state.clone();
        session_dropdown.connect_selected_notify(move |dd| {
            let idx = dd.selected() as usize;
            // Prefer the stashed keys (set by the agent-change handler).
            let key_from_stash = unsafe {
                dd.data::<Vec<String>>("session-keys")
                    .and_then(|nn| nn.as_ref().get(idx).cloned())
            };
            if let Some(key) = key_from_stash {
                state_sess.set_selected_session(Some(key));
                return;
            }
            // Fallback: treat the visible string as the key (initial state
            // before an agent has been selected).
            if let Some(model) = dd.model()
                && let Some(sl) = model.downcast_ref::<gtk4::StringList>()
                && let Some(item) = sl.string(idx as u32)
            {
                state_sess.set_selected_session(Some(item.to_string()));
            }
        });

        // -- Poll connection state --
        let state3 = state;
        let sd = status_dot;
        let st = status_text;
        let cc = conn_chip;
        let ad = agent_dropdown;
        let svc_dot = service_dot;
        let svc_text = service_text;
        let mut agents_populated = false;
        glib::timeout_add_local(std::time::Duration::from_secs(1), move || {
            // Update service status from systemd monitor
            if state3.service_active() {
                svc_dot.remove_css_class("disconnected");
                svc_dot.add_css_class("connected");
                svc_text.set_label("Service: active");
            } else {
                svc_dot.remove_css_class("connected");
                svc_dot.add_css_class("disconnected");
                svc_text.set_label("Service: inactive");
            }

            if state3.is_connected() {
                let ver = state3.server_version();
                sd.remove_css_class("disconnected");
                sd.remove_css_class("connecting");
                sd.add_css_class("connected");
                st.set_label(&format!("v{ver}"));
                cc.set_label("Connected");
                cc.remove_css_class("chip-error");
                cc.add_css_class("chip-ok");

                if !agents_populated {
                    let agents = state3.agents();
                    if !agents.is_empty() {
                        let names: Vec<String> = agents
                            .iter()
                            .filter_map(|a| {
                                let id = a.get("id")?.as_str()?;
                                let emoji = a
                                    .get("identity")
                                    .and_then(|i| i.get("emoji"))
                                    .and_then(|e| e.as_str())
                                    .unwrap_or("");
                                let name = a
                                    .get("identity")
                                    .and_then(|i| i.get("name"))
                                    .and_then(|n| n.as_str())
                                    .unwrap_or(id);
                                Some(format!("{emoji} {name}"))
                            })
                            .collect();
                        if !names.is_empty() {
                            let string_list = gtk4::StringList::new(
                                &names.iter().map(|s| s.as_str()).collect::<Vec<_>>(),
                            );
                            ad.set_model(Some(&string_list));

                            // Default to the first agent in the list. Setting
                            // selected to 0 when current is already 0 wouldn't
                            // fire `notify::selected`, so we nudge to index 1
                            // first (if possible) to guarantee the handler
                            // runs and loads sessions for the chosen agent.
                            if names.len() > 1 {
                                ad.set_selected(1);
                            }
                            ad.set_selected(0);

                            agents_populated = true;
                        }
                    }
                }
            } else {
                sd.remove_css_class("connected");
                // Show pulse animation while trying to connect
                if !sd.has_css_class("connecting") {
                    sd.add_css_class("connecting");
                }
                sd.remove_css_class("disconnected");
                st.set_label("Connecting...");
                cc.set_label("Disconnected");
                cc.remove_css_class("chip-ok");
                cc.add_css_class("chip-error");
            }
            glib::ControlFlow::Continue
        });

        split_view
    }

    fn add_group_header(list: &gtk4::ListBox, title: &str) {
        let label = gtk4::Label::builder()
            .label(title)
            .css_classes(vec![
                "caption".to_string(),
                "dim-label".to_string(),
                "nav-group-header".to_string(),
            ])
            .halign(gtk4::Align::Start)
            .margin_start(16)
            .margin_top(12)
            .margin_bottom(4)
            .build();

        let row = gtk4::ListBoxRow::builder()
            .child(&label)
            .activatable(false)
            .selectable(false)
            .name(format!("__group_{title}"))
            .build();

        list.append(&row);
    }

    fn add_nav_row(list: &gtk4::ListBox, id: &str, label: &str, icon_name: &str) {
        let hbox = gtk4::Box::builder()
            .orientation(Orientation::Horizontal)
            .spacing(10)
            .margin_start(12)
            .margin_end(12)
            .margin_top(4)
            .margin_bottom(4)
            .build();

        hbox.append(&gtk4::Image::from_icon_name(icon_name));
        hbox.append(
            &gtk4::Label::builder()
                .label(label)
                .halign(gtk4::Align::Start)
                .build(),
        );

        let row = gtk4::ListBoxRow::builder()
            .child(&hbox)
            .name(id)
            .build();

        list.append(&row);
    }
}
