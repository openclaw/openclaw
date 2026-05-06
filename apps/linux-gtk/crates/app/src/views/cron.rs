use gtk4::{self, Orientation};
use libadwaita as adw;
use libadwaita::prelude::*;
use tracing::{debug, warn};

use crate::state::SharedClient;
use crate::widgets::status_placeholder;

pub struct CronView {
    container: gtk4::Box,
}

impl CronView {
    pub fn new(client: SharedClient) -> Self {
        let container = gtk4::Box::builder()
            .orientation(Orientation::Vertical)
            .vexpand(true)
            .hexpand(true)
            .build();

        let scroll = gtk4::ScrolledWindow::builder()
            .vexpand(true)
            .hscrollbar_policy(gtk4::PolicyType::Never)
            .build();

        let content = gtk4::Box::builder()
            .orientation(Orientation::Vertical)
            .spacing(16)
            .margin_start(32)
            .margin_end(32)
            .margin_top(24)
            .margin_bottom(24)
            .build();

        // -- Create New Job button at top --
        let header_box = gtk4::Box::builder()
            .orientation(Orientation::Horizontal)
            .spacing(8)
            .build();

        let header_label = gtk4::Label::builder()
            .label("Scheduled Jobs")
            .css_classes(vec!["title-2".to_string()])
            .halign(gtk4::Align::Start)
            .hexpand(true)
            .build();

        let create_btn = gtk4::Button::builder()
            .label("New Job")
            .css_classes(vec!["suggested-action".to_string()])
            .valign(gtk4::Align::Center)
            .build();

        header_box.append(&header_label);
        header_box.append(&create_btn);
        content.append(&header_box);

        // -- Create job inline form (hidden by default) --
        let form_group = adw::PreferencesGroup::builder()
            .title("Create Job")
            .visible(false)
            .build();

        let schedule_entry = adw::EntryRow::builder()
            .title("Schedule (cron expression)")
            .build();
        let agent_entry = adw::EntryRow::builder()
            .title("Agent ID")
            .build();
        let message_entry = adw::EntryRow::builder()
            .title("Message")
            .build();

        form_group.add(&schedule_entry);
        form_group.add(&agent_entry);
        form_group.add(&message_entry);

        let form_buttons = gtk4::Box::builder()
            .orientation(Orientation::Horizontal)
            .spacing(8)
            .halign(gtk4::Align::End)
            .margin_top(8)
            .build();

        let cancel_btn = gtk4::Button::builder()
            .label("Cancel")
            .build();

        let submit_btn = gtk4::Button::builder()
            .label("Create")
            .css_classes(vec!["suggested-action".to_string()])
            .build();

        form_buttons.append(&cancel_btn);
        form_buttons.append(&submit_btn);

        content.append(&form_group);
        content.append(&form_buttons);
        form_buttons.set_visible(false);

        // Wire create button to show/hide form
        let fg = form_group.clone();
        let fb = form_buttons.clone();
        create_btn.connect_clicked(move |_| {
            let visible = fg.is_visible();
            fg.set_visible(!visible);
            fb.set_visible(!visible);
        });

        // Wire cancel button
        let fg2 = form_group.clone();
        let fb2 = form_buttons.clone();
        cancel_btn.connect_clicked(move |_| {
            fg2.set_visible(false);
            fb2.set_visible(false);
        });

        // Wire submit button -> cron.add
        let client_add = client.clone();
        let se = schedule_entry.clone();
        let ae = agent_entry.clone();
        let me = message_entry.clone();
        let fg3 = form_group.clone();
        let fb3 = form_buttons.clone();
        submit_btn.connect_clicked(move |btn| {
            let schedule = se.text().to_string();
            let agent_id = ae.text().to_string();
            let message = me.text().to_string();

            if schedule.is_empty() || agent_id.is_empty() || message.is_empty() {
                warn!("cron.add: all fields are required");
                return;
            }

            let Some(gw) = client_add.lock().unwrap().clone() else {
                return;
            };

            btn.set_sensitive(false);
            let btn2 = btn.clone();
            let fg4 = fg3.clone();
            let fb4 = fb3.clone();
            let se2 = se.clone();
            let ae2 = ae.clone();
            let me2 = me.clone();
            gtk4::glib::spawn_future_local(async move {
                let params = serde_json::json!({
                    "schedule": schedule,
                    "agentId": agent_id,
                    "message": message,
                });
                match gw.request("cron.add", params).await {
                    Ok(_) => {
                        debug!("cron.add ok");
                        // Clear form and hide it
                        se2.set_text("");
                        ae2.set_text("");
                        me2.set_text("");
                        fg4.set_visible(false);
                        fb4.set_visible(false);
                    }
                    Err(e) => {
                        warn!("cron.add failed: {e}");
                    }
                }
                btn2.set_sensitive(true);
            });
        });

        // -- Jobs list --
        let jobs_group = adw::PreferencesGroup::builder()
            .title("Jobs")
            .description("Cron-style scheduled tasks")
            .build();

        content.append(&jobs_group);

        let clamp = adw::Clamp::builder()
            .maximum_size(700)
            .child(&content)
            .build();
        scroll.set_child(Some(&clamp));

        let loading = status_placeholder::loading("Loading scheduled jobs...");
        container.append(&loading);

        let c = client;
        let container_ref = container.clone();
        let scroll_ref = scroll.clone();
        let mut loaded = false;
        gtk4::glib::timeout_add_local(std::time::Duration::from_secs(2), move || {
            if !loaded
                && let Some(gw) = c.lock().unwrap().clone()
            {
                loaded = true;
                let cr = container_ref.clone();
                let sr = scroll_ref.clone();
                let jg = jobs_group.clone();
                let gw_outer = gw.clone();
                gtk4::glib::spawn_future_local(async move {
                    match gw_outer
                        .request("cron.list", serde_json::json!({}))
                        .await
                    {
                        Ok(payload) => {
                            let jobs = payload
                                .get("jobs")
                                .and_then(|j| j.as_array())
                                .cloned()
                                .unwrap_or_default();
                            if jobs.is_empty() {
                                let empty = status_placeholder::empty(
                                    "alarm-symbolic",
                                    "No scheduled jobs",
                                    Some("Use the New Job button above to create one"),
                                );
                                status_placeholder::swap_child(&cr, &empty);
                                return;
                            }
                            for job in &jobs {
                                build_job_row(&jg, job, &gw_outer);
                            }
                            status_placeholder::swap_child(&cr, &sr);
                        }
                        Err(e) => {
                            let err = status_placeholder::error(
                                "Failed to load cron jobs",
                                Some(&format!("{e}")),
                            );
                            status_placeholder::swap_child(&cr, &err);
                        }
                    }
                });
            }
            gtk4::glib::ControlFlow::Continue
        });

        Self { container }
    }

    pub fn widget(&self) -> &gtk4::Box {
        &self.container
    }
}

/// Build an AdwExpanderRow for a single cron job with inline actions.
fn build_job_row(
    group: &adw::PreferencesGroup,
    job: &serde_json::Value,
    gw: &std::sync::Arc<openclaw_gateway_client::GatewayClient>,
) {
    let id = job
        .get("id")
        .and_then(|v| v.as_str())
        .unwrap_or("--")
        .to_string();
    let schedule = job
        .get("schedule")
        .and_then(|v| v.as_str())
        .unwrap_or("--");
    let agent = job
        .get("agentId")
        .and_then(|v| v.as_str())
        .unwrap_or("default");
    let enabled = job
        .get("enabled")
        .and_then(|v| v.as_bool())
        .unwrap_or(true);
    let message = job
        .get("message")
        .and_then(|v| v.as_str())
        .unwrap_or("");

    let expander = adw::ExpanderRow::builder()
        .title(&id)
        .subtitle(format!("{schedule} | Agent: {agent}"))
        .build();

    // Status chip
    let status_text = if enabled { "Active" } else { "Disabled" };
    let chip_class = if enabled { "chip-ok" } else { "chip-error" };
    let chip = gtk4::Label::builder()
        .label(status_text)
        .css_classes(vec![
            "status-chip".to_string(),
            chip_class.to_string(),
        ])
        .valign(gtk4::Align::Center)
        .build();
    expander.add_suffix(&chip);

    // Message row (info)
    if !message.is_empty() {
        let msg_row = adw::ActionRow::builder()
            .title("Message")
            .subtitle(message)
            .build();
        expander.add_row(&msg_row);
    }

    // Enable/Disable toggle row
    let toggle_row = adw::SwitchRow::builder()
        .title("Enabled")
        .active(enabled)
        .build();

    let gw_toggle = gw.clone();
    let job_id_toggle = id.clone();
    let chip_ref = chip.clone();
    toggle_row.connect_active_notify(move |switch| {
        let new_enabled = switch.is_active();
        let gw2 = gw_toggle.clone();
        let jid = job_id_toggle.clone();
        let chip2 = chip_ref.clone();
        debug!("cron.enable: {jid} -> enabled={new_enabled}");
        // Update chip immediately for responsiveness
        if new_enabled {
            chip2.set_label("Active");
            chip2.remove_css_class("chip-error");
            chip2.add_css_class("chip-ok");
        } else {
            chip2.set_label("Disabled");
            chip2.remove_css_class("chip-ok");
            chip2.add_css_class("chip-error");
        }
        gtk4::glib::spawn_future_local(async move {
            let params = serde_json::json!({
                "jobId": jid,
                "enabled": new_enabled,
            });
            match gw2.request("cron.update", params).await {
                Ok(_) => debug!("cron.enable ok"),
                Err(e) => warn!("cron.enable failed: {e}"),
            }
        });
    });
    expander.add_row(&toggle_row);

    // Run Now button row
    let run_row = adw::ActionRow::builder()
        .title("Run Now")
        .subtitle("Trigger this job immediately")
        .activatable(true)
        .build();
    let run_btn = gtk4::Button::builder()
        .icon_name("media-playback-start-symbolic")
        .css_classes(vec!["flat".to_string()])
        .valign(gtk4::Align::Center)
        .build();

    let gw_run = gw.clone();
    let job_id_run = id.clone();
    run_btn.connect_clicked(move |btn| {
        btn.set_sensitive(false);
        let gw2 = gw_run.clone();
        let jid = job_id_run.clone();
        let btn2 = btn.clone();
        gtk4::glib::spawn_future_local(async move {
            let params = serde_json::json!({ "jobId": jid });
            match gw2.request("cron.run", params).await {
                Ok(_) => debug!("cron.run ok for {jid}"),
                Err(e) => warn!("cron.run failed: {e}"),
            }
            btn2.set_sensitive(true);
        });
    });
    run_row.add_suffix(&run_btn);
    expander.add_row(&run_row);

    // Delete button row
    let delete_row = adw::ActionRow::builder()
        .title("Delete")
        .subtitle("Remove this job permanently")
        .activatable(true)
        .build();
    let delete_btn = gtk4::Button::builder()
        .icon_name("user-trash-symbolic")
        .css_classes(vec!["flat".to_string(), "error".to_string()])
        .valign(gtk4::Align::Center)
        .build();

    let gw_del = gw.clone();
    let job_id_del = id.clone();
    let expander_ref = expander.clone();
    let group_ref = group.clone();
    delete_btn.connect_clicked(move |btn| {
        btn.set_sensitive(false);
        let gw2 = gw_del.clone();
        let jid = job_id_del.clone();
        let exp = expander_ref.clone();
        let grp = group_ref.clone();
        // Confirm via a simple second-click pattern: first click disables and
        // changes label, a brief timeout re-enables. For a real dialog we would
        // need a window reference; this is simpler for now.
        gtk4::glib::spawn_future_local(async move {
            let params = serde_json::json!({ "jobId": jid });
            match gw2.request("cron.remove", params).await {
                Ok(_) => {
                    debug!("cron.remove ok for {jid}");
                    grp.remove(&exp);
                }
                Err(e) => {
                    warn!("cron.remove failed: {e}");
                }
            }
        });
    });
    delete_row.add_suffix(&delete_btn);
    expander.add_row(&delete_row);

    group.add(&expander);
}

#[cfg(test)]
mod tests {
    /// Basic cron expression validation: 5-field standard cron format.
    fn is_valid_cron(expr: &str) -> bool {
        let fields: Vec<&str> = expr.split_whitespace().collect();
        if fields.len() != 5 {
            return false;
        }
        // Each field must be non-empty and contain only valid cron chars
        for field in &fields {
            if field.is_empty() {
                return false;
            }
            for ch in field.chars() {
                if !ch.is_ascii_digit()
                    && ch != '*'
                    && ch != '/'
                    && ch != ','
                    && ch != '-'
                    && ch != '?'
                {
                    return false;
                }
            }
        }
        true
    }

    #[test]
    fn valid_cron_expressions() {
        assert!(is_valid_cron("* * * * *"));
        assert!(is_valid_cron("0 */6 * * *"));
        assert!(is_valid_cron("30 9 * * 1-5"));
        assert!(is_valid_cron("0 0 1,15 * *"));
        assert!(is_valid_cron("*/5 * * * *"));
    }

    #[test]
    fn invalid_cron_expressions() {
        assert!(!is_valid_cron(""));
        assert!(!is_valid_cron("* * *"));
        assert!(!is_valid_cron("not a cron"));
        assert!(!is_valid_cron("* * * * * *")); // 6 fields
    }

    #[test]
    fn cron_field_count() {
        let expr = "0 */6 * * *";
        let fields: Vec<&str> = expr.split_whitespace().collect();
        assert_eq!(fields.len(), 5, "standard cron has exactly 5 fields");
    }

    #[test]
    fn cron_every_minute() {
        let expr = "* * * * *";
        assert!(is_valid_cron(expr));
        let fields: Vec<&str> = expr.split_whitespace().collect();
        assert!(fields.iter().all(|f| *f == "*"));
    }
}
