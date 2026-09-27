use super::AppView;
use crate::{
    gateway::{
        new_session_rpc::{
            CreateDraftParams, CreateDraftResult, DescribedSessionResult, DispatchResult,
            SendInitialTurnParams,
        },
        sessions_rpc::params,
    },
    model::{
        attachments::Attachment,
        new_session::{Destination, Visibility},
    },
};
use gpui_kit::{
    component::notification::{Notification, NotificationType},
    *,
};
use openclaw_gateway_client::ClientError;
use serde_json::{Value, json};
use std::time::{Duration, Instant};
use tokio::sync::oneshot;

#[derive(Clone, Copy, PartialEq, Eq)]
enum SubmissionPhase {
    Creating,
    Dispatching,
    ReconcilingPlacement,
    ReadyToSend,
    Sending,
}

pub(super) struct PendingDraftSubmission {
    create: CreateDraftParams,
    turn: SendInitialTurnParams,
    destination: Destination,
    phase: SubmissionPhase,
    gateway: String,
    recovery_scope: String,
    boot_id: String,
    generation: u64,
    started_at: Instant,
    placement_started_at: Instant,
    session_id: Option<String>,
    create_attempts: u32,
}

enum CreateFailure {
    Request(Box<ClientError>),
    Decode(String),
}

impl CreateFailure {
    fn request(error: ClientError) -> Self {
        Self::Request(Box::new(error))
    }
    fn before_commit(&self, attempts: u32) -> bool {
        // sessions-create.ts reports post-commit failures in runError. An
        // INVALID_REQUEST on a retry can instead reject an earlier receipt's
        // idempotency scope, so only a first-attempt rejection unlocks editing.
        let Self::Request(error) = self else {
            return false;
        };
        attempts == 1
            && match error.as_ref() {
                ClientError::DispatchRejected(_) => true,
                ClientError::Gateway {
                    code,
                    retryable: None | Some(false),
                    ..
                } => code == "INVALID_REQUEST",
                _ => false,
            }
    }

    fn message(&self) -> String {
        match self {
            Self::Request(error) => error.to_string(),
            Self::Decode(error) => error.clone(),
        }
    }
}

impl AppView {
    fn request_draft_create(
        &self,
        request: Value,
        cx: &mut Context<Self>,
        apply: impl FnOnce(&mut Self, Result<CreateDraftResult, CreateFailure>, &mut Context<Self>)
        + 'static,
    ) {
        let Some(session) = self.session.clone() else {
            return;
        };
        let epoch = self.epoch;
        let (tx, rx) = oneshot::channel();
        self.runtime.spawn(async move {
            let result = session
                .request("sessions.create", request)
                .await
                .map_err(CreateFailure::request)
                .and_then(|value| {
                    serde_json::from_value(value)
                        .map_err(|error| CreateFailure::Decode(error.to_string()))
                });
            let _ = tx.send(result);
        });
        cx.spawn(async move |this, cx| {
            if let Ok(result) = rx.await {
                let _ = this.update(cx, |this, cx| {
                    if this.epoch == epoch {
                        apply(this, result, cx);
                        cx.notify();
                    }
                });
            }
        })
        .detach();
    }

    pub(super) fn submit_new_session(&mut self, cx: &mut Context<Self>) {
        self.composer_save_draft(cx);
        if let Some(reason) = self.draft_submit_block() {
            self.new_session.error = Some(reason);
            cx.notify();
            return;
        }
        if self.new_session.submitting || self.composer_state.reading > 0 {
            return;
        }
        let Some(session) = &self.session else {
            self.new_session.error = Some("Reconnect before starting this chat.".into());
            cx.notify();
            return;
        };
        let gateway = self
            .composer_state
            .drafts
            .gateway()
            .unwrap_or_default()
            .to_owned();
        let recovery_scope = session.hello()["auth"]["recoveryScope"]
            .as_str()
            .unwrap_or_default()
            .to_owned();
        let boot_id = session.hello()["server"]["bootId"]
            .as_str()
            .unwrap_or_default()
            .to_owned();
        if let Some(pending) = &self.new_session.submitted {
            if pending.gateway != gateway || pending.recovery_scope != recovery_scope {
                self.fail_new_session("This draft belongs to a different Gateway identity. Return to its original Gateway to recover it.".into());
                cx.notify();
                return;
            }
            if pending.phase == SubmissionPhase::Creating
                && pending.create.key.is_none()
                && (pending.started_at.elapsed() >= Duration::from_secs(240)
                    || pending.boot_id != boot_id
                    || pending.boot_id.is_empty()
                    || pending.recovery_scope.is_empty())
            {
                self.fail_new_session("Creation is unconfirmed and its safe retry window has ended. Check the session list before starting another chat.".into());
                cx.notify();
                return;
            }
        } else {
            let message = self.composer.read(cx).value().to_string();
            let attachments = self
                .composer_state
                .attachments
                .iter()
                .map(Attachment::encoded)
                .collect();
            let draft = &self.new_session.draft;
            let model_settings = self.model_controls_draft_patch(&self.new_session.model_target());
            let mut create = match draft.create_params(&message, attachments, &model_settings) {
                Ok(params) => params,
                Err(error) => {
                    self.new_session.error = Some(error);
                    cx.notify();
                    return;
                }
            };
            let message_id = uuid::Uuid::new_v4().to_string();
            if draft.destination.is_remote() && draft.visibility != Visibility::Incognito {
                create.key = Some(format!(
                    "agent:{}:dashboard:{}",
                    create.agent_id,
                    uuid::Uuid::new_v4()
                ));
            } else {
                create.idempotency_key = Some(uuid::Uuid::new_v4().to_string());
            }
            self.new_session.submitted = Some(PendingDraftSubmission {
                turn: SendInitialTurnParams {
                    key: String::new(),
                    agent_id: create.agent_id.clone(),
                    message,
                    idempotency_key: message_id,
                    attachments: self
                        .composer_state
                        .attachments
                        .iter()
                        .map(Attachment::encoded)
                        .collect(),
                },
                create,
                destination: draft.destination.clone(),
                phase: SubmissionPhase::Creating,
                gateway,
                recovery_scope,
                boot_id,
                generation: self.new_session.generation,
                started_at: Instant::now(),
                placement_started_at: Instant::now(),
                session_id: None,
                create_attempts: 0,
            });
        }
        self.new_session.submitting = true;
        if let Some(pending) = self.new_session.submitted.as_mut() {
            pending.generation = self.new_session.generation;
        }
        self.new_session.error = None;
        self.new_session.picker = None;
        self.advance_new_session(cx);
        cx.notify();
    }

    fn pending_draft_matches(&self, id: &str) -> bool {
        self.new_session
            .submitted
            .as_ref()
            .is_some_and(|pending| pending.turn.idempotency_key == id)
    }

    fn advance_new_session(&mut self, cx: &mut Context<Self>) {
        let Some(pending) = &self.new_session.submitted else {
            return;
        };
        let id = pending.turn.idempotency_key.clone();
        match pending.phase {
            SubmissionPhase::Creating => {
                let request = params(&pending.create);
                self.new_session.submitted.as_mut().unwrap().create_attempts += 1;
                self.request_draft_create(request, cx, move |this, result, cx| {
                    if !this.pending_draft_matches(&id) { return; }
                    match result {
                        Ok(created) if !created.key.trim().is_empty() => {
                            let pending = this.new_session.submitted.as_mut().unwrap();
                            pending.turn.key = created.key.clone();
                            pending.session_id = created.session_id.or_else(|| created.entry.as_ref().and_then(|row| row.session_id.clone()));
                            this.new_session.completed_key = Some(created.key.clone());
                            if let Some(mut row) = created.entry {
                                row.key = created.key.clone();
                                row.session_id = pending.session_id.clone();
                                row.agent_id.get_or_insert_with(|| pending.create.agent_id.clone());
                                this.rows.retain(|existing| existing.key != row.key);
                                this.rows.insert(0, row);
                            }
                            if pending.create.key.as_ref().is_some_and(|key| key != &created.key) {
                                this.fail_new_session("The Gateway returned a different session key. The created chat is retained; its first message was not sent.".into());
                                return;
                            }
                            if pending.destination.is_remote() {
                                pending.phase = SubmissionPhase::Dispatching;
                                pending.placement_started_at = Instant::now();
                                this.advance_new_session(cx);
                            } else if let Some(error) = created.run_error.filter(|_| !created.run_started) {
                                pending.phase = SubmissionPhase::ReadyToSend;
                                this.fail_new_session(format!("Chat created, but its first message was rejected: {}. Retry sends to this same chat.", error.message));
                                this.refresh_sessions(cx);
                            } else {
                                if let Some(run_id) = created.run_id {
                                    pending.turn.idempotency_key = run_id;
                                }
                                this.complete_new_session(cx);
                            }
                        }
                        Ok(_) => this.fail_new_session("sessions.create returned no session key. Creation is unconfirmed; retry preserves the original request.".into()),
                        Err(error) => {
                            let attempts = this.new_session.submitted.as_ref().unwrap().create_attempts;
                            if error.before_commit(attempts) {
                                this.new_session.submitted = None;
                                this.fail_new_session(format!("Chat was not created: {}", error.message()));
                            } else {
                                this.fail_new_session(format!("Chat creation was not confirmed: {}. Retry preserves the original request.", error.message()));
                            }
                        }
                    }
                });
            }
            SubmissionPhase::Dispatching => {
                let request = pending
                    .destination
                    .dispatch_params(&pending.turn.key, &pending.turn.agent_id)
                    .expect("remote draft has dispatch target");
                self.new_session.submitted.as_mut().unwrap().phase =
                    SubmissionPhase::ReconcilingPlacement;
                self.request("sessions.dispatch", params(request), cx, move |this, result, cx| {
                    if !this.pending_draft_matches(&id) { return; }
                    match result.and_then(|value| serde_json::from_value::<DispatchResult>(value).map_err(|error| error.to_string())) {
                        Ok(result) if result.placement.state == "active" => {
                            let pending = this.new_session.submitted.as_mut().unwrap();
                            if result.key != pending.turn.key || pending.session_id.as_ref().is_some_and(|id| id != &result.session_id) {
                                this.fail_new_session("Placement returned a different session identity. The first message was not sent.".into());
                                return;
                            }
                            pending.session_id = Some(result.session_id);
                            pending.phase = SubmissionPhase::ReadyToSend;
                            this.advance_new_session(cx);
                        }
                        Ok(_) => this.advance_new_session(cx),
                        Err(error) => this.fail_new_session(format!("Chat created, but placement was not confirmed: {error}. Retry checks the existing placement.")),
                    }
                });
            }
            SubmissionPhase::ReconcilingPlacement => self.reconcile_new_session_placement(id, cx),
            SubmissionPhase::ReadyToSend => {
                if pending.turn.message.is_empty() && pending.turn.attachments.is_empty() {
                    self.complete_new_session(cx);
                    return;
                }
                let request = params(&pending.turn);
                // Retain this phase on transport loss; a retry must verify a receipt before sending.
                self.new_session.submitted.as_mut().unwrap().phase = SubmissionPhase::Sending;
                self.request("sessions.send", request, cx, move |this, result, cx| {
                    if !this.pending_draft_matches(&id) { return; }
                    match result {
                        Ok(value) if matches!(value["status"].as_str(), Some("error" | "timeout")) => {
                            this.new_session.submitted.as_mut().unwrap().phase = SubmissionPhase::ReadyToSend;
                            this.fail_new_session("The first message was rejected. Retry sends to the already-created chat.".into());
                        }
                        Ok(_) => this.complete_new_session(cx),
                        Err(error) => this.fail_new_session(format!("First-message delivery is unconfirmed: {error}. Retry checks delivery without sending a duplicate.")),
                    }
                });
            }
            SubmissionPhase::Sending => self.verify_new_session_delivery(id, cx),
        }
    }

    fn reconcile_new_session_placement(&mut self, id: String, cx: &mut Context<Self>) {
        let pending = self.new_session.submitted.as_ref().unwrap();
        let request = json!({"key":pending.turn.key,"agentId":pending.turn.agent_id});
        self.request("sessions.describe", request, cx, move |this, result, cx| {
            if !this.pending_draft_matches(&id) {
                return;
            }
            match result.and_then(|value| {
                serde_json::from_value::<DescribedSessionResult>(value)
                    .map_err(|error| error.to_string())
            }) {
                Ok(result) => {
                    let Some(row) = result.session else {
                        this.fail_new_session(
                            "The created session no longer exists. Its first message was not sent."
                                .into(),
                        );
                        return;
                    };
                    let state = row
                        .placement
                        .as_ref()
                        .and_then(|placement| placement["state"].as_str())
                        .unwrap_or("local");
                    let pending = this.new_session.submitted.as_mut().unwrap();
                    if row.key != pending.turn.key || pending.session_id.as_ref().is_some_and(|id| row.session_id.as_ref() != Some(id)) {
                        this.fail_new_session("The session identity changed during placement. The first message was not sent.".into());
                        return;
                    }
                    pending.session_id = row.session_id;
                    if state == "active" {
                        pending.phase = SubmissionPhase::ReadyToSend;
                        this.advance_new_session(cx);
                    } else if matches!(state, "local" | "reclaimed" | "failed") {
                        pending.phase = SubmissionPhase::Dispatching;
                        this.fail_new_session(format!(
                            "Placement is {state}. Retry dispatches this existing chat."
                        ));
                    } else if pending.placement_started_at.elapsed() >= Duration::from_secs(300) {
                        this.fail_new_session(
                            "Placement is still starting. Retry checks this existing chat.".into(),
                        );
                    } else {
                        this.schedule_new_session_placement_check(id, cx);
                    }
                }
                Err(error) => this.fail_new_session(format!(
                    "Placement could not be checked: {error}. The created chat is retained."
                )),
            }
        });
    }

    fn schedule_new_session_placement_check(&mut self, id: String, cx: &mut Context<Self>) {
        let epoch = self.epoch;
        cx.spawn(async move |this, cx| {
            cx.background_executor()
                .timer(Duration::from_millis(250))
                .await;
            let _ = this.update(cx, |this, cx| {
                if this.epoch == epoch
                    && this.new_session.submitting
                    && this.pending_draft_matches(&id)
                {
                    this.reconcile_new_session_placement(id, cx);
                }
            });
        })
        .detach();
    }

    fn verify_new_session_delivery(&mut self, id: String, cx: &mut Context<Self>) {
        let pending = self.new_session.submitted.as_ref().unwrap();
        let request = json!({"sessionKey":pending.turn.key,"agentId":pending.turn.agent_id,"limit":1000,"inputRunIds":[id]});
        self.request("chat.history", request, cx, move |this, result, cx| {
            if !this.pending_draft_matches(&id) { return; }
            match result {
                Ok(history) if confirmed_input(&history, &id, this.new_session.submitted.as_ref().and_then(|pending| pending.session_id.as_deref())) => this.complete_new_session(cx),
                Ok(_) => this.fail_new_session("No matching input receipt was found. Delivery remains unconfirmed; open the created chat to inspect it before sending again.".into()),
                Err(error) => this.fail_new_session(format!("Delivery could not be checked: {error}. The original message and created chat are retained.")),
            }
        });
    }

    fn fail_new_session(&mut self, error: String) {
        self.new_session.submitting = false;
        self.new_session.error = Some(error.clone());
        if !self.new_session.active {
            self.mutation_error(error);
        }
    }

    fn complete_new_session(&mut self, cx: &mut Context<Self>) {
        let Some(pending) = self.new_session.submitted.take() else {
            return;
        };
        self.new_session.submitting = false;
        self.new_session.error = None;
        self.discard_new_session_model_settings();
        self.new_session.initialized = false;
        self.new_session.completed_key = Some(pending.turn.key.clone());
        self.new_session.message.clear();
        self.new_session.attachments.clear();
        self.new_session.draft.worktree_name.clear();
        if self.new_session.active && self.new_session.generation == pending.generation {
            self.composer_state.set_attachments(Vec::new());
            self.new_session.pending_open = Some(pending.turn.key);
        } else {
            self.sidebar_state.notifications.push(
                Notification::new()
                    .with_type(NotificationType::Info)
                    .message("Your new chat is ready in the session list."),
            );
        }
        self.refresh_sessions(cx);
        cx.notify();
    }
}

fn confirmed_input(history: &Value, id: &str, session_id: Option<&str>) -> bool {
    if session_id.is_some_and(|expected| {
        history["sessionInfo"]["sessionId"]
            .as_str()
            .or_else(|| history["sessionId"].as_str())
            != Some(expected)
    }) {
        return false;
    }
    history["inputReceipts"].as_array().is_some_and(|receipts| {
        receipts
            .iter()
            .any(|receipt| receipt["runId"].as_str() == Some(id))
    }) || history["messages"].as_array().is_some_and(|messages| {
        messages.iter().any(|message| {
            let key = message["__openclaw"]["idempotencyKey"]
                .as_str()
                .or_else(|| message["idempotencyKey"].as_str());
            message["role"].as_str() == Some("user")
                && key.is_some_and(|key| key == id || key == format!("{id}:user"))
        })
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[::core::prelude::v1::test]
    fn only_a_proven_first_create_rejection_releases_the_frozen_draft() {
        let rejected = |code: &str, retryable| {
            CreateFailure::request(ClientError::Gateway {
                method: "sessions.create".into(),
                code: code.into(),
                message: "rejected".into(),
                details: None,
                retryable,
                retry_after_ms: None,
            })
        };
        assert!(rejected("INVALID_REQUEST", None).before_commit(1));
        assert!(!rejected("INVALID_REQUEST", None).before_commit(2));
        assert!(!rejected("INVALID_REQUEST", Some(true)).before_commit(1));
        assert!(!rejected("UNAVAILABLE", Some(false)).before_commit(1));
        assert!(
            !CreateFailure::request(ClientError::RequestTimeout("sessions.create".into()))
                .before_commit(1)
        );
        assert!(
            CreateFailure::request(ClientError::DispatchRejected(
                "cancelled before enqueue".into()
            ))
            .before_commit(1)
        );
    }

    #[::core::prelude::v1::test]
    fn unknown_entry_projection_does_not_erase_a_created_session_receipt() {
        let created: CreateDraftResult = serde_json::from_value(json!({
            "key":"agent:main:dashboard:created", "sessionId":"physical-id",
            "entry":{"children":"a newer projection"}, "runStarted":true, "runId":"input-id"
        }))
        .unwrap();
        assert_eq!(created.key, "agent:main:dashboard:created");
        assert_eq!(created.session_id.as_deref(), Some("physical-id"));
        assert!(created.run_started);
        assert!(created.entry.is_none());
    }

    #[::core::prelude::v1::test]
    fn delivery_recovery_requires_exact_input_identity_and_physical_session() {
        assert!(confirmed_input(
            &json!({"sessionId":"s1","inputReceipts":[{"runId":"input-1","state":"pending"}]}),
            "input-1",
            Some("s1")
        ));
        assert!(!confirmed_input(
            &json!({"sessionId":"s2","inputReceipts":[{"runId":"input-1","state":"pending"}]}),
            "input-1",
            Some("s1")
        ));
        assert!(!confirmed_input(
            &json!({"messages":[{"role":"user","__openclaw":{"runId":"input-1"}}]}),
            "input-1",
            None
        ));
        assert!(!confirmed_input(
            &json!({"messages":[{"role":"assistant","__openclaw":{"idempotencyKey":"input-1"}}]}),
            "input-1",
            None
        ));
        assert!(confirmed_input(
            &json!({"messages":[{"role":"user","__openclaw":{"idempotencyKey":"input-1:user"}}]}),
            "input-1",
            None
        ));
    }
}
