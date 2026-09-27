use super::AppView;
use crate::{gateway::identity::Identity, model::sidebar::SidebarPreferences};
use gpui_kit::*;
use serde_json::json;
use tokio::sync::oneshot;

impl AppView {
    pub(super) fn load_sidebar_preferences(&mut self, cx: &mut Context<Self>) {
        let scope = self
            .profile
            .as_ref()
            .map(|profile| format!("profile:{}:{}", profile.id, profile.canonical_url()))
            .unwrap_or_else(|| self.url.read(cx).value().to_string());
        if self.sidebar_state.preference_scope == scope {
            return;
        }
        self.sidebar_state.preference_scope = scope.clone();
        self.sidebar_state.preference_revision += 1;
        let revision = self.sidebar_state.preference_revision;
        let epoch = self.epoch;
        let expected_scope = scope.clone();
        self.sidebar_state.preferences = SidebarPreferences::default();
        self.sidebar_state.section_limits.clear();
        let (tx, rx) = oneshot::channel();
        self.runtime.spawn_blocking(move || {
            let result = Identity::load().map(|identity| identity.sidebar_preferences(&scope));
            let _ = tx.send(result);
        });
        cx.spawn(async move |this, cx| {
            if let Ok(result) = rx.await {
                let _ = this.update(cx, |this, cx| {
                    if this.sidebar_state.preference_revision != revision
                        || this.epoch != epoch
                        || this.sidebar_state.preference_scope != expected_scope
                    {
                        return;
                    }
                    match result {
                        Ok(mut preferences) => {
                            preferences.known_groups =
                                this.sidebar_state.preferences.known_groups.clone();
                            preferences.section_order =
                                this.sidebar_state.preferences.section_order.clone();
                            this.sidebar_state.preferences = preferences;
                            this.refresh_sessions(cx);
                        }
                        Err(error) => this
                            .mutation_error(format!("Could not load sidebar preferences: {error}")),
                    }
                    cx.notify();
                });
            }
        })
        .detach();
    }

    pub(super) fn change_sidebar_preferences(
        &mut self,
        change: impl FnOnce(&mut SidebarPreferences),
        cx: &mut Context<Self>,
    ) {
        let previous = self.sidebar_state.preferences.clone();
        change(&mut self.sidebar_state.preferences);
        self.sidebar_state.preference_revision += 1;
        self.sidebar_state.selection.clear();
        self.sidebar_state.section_limits.clear();
        self.persist_sidebar_preferences(cx);
        let next = &self.sidebar_state.preferences;
        if previous.archive != next.archive
            || previous.owner_id != next.owner_id
            || previous.involving_me != next.involving_me
            || previous.all_agents != next.all_agents
        {
            self.invalidate_roster_reads();
            self.sidebar_state.children.clear();
            self.sidebar_state.child_loading.clear();
            self.sidebar_state.agent_revision += 1;
            self.refresh_sessions(cx);
        }
        self.sync_sidebar_pull_requests(cx);
        self.refresh_sidebar_avatars(cx);
        self.sync_sidebar_activity(cx);
        cx.notify();
    }

    pub(super) fn persist_sidebar_preferences(&mut self, cx: &mut Context<Self>) {
        if self.sidebar_state.preference_writer.is_none() {
            let (tx, rx) = async_channel::unbounded::<(String, SidebarPreferences)>();
            let (errors, failures) = async_channel::unbounded();
            // One queue preserves UI intent order even when filesystem writes are slow.
            self.runtime.spawn(async move {
                while let Ok((scope, prefs)) = rx.recv().await {
                    let result = tokio::task::spawn_blocking(move || {
                        Identity::load()?.save_sidebar_preferences(&scope, prefs)
                    })
                    .await;
                    let error = match result {
                        Ok(Err(error)) => Some(error),
                        Err(error) => Some(error.to_string()),
                        _ => None,
                    };
                    if let Some(error) = error {
                        let _ = errors.send(error).await;
                    }
                }
            });
            cx.spawn(async move |this, cx| {
                while let Ok(error) = failures.recv().await {
                    if this
                        .update(cx, |this, cx| {
                            this.mutation_error(format!(
                                "Could not save sidebar preferences: {error}"
                            ));
                            cx.notify();
                        })
                        .is_err()
                    {
                        break;
                    }
                }
            })
            .detach();
            self.sidebar_state.preference_writer = Some(tx);
        }
        if let Some(writer) = &self.sidebar_state.preference_writer {
            let _ = writer.try_send((
                self.sidebar_state.preference_scope.clone(),
                self.sidebar_state.preferences.clone(),
            ));
        }
    }

    pub(super) fn load_sidebar_groups(&mut self, cx: &mut Context<Self>) {
        self.request(
            "sessions.groups.list",
            json!({}),
            cx,
            |this, result, _| match result {
                Ok(value) => {
                    this.sidebar_state.preferences.known_groups = value
                        .get("groups")
                        .and_then(|v| v.as_array())
                        .map(|groups| {
                            groups
                                .iter()
                                .filter_map(|group| {
                                    group
                                        .as_str()
                                        .or_else(|| group.get("name").and_then(|v| v.as_str()))
                                })
                                .map(str::to_owned)
                                .collect()
                        })
                        .unwrap_or_default();
                    this.sidebar_state.preferences.section_order = value
                        .get("sectionOrder")
                        .and_then(|v| v.as_array())
                        .map(|rows| {
                            rows.iter()
                                .filter_map(|v| v.as_str().map(str::to_owned))
                                .collect()
                        })
                        .unwrap_or_default();
                }
                Err(error) => {
                    this.mutation_error(format!("Could not load conversation groups: {error}"))
                }
            },
        );
    }
}
