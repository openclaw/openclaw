use gtk4::{self, Orientation};
use libadwaita as adw;
use libadwaita::prelude::*;

use crate::state::SharedClient;
use crate::widgets::status_placeholder;

pub struct UsageView {
    container: gtk4::Box,
}

impl UsageView {
    pub fn new(client: SharedClient) -> Self {
        let container = gtk4::Box::builder()
            .orientation(Orientation::Vertical)
            .vexpand(true)
            .hexpand(true)
            .build();

        // Scroll + content scaffold — real content is swapped in after the
        // two RPCs (usage.status + usage.cost) settle.
        let scroll = gtk4::ScrolledWindow::builder()
            .vexpand(true)
            .hscrollbar_policy(gtk4::PolicyType::Never)
            .build();

        let content = gtk4::Box::builder()
            .orientation(Orientation::Vertical)
            .spacing(24)
            .margin_start(32)
            .margin_end(32)
            .margin_top(24)
            .margin_bottom(24)
            .build();

        // ------ Cost summary cards (filled from usage.cost totals) --------
        let cards = gtk4::Box::builder()
            .orientation(Orientation::Horizontal)
            .spacing(16)
            .homogeneous(true)
            .build();

        let cost_label = gtk4::Label::builder()
            .label("$—")
            .css_classes(vec!["title-1".to_string()])
            .build();
        let cost_card = Self::wrap_card("Total Cost", &cost_label);

        let tokens_label = gtk4::Label::builder()
            .label("—")
            .css_classes(vec!["title-1".to_string()])
            .build();
        let tokens_card = Self::wrap_card("Total Tokens", &tokens_label);

        let in_out_label = gtk4::Label::builder()
            .label("—")
            .css_classes(vec!["title-2".to_string()])
            .build();
        let in_out_card = Self::wrap_card("Input / Output", &in_out_label);

        let cache_label = gtk4::Label::builder()
            .label("—")
            .css_classes(vec!["title-2".to_string()])
            .build();
        let cache_card = Self::wrap_card("Cache R / W", &cache_label);

        cards.append(&cost_card);
        cards.append(&tokens_card);
        cards.append(&in_out_card);
        cards.append(&cache_card);
        content.append(&cards);

        // ------ Provider rate-limit windows (from usage.status) -----------
        let providers_group = adw::PreferencesGroup::builder()
            .title("Provider Limits")
            .description("Rate-limit windows by provider plan")
            .build();
        content.append(&providers_group);

        // ------ Daily breakdown (from usage.cost.daily) -------------------
        let daily_group = adw::PreferencesGroup::builder()
            .title("Daily Breakdown")
            .description("Cost and tokens per day (last 30 days)")
            .build();
        content.append(&daily_group);

        let clamp = adw::Clamp::builder()
            .maximum_size(900)
            .child(&content)
            .build();
        scroll.set_child(Some(&clamp));

        // Start with loading placeholder; the poller swaps in `scroll`
        // once both RPCs return (or an error placeholder on failure).
        let loading = status_placeholder::loading("Loading usage data...");
        container.append(&loading);

        let container_ref = container.clone();
        let scroll_ref = scroll.clone();
        let cl = cost_label;
        let tl = tokens_label;
        let iol = in_out_label;
        let cachel = cache_label;
        let pg = providers_group;
        let dg = daily_group;
        let c = client;
        let mut loaded = false;
        gtk4::glib::timeout_add_local(std::time::Duration::from_secs(1), move || {
            if !loaded
                && let Some(gw) = c.lock().unwrap().clone()
            {
                loaded = true;
                let cl2 = cl.clone();
                let tl2 = tl.clone();
                let iol2 = iol.clone();
                let cachel2 = cachel.clone();
                let pg2 = pg.clone();
                let dg2 = dg.clone();
                let cr = container_ref.clone();
                let sr = scroll_ref.clone();
                gtk4::glib::spawn_future_local(async move {
                    // Two RPCs: usage.status for provider caps, usage.cost
                    // for token/cost totals. Sequential is fine here — these
                    // are lightweight and the view is already behind a
                    // loading placeholder.
                    let status_res =
                        gw.request("usage.status", serde_json::json!({})).await;
                    let cost_res = gw
                        .request("usage.cost", serde_json::json!({ "days": 30 }))
                        .await;

                    let mut any_ok = false;

                    // Cost summary: populate cards + daily rows.
                    match cost_res {
                        Ok(payload) => {
                            any_ok = true;
                            let totals = payload.get("totals");
                            let cost = totals
                                .and_then(|t| t.get("totalCost"))
                                .and_then(|v| v.as_f64())
                                .unwrap_or(0.0);
                            let tokens = totals
                                .and_then(|t| t.get("totalTokens"))
                                .and_then(|v| v.as_u64())
                                .unwrap_or(0);
                            let input = totals
                                .and_then(|t| t.get("input"))
                                .and_then(|v| v.as_u64())
                                .unwrap_or(0);
                            let output = totals
                                .and_then(|t| t.get("output"))
                                .and_then(|v| v.as_u64())
                                .unwrap_or(0);
                            let cache_r = totals
                                .and_then(|t| t.get("cacheRead"))
                                .and_then(|v| v.as_u64())
                                .unwrap_or(0);
                            let cache_w = totals
                                .and_then(|t| t.get("cacheWrite"))
                                .and_then(|v| v.as_u64())
                                .unwrap_or(0);

                            cl2.set_label(&format!("${}", format_money(cost)));
                            tl2.set_label(&format_count(tokens));
                            iol2.set_label(&format!(
                                "{} / {}",
                                format_count(input),
                                format_count(output)
                            ));
                            cachel2.set_label(&format!(
                                "{} / {}",
                                format_count(cache_r),
                                format_count(cache_w)
                            ));

                            // Daily breakdown: newest-first, limit to ~14 rows
                            // so the list stays readable.
                            if let Some(daily) =
                                payload.get("daily").and_then(|d| d.as_array())
                            {
                                let mut rows: Vec<&serde_json::Value> =
                                    daily.iter().collect();
                                rows.reverse();
                                for day in rows.iter().take(14) {
                                    let date = day
                                        .get("date")
                                        .and_then(|v| v.as_str())
                                        .unwrap_or("—");
                                    let d_cost = day
                                        .get("totalCost")
                                        .and_then(|v| v.as_f64())
                                        .unwrap_or(0.0);
                                    let d_tokens = day
                                        .get("totalTokens")
                                        .and_then(|v| v.as_u64())
                                        .unwrap_or(0);
                                    if d_tokens == 0 && d_cost == 0.0 {
                                        continue;
                                    }
                                    let row = adw::ActionRow::builder()
                                        .title(date)
                                        .subtitle(format!(
                                            "${} • {} tokens",
                                            format_money(d_cost),
                                            format_count(d_tokens)
                                        ))
                                        .build();
                                    dg2.add(&row);
                                }
                                // If no daily data, show a helper row so the
                                // group isn't awkwardly empty.
                                if daily.is_empty() {
                                    let empty = adw::ActionRow::builder()
                                        .title("No cost activity yet")
                                        .subtitle(
                                            "Costs will appear after chat usage is recorded",
                                        )
                                        .build();
                                    dg2.add(&empty);
                                }
                            }
                        }
                        Err(e) => {
                            let row = adw::ActionRow::builder()
                                .title("Failed to load cost summary")
                                .subtitle(format!("{e}"))
                                .build();
                            dg2.add(&row);
                        }
                    }

                    // Provider windows: render each provider's rate-limit
                    // windows as progress rows.
                    match status_res {
                        Ok(payload) => {
                            any_ok = true;
                            let providers = payload
                                .get("providers")
                                .and_then(|p| p.as_array())
                                .cloned()
                                .unwrap_or_default();
                            if providers.is_empty() {
                                let row = adw::ActionRow::builder()
                                    .title("No provider limits reported")
                                    .subtitle(
                                        "Authenticated providers with rate limits will appear here",
                                    )
                                    .build();
                                pg2.add(&row);
                            }
                            for provider in &providers {
                                let display = provider
                                    .get("displayName")
                                    .and_then(|v| v.as_str())
                                    .unwrap_or("Provider");
                                let plan = provider
                                    .get("plan")
                                    .and_then(|v| v.as_str())
                                    .map(|s| s.to_string());
                                let error = provider
                                    .get("error")
                                    .and_then(|v| v.as_str())
                                    .map(|s| s.to_string());

                                if let Some(err) = error {
                                    let row = adw::ActionRow::builder()
                                        .title(display)
                                        .subtitle(format!("Error: {err}"))
                                        .build();
                                    let chip = gtk4::Label::builder()
                                        .label("error")
                                        .css_classes(vec![
                                            "status-chip".to_string(),
                                            "chip-error".to_string(),
                                        ])
                                        .valign(gtk4::Align::Center)
                                        .build();
                                    row.add_suffix(&chip);
                                    pg2.add(&row);
                                    continue;
                                }

                                let windows = provider
                                    .get("windows")
                                    .and_then(|w| w.as_array())
                                    .cloned()
                                    .unwrap_or_default();
                                if windows.is_empty() {
                                    let row = adw::ActionRow::builder()
                                        .title(display)
                                        .subtitle(
                                            plan.unwrap_or_else(|| "No windows".to_string()),
                                        )
                                        .build();
                                    pg2.add(&row);
                                    continue;
                                }
                                for win in &windows {
                                    let label = win
                                        .get("label")
                                        .and_then(|v| v.as_str())
                                        .unwrap_or("window");
                                    let used_pct = win
                                        .get("usedPercent")
                                        .and_then(|v| v.as_f64())
                                        .unwrap_or(0.0)
                                        .clamp(0.0, 100.0);
                                    let reset_at = win
                                        .get("resetAt")
                                        .and_then(|v| v.as_i64());
                                    let subtitle = if let Some(reset_ms) = reset_at {
                                        format!(
                                            "{label} — {}",
                                            format_reset_time(reset_ms)
                                        )
                                    } else {
                                        label.to_string()
                                    };
                                    let title = match &plan {
                                        Some(p) => format!("{display} • {p}"),
                                        None => display.to_string(),
                                    };
                                    let row = adw::ActionRow::builder()
                                        .title(title)
                                        .subtitle(subtitle)
                                        .build();
                                    let bar = gtk4::LevelBar::builder()
                                        .min_value(0.0)
                                        .max_value(100.0)
                                        .value(used_pct)
                                        .width_request(140)
                                        .valign(gtk4::Align::Center)
                                        .build();
                                    // Color the bar based on % used.
                                    if used_pct >= 90.0 {
                                        bar.add_offset_value("high", 100.0);
                                    } else if used_pct >= 75.0 {
                                        bar.add_offset_value("warn", 100.0);
                                    }
                                    let pct_label = gtk4::Label::builder()
                                        .label(format!("{:.0}%", used_pct))
                                        .css_classes(vec!["caption".to_string()])
                                        .valign(gtk4::Align::Center)
                                        .width_request(40)
                                        .build();
                                    row.add_suffix(&bar);
                                    row.add_suffix(&pct_label);
                                    pg2.add(&row);
                                }
                            }
                        }
                        Err(e) => {
                            let row = adw::ActionRow::builder()
                                .title("Failed to load provider status")
                                .subtitle(format!("{e}"))
                                .build();
                            pg2.add(&row);
                        }
                    }

                    if any_ok {
                        status_placeholder::swap_child(&cr, &sr);
                    } else {
                        let err = status_placeholder::error(
                            "Usage data unavailable",
                            Some("Both usage.status and usage.cost RPCs failed"),
                        );
                        status_placeholder::swap_child(&cr, &err);
                    }
                });
            }
            gtk4::glib::ControlFlow::Continue
        });

        Self { container }
    }

    fn wrap_card(title: &str, value_widget: &gtk4::Label) -> gtk4::Box {
        let card = gtk4::Box::builder()
            .orientation(Orientation::Vertical)
            .spacing(4)
            .css_classes(vec!["card".to_string()])
            .build();
        let inner = gtk4::Box::builder()
            .orientation(Orientation::Vertical)
            .spacing(4)
            .margin_start(16)
            .margin_end(16)
            .margin_top(16)
            .margin_bottom(16)
            .build();
        inner.append(
            &gtk4::Label::builder()
                .label(title)
                .css_classes(vec!["caption".to_string(), "dim-label".to_string()])
                .halign(gtk4::Align::Start)
                .build(),
        );
        value_widget.set_halign(gtk4::Align::Start);
        inner.append(value_widget);
        card.append(&inner);
        card
    }

    pub fn widget(&self) -> &gtk4::Box {
        &self.container
    }
}

/// Format a USD amount: trim trailing zeros, keep at least 2 decimals,
/// cap at 4 decimals for tiny fractions.
fn format_money(amount: f64) -> String {
    if amount >= 100.0 {
        format!("{amount:.2}")
    } else if amount >= 1.0 {
        format!("{amount:.3}")
    } else {
        format!("{amount:.4}")
    }
}

/// Format a token count with k/M suffixes.
fn format_count(n: u64) -> String {
    if n >= 1_000_000 {
        format!("{:.1}M", n as f64 / 1_000_000.0)
    } else if n >= 10_000 {
        format!("{:.0}k", n as f64 / 1_000.0)
    } else if n >= 1_000 {
        format!("{:.1}k", n as f64 / 1_000.0)
    } else {
        n.to_string()
    }
}

/// Convert a unix-ms timestamp into "resets in Nh Nm" (or similar).
fn format_reset_time(ms: i64) -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    let delta = ms - now;
    if delta <= 0 {
        return "reset due".to_string();
    }
    let secs = delta / 1000;
    let hours = secs / 3600;
    let mins = (secs % 3600) / 60;
    if hours > 0 {
        format!("resets in {hours}h {mins}m")
    } else if mins > 0 {
        format!("resets in {mins}m")
    } else {
        format!("resets in {secs}s")
    }
}
