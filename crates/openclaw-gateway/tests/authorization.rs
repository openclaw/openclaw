//! Every dispatched method must be authorized by operator scope.
//!
//! Official reference: `src/gateway/server-methods/method-authorization.ts` —
//! every request passes `authorizeGatewayMethod` before the handler, failures
//! return `FORBIDDEN` with `details.code = "MISSING_SCOPE"`, and unclassified
//! methods default-deny. The Rust dispatcher called handlers directly and
//! `scope_for` was never consulted, so `sessions.end` and `config.get` needed no
//! scope at all.

use openclaw_gateway::ConnectionScopes;
use openclaw_protocol::core_methods::{scope_for, Scope};
use std::collections::BTreeSet;

fn read_only() -> ConnectionScopes {
    ConnectionScopes {
        granted: ["operator.read"]
            .iter()
            .map(|s| (*s).to_owned())
            .collect::<BTreeSet<_>>(),
    }
}

fn write_only() -> ConnectionScopes {
    ConnectionScopes {
        granted: ["operator.write"]
            .iter()
            .map(|s| (*s).to_owned())
            .collect::<BTreeSet<_>>(),
    }
}

#[test]
fn read_scope_cannot_reach_write_or_admin_methods() {
    let scopes = read_only();
    assert!(scopes.permits(Scope::Read));
    assert!(
        !scopes.permits(Scope::Write),
        "read-only credential must not satisfy write scope"
    );
    assert!(
        !scopes.permits(Scope::Admin),
        "read-only credential must not satisfy admin scope"
    );
}

#[test]
fn write_scope_implies_read_but_not_admin() {
    let scopes = write_only();
    assert!(scopes.permits(Scope::Read), "write implies read");
    assert!(scopes.permits(Scope::Write));
    assert!(!scopes.permits(Scope::Admin));
}

#[test]
fn admin_implies_every_operator_scope() {
    let scopes = ConnectionScopes::operator_full();
    for required in [
        Scope::Read,
        Scope::Write,
        Scope::Admin,
        Scope::Named("operator.pairing"),
        Scope::Named("operator.approvals"),
        Scope::Named("operator.talk.secrets"),
        Scope::Named("operator.sessions.write"),
    ] {
        assert!(scopes.permits(required), "admin must satisfy {required:?}");
    }
}

#[test]
fn empty_scopes_permit_nothing() {
    let scopes = ConnectionScopes::default();
    assert!(!scopes.permits(Scope::Read));
    assert!(!scopes.permits(Scope::Write));
    assert!(!scopes.permits(Scope::Admin));
}

#[test]
fn dispatched_methods_declare_a_scope() {
    // Every method the dispatcher handles must be classified; otherwise the
    // default-deny path makes it unreachable.
    for method in [
        "ping",
        "health",
        "sessions.list",
        "sessions.create",
        "sessions.get",
        "sessions.end",
        "channels.list",
        "channels.status",
        "message.send",
        "config.get",
    ] {
        assert!(
            scope_for(method).is_some(),
            "{method} is dispatched but has no declared scope"
        );
    }
}

#[test]
fn destructive_and_privileged_methods_are_not_read_scope() {
    // `sessions.end` deletes state and `config.get` exposes configuration; the
    // old 3-level table marked several privileged families as `read`.
    assert_ne!(scope_for("sessions.end"), Some(Scope::Read));
    for pairing in ["device.pair.approve", "channels.pairing.approve", "node.pair.approve"] {
        assert_eq!(
            scope_for(pairing),
            Some(Scope::Named("operator.pairing")),
            "{pairing} must require operator.pairing"
        );
    }
    for talk in ["talk.speak", "talk.catalog"] {
        assert_eq!(
            scope_for(talk),
            Some(Scope::Named("operator.talk")),
            "{talk} must require operator.talk"
        );
    }
    assert_eq!(
        scope_for("talk.voice.get"),
        Some(Scope::Named("operator.talk.secrets")),
        "talk voice secrets must require operator.talk.secrets"
    );
    assert_eq!(
        scope_for("openclaw.approval.list"),
        Some(Scope::Named("operator.approvals")),
        "approvals must require operator.approvals"
    );
}

#[test]
fn pairing_approve_method_exists() {
    // The table previously advertised `channels.pairing.dismiss` but not
    // `channels.pairing.approve`, which is internally inconsistent.
    assert!(scope_for("channels.pairing.approve").is_some());
    assert!(scope_for("channels.pairing.list").is_some());
    assert!(scope_for("channels.pairing.dismiss").is_some());
}
