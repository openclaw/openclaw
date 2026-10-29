//! DM pairing invariants from `docs/channels/pairing.md`.
//!
//! Each test names a documented rule the earlier implementation violated:
//! code shape, 1-hour expiry, 3-pending cap per channel account, account
//! scoping, and approval only for a live pending request.

use openclaw_state::SqliteStateStore;

fn store() -> SqliteStateStore {
    SqliteStateStore::in_memory().unwrap()
}

#[test]
fn codes_are_eight_uppercase_chars_without_ambiguous_letters() {
    let store = store();
    // A distinct account per iteration keeps the 3-pending cap out of the way.
    for index in 0..64 {
        let account = format!("acct_{index}");
        let request = store
            .get_or_create_pairing_in("telegram", &account, "sender", "Name", "chat")
            .unwrap();
        assert_eq!(
            request.code.chars().count(),
            8,
            "official codes are 8 characters, got {:?}",
            request.code
        );
        assert!(
            request
                .code
                .chars()
                .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit()),
            "code must be uppercase alphanumeric, got {:?}",
            request.code
        );
        for ambiguous in ['0', 'O', '1', 'I'] {
            assert!(
                !request.code.contains(ambiguous),
                "code {:?} contains ambiguous character {ambiguous:?}",
                request.code
            );
        }
    }
}

#[test]
fn pending_requests_are_capped_at_three_per_channel_account() {
    let store = store();
    let mut created = 0;
    for index in 0..10 {
        let sender = format!("sender_{index}");
        if store
            .get_or_create_pairing("telegram", &sender, "Name", "chat")
            .is_ok()
        {
            created += 1;
        }
    }
    assert_eq!(
        created, 3,
        "official caps pending DM pairing requests at 3 per channel account"
    );
    assert_eq!(store.pending_pairing_count("telegram", "default").unwrap(), 3);
}

#[test]
fn requests_and_approvals_are_scoped_to_the_channel_account() {
    let store = store();
    let request = store
        .get_or_create_pairing_in("telegram", "work", "sender", "Name", "chat")
        .unwrap();

    // Approving through the wrong account must not grant access.
    assert!(store
        .approve_pairing_in("telegram", Some("personal"), &request.code)
        .unwrap()
        .is_none());
    assert!(!store
        .is_sender_approved_in("telegram", "personal", "sender")
        .unwrap());

    assert!(store
        .approve_pairing_in("telegram", Some("work"), &request.code)
        .unwrap()
        .is_some());
    assert!(store
        .is_sender_approved_in("telegram", "work", "sender")
        .unwrap());
    assert!(
        !store
            .is_sender_approved_in("telegram", "personal", "sender")
            .unwrap(),
        "approval leaked across accounts"
    );
}

#[test]
fn a_repeated_message_does_not_create_a_second_request() {
    let store = store();
    let first = store
        .get_or_create_pairing("telegram", "sender", "Name", "chat")
        .unwrap();
    let second = store
        .get_or_create_pairing("telegram", "sender", "Name", "chat")
        .unwrap();
    assert_eq!(first.code, second.code);
    assert!(first.created, "first request must report creation");
    assert!(
        !second.created,
        "a repeat message must not trigger another pairing notice"
    );
}

#[test]
fn dismiss_removes_a_pending_request_without_blocking_the_sender() {
    let store = store();
    let request = store
        .get_or_create_pairing("telegram", "sender", "Name", "chat")
        .unwrap();
    assert!(store
        .dismiss_pairing("telegram", "default", &request.code)
        .unwrap());
    assert_eq!(store.pending_pairing_count("telegram", "default").unwrap(), 0);
    assert!(!store.is_sender_approved("telegram", "sender").unwrap());
    // Dismissal is not a block: the sender can request access again.
    let again = store
        .get_or_create_pairing("telegram", "sender", "Name", "chat")
        .unwrap();
    assert!(again.created);
}

#[test]
fn approving_twice_is_not_silently_successful() {
    let store = store();
    let request = store
        .get_or_create_pairing("telegram", "sender", "Name", "chat")
        .unwrap();
    assert!(store
        .approve_pairing("telegram", &request.code)
        .unwrap()
        .is_some());
    assert!(
        store
            .approve_pairing("telegram", &request.code)
            .unwrap()
            .is_none(),
        "an already-approved code must not report a fresh approval"
    );
}

#[test]
fn unknown_code_is_refused() {
    let store = store();
    assert!(store
        .approve_pairing("telegram", "ZZZZZZZZ")
        .unwrap()
        .is_none());
}

#[test]
fn expired_codes_are_refused_and_stop_counting_toward_the_cap() {
    let store = store();
    // Simulate an old request by writing it with a stale timestamp.
    store
        .insert_pairing_for_test("telegram", "default", "old_sender", "OLDCODE2", "2000-01-01T00:00:00+00:00")
        .unwrap();

    assert!(
        store
            .approve_pairing("telegram", "OLDCODE2")
            .unwrap()
            .is_none(),
        "an expired pairing code was accepted"
    );
    assert_eq!(
        store.pending_pairing_count("telegram", "default").unwrap(),
        0,
        "expired requests must not occupy the pending cap"
    );
    assert!(!store.is_sender_approved("telegram", "old_sender").unwrap());
}
