use std::collections::{BTreeMap, BTreeSet};

use super::attention_rpc::{MessageSubscription, SubscriptionResult};
use crate::model::{
    approvals::{ApprovalEvent, Approvals},
    questions::{QuestionRecord, Questions},
};
use serde::Deserialize;
use serde_json::Value;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Scope {
    pub epoch: u64,
    pub agent_id: Option<String>,
    pub session_key: String,
    pub generation: u64,
}

impl Scope {
    fn matches(&self, key: &str, agent: Option<&str>) -> bool {
        self.agent_id
            .as_deref()
            .zip(agent)
            .is_none_or(|(a, b)| a == b)
            && crate::model::sidebar_activity::session_matches(
                &self.session_key,
                key,
                self.agent_id.as_deref().or(agent),
            )
    }
}

#[derive(Clone)]
pub struct SubscriptionRequest {
    pub method: &'static str,
    pub params: Value,
    id: u64,
    scope: Scope,
    subscribe: bool,
    // Selected scopes own the approval dock; sidebar scopes only project attention.
    selected: bool,
}

#[derive(Clone)]
struct MessageLease {
    scope: Scope,
    selected: bool,
}

pub enum RoutedEvent {
    Roster(Value),
    Chat(Value),
    Agent(Value),
    Tool(Value),
    Attention,
    Presence,
    Shutdown,
}

#[derive(Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Shutdown {
    pub reason: String,
    pub restart_expected_ms: Option<u64>,
}

#[derive(Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct EventTarget {
    session_key: Option<String>,
    agent_id: Option<String>,
    run_id: Option<String>,
}

/// One serial owner for selected and sidebar scopes: Gateway leases are not refcounted.
#[derive(Default)]
pub struct Router {
    epoch: u64,
    generation: u64,
    request_id: u64,
    desired: Option<Scope>,
    active: Vec<MessageLease>,
    sidebar: Vec<Scope>,
    sidebar_failed: BTreeSet<String>,
    pending: Option<SubscriptionRequest>,
    subscription_paused: bool,
    pub questions: Questions,
    pub approvals: Approvals,
    sidebar_approvals: BTreeMap<(Option<String>, String), Approvals>,
    pub shutdown: Option<Shutdown>,
    pub error: Option<String>,
}

impl Router {
    pub fn connected(&mut self, epoch: u64, _hello: &Value) {
        *self = Self {
            epoch,
            ..Self::default()
        };
    }
    pub fn disconnected(&mut self, epoch: u64) {
        self.epoch = epoch;
        self.pending = None;
        self.active.clear();
        self.sidebar.clear();
        self.sidebar_failed.clear();
        self.desired = None;
        self.approvals = Approvals::default();
        self.sidebar_approvals.clear();
    }
    pub fn select(&mut self, agent_id: Option<String>, session_key: Option<String>) {
        if self.desired.as_ref().map(|s| (&s.agent_id, &s.session_key))
            == session_key.as_ref().map(|k| (&agent_id, k))
        {
            return;
        }
        self.generation += 1;
        self.desired = session_key.map(|session_key| Scope {
            epoch: self.epoch,
            agent_id,
            session_key,
            generation: self.generation,
        });
        self.approvals = Approvals::default();
        self.error = None;
        self.subscription_paused = false;
    }
    pub fn scope(&self) -> Option<Scope> {
        self.desired.clone()
    }
    pub fn is_current(&self, scope: &Scope) -> bool {
        self.desired.as_ref() == Some(scope)
    }

    pub fn set_sidebar_subscriptions(&mut self, scopes: Vec<(Option<String>, String)>) {
        self.sidebar = scopes
            .into_iter()
            .map(|(agent_id, session_key)| Scope {
                epoch: self.epoch,
                agent_id,
                session_key,
                generation: 0,
            })
            .collect();
        self.sidebar_failed
            .retain(|key| self.sidebar.iter().any(|scope| &scope.session_key == key));
        self.sidebar_approvals.retain(|(agent, key), _| {
            self.sidebar
                .iter()
                .any(|scope| scope.matches(key, agent.as_deref()))
        });
    }

    pub fn has_sidebar_approval(&self, key: &str, agent: Option<&str>, now: u64) -> bool {
        if self
            .desired
            .as_ref()
            .is_some_and(|scope| scope.matches(key, agent))
        {
            return false;
        }
        self.sidebar_approvals
            .iter()
            .any(|((owner, session), approvals)| {
                owner.as_deref().zip(agent).is_none_or(|(a, b)| a == b)
                    && crate::model::sidebar_activity::session_matches(
                        session,
                        key,
                        owner.as_deref().or(agent),
                    )
                    && approvals
                        .pending
                        .values()
                        .any(|approval| approval.expires_at_ms > now)
            })
    }

    fn desired_leases(&self) -> Vec<MessageLease> {
        let mut desired = Vec::new();
        if let Some(scope) = &self.desired {
            desired.push(MessageLease {
                scope: scope.clone(),
                selected: true,
            });
        }
        for scope in &self.sidebar {
            if !self.sidebar_failed.contains(&scope.session_key)
                && !desired.iter().any(|lease| {
                    lease
                        .scope
                        .matches(&scope.session_key, scope.agent_id.as_deref())
                })
            {
                desired.push(MessageLease {
                    scope: scope.clone(),
                    selected: false,
                });
            }
        }
        desired
    }

    pub fn next_subscription(&mut self) -> Option<SubscriptionRequest> {
        if self.pending.is_some() || self.subscription_paused {
            return None;
        }
        let desired = self.desired_leases();
        let (lease, subscribe) = if let Some(active) = self.active.iter().find(|active| {
            !desired
                .iter()
                .any(|wanted| wanted.scope == active.scope && wanted.selected == active.selected)
        }) {
            (active.clone(), false)
        } else {
            let wanted = desired.iter().find(|wanted| {
                !self.active.iter().any(|active| {
                    active.scope == wanted.scope && active.selected == wanted.selected
                }) && (wanted.selected || !self.sidebar_failed.contains(&wanted.scope.session_key))
            })?;
            (wanted.clone(), true)
        };
        let scope = lease.scope;
        self.request_id += 1;
        let request = SubscriptionRequest {
            method: if subscribe {
                "sessions.messages.subscribe"
            } else {
                "sessions.messages.unsubscribe"
            },
            params: serde_json::to_value(MessageSubscription {
                key: &scope.session_key,
                agent_id: scope.agent_id.as_deref(),
                include_approvals: subscribe.then_some(true),
            })
            .expect("subscription fields serialize"),
            id: self.request_id,
            scope,
            subscribe,
            selected: lease.selected,
        };
        self.pending = Some(request.clone());
        Some(request)
    }

    pub fn finish_subscription(
        &mut self,
        request: &SubscriptionRequest,
        result: &Result<Value, String>,
    ) -> bool {
        if request.scope.epoch != self.epoch
            || self.pending.as_ref().is_none_or(|p| p.id != request.id)
        {
            return false;
        }
        self.pending = None;
        let stale_subscribe = request.subscribe
            && !self
                .desired_leases()
                .iter()
                .any(|lease| lease.scope == request.scope && lease.selected == request.selected);
        let previous_error = self.error.take();
        match result {
            Ok(payload) if request.subscribe => {
                match serde_json::from_value::<SubscriptionResult>(payload.clone()) {
                    Ok(result) if result.subscribed => {
                        self.active.push(MessageLease {
                            scope: request.scope.clone(),
                            selected: request.selected,
                        });
                        if !stale_subscribe
                            && let Some(replay) = result.approval_replay
                            && request.scope.matches(&replay.session_key, None)
                        {
                            if request.selected {
                                self.approvals.replay(replay.clone());
                            }
                            if self.sidebar.iter().any(|scope| {
                                scope.matches(
                                    &request.scope.session_key,
                                    request.scope.agent_id.as_deref(),
                                )
                            }) {
                                self.sidebar_approvals
                                    .entry((
                                        request.scope.agent_id.clone(),
                                        request.scope.session_key.clone(),
                                    ))
                                    .or_default()
                                    .replay(replay);
                            }
                        }
                    }
                    _ if stale_subscribe => {
                        self.active.push(MessageLease {
                            scope: request.scope.clone(),
                            selected: request.selected,
                        });
                    }
                    _ => {
                        self.error =
                            Some("Gateway did not activate the session subscription".into())
                    }
                }
            }
            Ok(_) => self.active.retain(|lease| lease.scope != request.scope),
            Err(_) if stale_subscribe => {
                // A lost acknowledgement can still own a lease. Release it before
                // subscribing the current selection, without publishing its stale error.
                self.active.push(MessageLease {
                    scope: request.scope.clone(),
                    selected: request.selected,
                });
            }
            Err(error) => self.error = Some(format!("Session subscription: {error}")),
        }
        if self.error.is_some() && !request.selected && request.subscribe {
            self.sidebar_failed
                .insert(request.scope.session_key.clone());
            self.error = None;
            // Even a lost acknowledgement may have installed this lease.
            // Keep the ownership fact until a subsequent serialized release.
            if request.subscribe && !self.active.iter().any(|lease| lease.scope == request.scope) {
                self.active.push(MessageLease {
                    scope: request.scope.clone(),
                    selected: false,
                });
            }
        }
        self.subscription_paused = self.error.is_some();
        if self.error.is_none() {
            self.error = previous_error;
        }
        true
    }

    pub fn retry_subscription(&mut self) {
        self.error = None;
        self.subscription_paused = false;
        self.sidebar_failed.clear();
    }

    pub fn route(
        &mut self,
        epoch: u64,
        name: &str,
        payload: &Value,
        active_run: Option<&str>,
    ) -> Option<RoutedEvent> {
        if epoch != self.epoch {
            return None;
        }
        match name {
            "sessions.changed" => Some(RoutedEvent::Roster(payload.clone())),
            "question.requested" => {
                let question: QuestionRecord = serde_json::from_value(payload.clone()).ok()?;
                self.questions.upsert(question);
                Some(RoutedEvent::Attention)
            }
            "question.resolved" => {
                #[derive(Deserialize)]
                struct Resolved {
                    id: String,
                }
                self.questions
                    .remove(&serde_json::from_value::<Resolved>(payload.clone()).ok()?.id);
                Some(RoutedEvent::Attention)
            }
            "presence" => Some(RoutedEvent::Presence),
            "shutdown" => {
                self.shutdown = serde_json::from_value(payload.clone()).ok();
                Some(RoutedEvent::Shutdown)
            }
            "session.approval" => {
                let event: ApprovalEvent = serde_json::from_value(payload.clone()).ok()?;
                if self.desired.as_ref().is_some_and(|scope| {
                    scope.matches(
                        &event.session_key,
                        event.approval.presentation.agent_id.as_deref(),
                    )
                }) {
                    self.approvals.apply(event.clone());
                }
                if let Some(scope) = self.sidebar.iter().find(|scope| {
                    scope.matches(
                        &event.session_key,
                        event.approval.presentation.agent_id.as_deref(),
                    )
                }) {
                    self.sidebar_approvals
                        .entry((scope.agent_id.clone(), scope.session_key.clone()))
                        .or_default()
                        .apply(event);
                }
                Some(RoutedEvent::Attention)
            }
            "chat" | "agent" | "session.tool" => {
                let target: EventTarget = serde_json::from_value(payload.clone()).ok()?;
                let scope = self.desired.as_ref()?;
                let matches = match target.session_key.as_deref() {
                    Some(key) => scope.matches(key, target.agent_id.as_deref()),
                    None => {
                        name != "chat"
                            && target
                                .run_id
                                .as_deref()
                                .zip(active_run)
                                .is_some_and(|(a, b)| a == b)
                            && scope
                                .agent_id
                                .as_deref()
                                .zip(target.agent_id.as_deref())
                                .is_none_or(|(a, b)| a == b)
                    }
                };
                if !matches {
                    return None;
                }
                let mut forwarded = payload.clone();
                forwarded["sessionKey"] = Value::String(scope.session_key.clone());
                Some(match name {
                    "chat" => RoutedEvent::Chat(forwarded),
                    "agent" => RoutedEvent::Agent(forwarded),
                    _ => RoutedEvent::Tool(forwarded),
                })
            }
            _ => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn background_approval_replay_and_terminal_events_never_enter_selected_dock() {
        let mut router = Router::default();
        router.connected(1, &json!({}));
        router.select(Some("main".into()), Some("selected".into()));
        router.set_sidebar_subscriptions(vec![(Some("other".into()), "agent:other:run".into())]);
        let selected = router.next_subscription().unwrap();
        router.finish_subscription(&selected, &Ok(json!({"subscribed":true})));
        let background = router.next_subscription().unwrap();
        assert_eq!(background.params["includeApprovals"], true);
        let approval = json!({"id":"background-approval","status":"pending","expiresAtMs":500,"presentation":{"agentId":"other"}});
        let terminal = json!({"sessionKey":"agent:other:run","phase":"terminal","updatedAtMs":20,"approval":approval});
        router.route(1, "session.approval", &terminal, None);
        router.finish_subscription(&background, &Ok(json!({"subscribed":true,"approvalReplay":{"sessionKey":"agent:other:run","updatedAtMs":10,"approvals":[approval]}})));
        assert!(router.approvals.pending.is_empty());
        assert!(!router.has_sidebar_approval("agent:other:run", Some("other"), 30));
        let pending = json!({"sessionKey":"agent:other:run","phase":"pending","updatedAtMs":30,"approval":{"id":"next","status":"pending","expiresAtMs":500,"presentation":{"agentId":"other"}}});
        router.route(1, "session.approval", &pending, None);
        assert!(router.has_sidebar_approval("agent:other:run", Some("other"), 40));
        assert!(!router.has_sidebar_approval("agent:other:run", Some("main"), 40));
        assert!(router.approvals.pending.is_empty());
        assert!(!router.has_sidebar_approval("agent:other:run", Some("other"), 500));
        router.disconnected(2);
        router.route(1, "session.approval", &pending, None);
        assert!(!router.has_sidebar_approval("agent:other:run", Some("other"), 40));
        router.set_sidebar_subscriptions(vec![(Some("other".into()), "agent:other:run".into())]);
        let replay = router.next_subscription().unwrap();
        router.finish_subscription(&replay, &Ok(json!({"subscribed":true,"approvalReplay":{"sessionKey":"agent:other:run","updatedAtMs":40,"approvals":[approval]}})));
        assert!(router.has_sidebar_approval("agent:other:run", Some("other"), 40));
        assert!(router.approvals.pending.is_empty());
    }

    #[test]
    fn sidebar_lease_transfers_to_selected_owner_without_later_unsubscribe() {
        let mut router = Router::default();
        router.connected(1, &json!({}));
        router.select(Some("main".into()), Some("selected".into()));
        router.set_sidebar_subscriptions(vec![(Some("main".into()), "background".into())]);
        let selected = router.next_subscription().unwrap();
        assert_eq!(selected.params["includeApprovals"], true);
        router.finish_subscription(&selected, &Ok(json!({"subscribed":true})));
        let background = router.next_subscription().unwrap();
        assert_eq!(
            background.params,
            json!({"key":"background","agentId":"main","includeApprovals":true})
        );
        router.finish_subscription(&background, &Ok(json!({"subscribed":true})));
        router.select(Some("main".into()), Some("background".into()));
        for key in ["selected", "background"] {
            let release = router.next_subscription().unwrap();
            assert_eq!(release.method, "sessions.messages.unsubscribe");
            assert_eq!(release.params["key"], key);
            router.finish_subscription(&release, &Ok(json!({})));
        }
        let upgrade = router.next_subscription().unwrap();
        assert_eq!(
            upgrade.params,
            json!({"key":"background","agentId":"main","includeApprovals":true})
        );
        router.finish_subscription(&upgrade, &Ok(json!({"subscribed":true})));
        router.set_sidebar_subscriptions(vec![]);
        assert!(router.next_subscription().is_none());
    }

    #[test]
    fn uncertain_background_subscription_releases_once_without_blocking_selected() {
        let mut router = Router::default();
        router.connected(1, &json!({}));
        router.set_sidebar_subscriptions(vec![(None, "run".into())]);
        let request = router.next_subscription().unwrap();
        router.finish_subscription(&request, &Err("request timed out".into()));
        let release = router.next_subscription().unwrap();
        assert_eq!(release.method, "sessions.messages.unsubscribe");
        router.finish_subscription(&release, &Ok(json!({})));
        assert!(router.next_subscription().is_none());
        router.select(None, Some("run".into()));
        let selected = router.next_subscription().unwrap();
        assert_eq!(selected.params["includeApprovals"], true);
    }

    #[test]
    fn rapid_switch_serializes_release_and_drops_stale_replay_and_results() {
        let mut router = Router::default();
        router.connected(1, &json!({}));
        router.select(Some("main".into()), Some("a".into()));
        let old_scope = router.scope().unwrap();
        let subscribe = router.next_subscription().unwrap();
        router.select(Some("main".into()), Some("b".into()));
        assert!(router.next_subscription().is_none());
        router.finish_subscription(&subscribe, &Ok(json!({"subscribed":true,"approvalReplay":{"sessionKey":"a","approvals":[{"id":"old","status":"pending"}]}})));
        assert!(router.approvals.pending.is_empty());
        router.select(Some("main".into()), Some("a".into()));
        assert!(!router.is_current(&old_scope));
        let unsubscribe = router.next_subscription().unwrap();
        assert_eq!(unsubscribe.method, "sessions.messages.unsubscribe");
        assert_eq!(unsubscribe.params, json!({"key":"a","agentId":"main"}));
        router.finish_subscription(&unsubscribe, &Ok(json!({})));
        router.select(Some("main".into()), Some("b".into()));
        let current = router.next_subscription().unwrap();
        assert_eq!(
            current.params,
            json!({"key":"b","agentId":"main","includeApprovals":true})
        );
        router.connected(2, &json!({}));
        assert!(!router.finish_subscription(&current, &Ok(json!({"subscribed":true}))));
        assert!(
            router
                .route(
                    1,
                    "question.requested",
                    &json!({"id":"stale","status":"pending","questions":[{}]}),
                    None
                )
                .is_none()
        );
        for failure in [
            Err("request timed out".into()),
            Ok(json!({"subscribed":false})),
        ] {
            router.select(Some("main".into()), Some("old".into()));
            let old = router.next_subscription().unwrap();
            router.select(Some("main".into()), Some("latest".into()));
            assert!(router.finish_subscription(&old, &failure));
            assert!(router.error.is_none());
            let release = router.next_subscription().unwrap();
            assert_eq!(release.method, "sessions.messages.unsubscribe");
            assert_eq!(release.params["key"], "old");
            router.finish_subscription(&release, &Ok(json!({"subscribed":false})));
            let latest = router.next_subscription().unwrap();
            assert_eq!(latest.method, "sessions.messages.subscribe");
            assert_eq!(latest.params["key"], "latest");
            router.connected(2, &json!({}));
        }
    }

    #[test]
    fn route_requires_current_agent_and_session_for_selected_streams() {
        let mut router = Router::default();
        router.connected(1, &json!({}));
        router.select(Some("main".into()), Some("global".into()));
        assert!(
            router
                .route(1, "agent", &json!({"runId":"active"}), Some("active"))
                .is_some()
        );
        assert!(
            router
                .route(1, "session.tool", &json!({"runId":"old"}), Some("active"))
                .is_none()
        );
        assert!(
            router
                .route(
                    1,
                    "agent",
                    &json!({"runId":"active","agentId":"other"}),
                    Some("active")
                )
                .is_none()
        );
        for name in ["chat", "agent", "session.tool"] {
            assert!(
                router
                    .route(
                        1,
                        name,
                        &json!({"sessionKey":"global","agentId":"other"}),
                        None
                    )
                    .is_none()
            );
            let forwarded = router
                .route(
                    1,
                    name,
                    &json!({"sessionKey":"agent:main:global","seq":9}),
                    None,
                )
                .unwrap();
            let (RoutedEvent::Chat(payload)
            | RoutedEvent::Agent(payload)
            | RoutedEvent::Tool(payload)) = forwarded
            else {
                panic!("expected a selected stream event");
            };
            assert_eq!(payload, json!({"sessionKey":"global","seq":9}));
            assert!(
                router
                    .route(1, name, &json!({"sessionKey":"old"}), None)
                    .is_none()
            );
        }
    }
}
