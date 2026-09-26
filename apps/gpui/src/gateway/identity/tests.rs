use super::*;

#[test]
fn web_store_removal_requires_a_record_owned_by_this_root() {
    let directory = std::env::temp_dir().join(format!("gpui-web-store-test-{}", random_id()));
    let mut identity = Identity::load_at(&directory).unwrap();
    let mut stale = identity.clone();
    let scope = crate::web_data_store::control_scope("wss://example.test/").unwrap();
    assert_eq!(identity.begin_web_store_removal(&scope).unwrap(), None);
    let id = identity.record_web_store(&scope).unwrap();
    let reading = identity.record_web_store("reading").unwrap();
    // Token writers and deletion callers may hold older state snapshots.
    stale
        .set_device_token_for_profile(None, "wss://example.test/", Some("fixture"))
        .unwrap();
    assert_eq!(stale.begin_web_store_removal(&scope).unwrap(), Some(id));
    assert!(identity.record_web_store(&scope).is_err());
    identity.finish_web_store_removal(&scope, reading).unwrap();
    assert!(identity.web_data_stores.contains_key(&scope));
    identity.finish_web_store_removal(&scope, id).unwrap();
    assert_eq!(stale.begin_web_store_removal(&scope).unwrap(), None);
    assert_eq!(stale.web_data_stores["reading"].identifier, reading);
    assert_eq!(stale.device_token("wss://example.test/"), Some("fixture"));
    // Copying app state cannot authorize deletion in the original root.
    let other = directory.join("copied-root");
    fs::create_dir(&other).unwrap();
    fs::copy(&identity.path, other.join("identity.json")).unwrap();
    let mut copied = Identity::load_at(&other).unwrap();
    assert!(copied.begin_web_store_removal("reading").is_err());
    assert!(copied.record_web_store("reading").is_err());
    #[cfg(unix)]
    {
        let alias = directory.join("alias");
        std::os::unix::fs::symlink(&directory, &alias).unwrap();
        assert_eq!(
            Identity::load_at(&alias)
                .unwrap()
                .record_web_store("reading")
                .unwrap(),
            reading
        );
        fs::remove_file(alias).unwrap();
    }
    fs::remove_dir_all(directory).unwrap();
}

#[test]
fn sessions_and_last_gateway_roundtrip_without_clobbering_device_tokens() {
    let directory = std::env::temp_dir().join(format!("openclaw-gpui-state-test-{}", random_id()));
    let mut first = Identity::load_at(&directory).unwrap();
    let mut stale = first.clone();
    first
        .set_device_token_for_profile(None, "wss://team.example/", Some("device-secret"))
        .unwrap();
    let session = Session {
        application: super::super::access::Application {
            origin: "https://team.example".into(),
            issuer: "https://team.cloudflareaccess.com".into(),
            audience: "test-audience".into(),
        },
        subject: "test-subject".into(),
        email: Some("synthetic@example.test".into()),
        token: "access-secret".into(),
        expires_at: 2_000_000_000.,
    };
    stale
        .set_access_session_for_profile(None, "https://team.example", Some(session))
        .unwrap();
    first.remember_gateway("wss://team.example/").unwrap();
    let loaded = Identity::load_at(&directory).unwrap();
    assert_eq!(
        loaded.device_token("wss://team.example/"),
        Some("device-secret")
    );
    assert_eq!(
        loaded.access_session("https://team.example").unwrap().token,
        "access-secret"
    );
    assert_eq!(
        loaded.last_gateway_url.as_deref(),
        Some("wss://team.example/")
    );
    let debug = format!("{loaded:?}");
    for secret in ["device-secret", "access-secret", &loaded.secret_key] {
        assert!(!debug.contains(secret));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            fs::metadata(&loaded.path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        assert_eq!(
            fs::metadata(&directory).unwrap().permissions().mode() & 0o777,
            0o700
        );
    }
    let mut refreshed = loaded
        .access_session("https://team.example")
        .unwrap()
        .clone();
    refreshed.token = "new-access-secret".into();
    first
        .set_access_session_for_profile(None, "https://team.example", Some(refreshed))
        .unwrap();
    stale
        .clear_access_session_if_for_profile(None, "https://team.example", "access-secret")
        .unwrap();
    assert_eq!(
        stale.access_session("https://team.example").unwrap().token,
        "new-access-secret"
    );
    stale
        .set_access_session_for_profile(None, "https://team.example", None)
        .unwrap();
    let signed_out = Identity::load_at(&directory).unwrap();
    assert!(signed_out.access_session("https://team.example").is_none());
    assert_eq!(
        signed_out.device_token("wss://team.example/"),
        Some("device-secret")
    );
    assert_eq!(signed_out.last_gateway_url, loaded.last_gateway_url);
    fs::remove_dir_all(directory).unwrap();
}

#[test]
fn existing_identity_files_keep_their_key_and_tokens_when_url_is_normalized() {
    let directory =
        std::env::temp_dir().join(format!("openclaw-gpui-migration-test-{}", random_id()));
    let first = Identity::load_at(&directory).unwrap();
    let old = json!({"secret_key": first.secret_key, "device_tokens": {"ws://127.0.0.1:19471": "old-device-token"}});
    fs::write(&first.path, serde_json::to_vec(&old).unwrap()).unwrap();
    let loaded = Identity::load_at(&directory).unwrap();
    assert_eq!(loaded.secret_key, first.secret_key);
    assert_eq!(
        loaded.device_token("ws://127.0.0.1:19471/"),
        Some("old-device-token")
    );
    assert!(loaded.access_sessions.is_empty());
    fs::remove_dir_all(directory).unwrap();
}

#[test]
fn sidebar_preferences_are_gateway_scoped_and_survive_other_writers() {
    use crate::model::sidebar::{ArchiveFilter, Grouping, SidebarPreferences};
    let directory = std::env::temp_dir().join(format!("gpui-sidebar-state-{}", random_id()));
    let mut first = Identity::load_at(&directory).unwrap();
    let mut stale = first.clone();
    let prefs = SidebarPreferences {
        archive: ArchiveFilter::Archived,
        grouping: Grouping::Person,
        show_preview: true,
        ..Default::default()
    };
    first
        .save_sidebar_preferences("profile:a", prefs.clone())
        .unwrap();
    stale
        .set_device_token_for_profile(None, "ws://127.0.0.1:19471/", Some("fixture"))
        .unwrap();
    stale
        .save_sidebar_preferences("profile:b", SidebarPreferences::default())
        .unwrap();
    let loaded = Identity::load_at(&directory).unwrap();
    assert_eq!(loaded.sidebar_preferences("profile:a"), prefs);
    assert_eq!(
        loaded.sidebar_preferences("profile:b"),
        SidebarPreferences::default()
    );
    assert_eq!(
        loaded.device_token("ws://127.0.0.1:19471/"),
        Some("fixture")
    );
    fs::remove_dir_all(directory).unwrap();
}

#[test]
fn payload_matches_the_typescript_gateway_auth_vectors() {
    // Exact v3 vector from src/gateway/device-auth.test.ts, whose builder is
    // packages/gateway-client/src/device-auth.ts. Changes alter signed bytes.
    let auth = DeviceAuth {
        device_id: "dev-1",
        client_id: "openclaw-macos",
        scopes: &["operator.admin", "operator.read"],
        signed_at: 1_700_000_000_000,
        token: "tok-123",
        nonce: "nonce-abc",
        platform: "  IOS  ",
        device_family: "  iPhone  ",
    };
    assert_eq!(
        payload(&auth),
        "v3|dev-1|openclaw-macos|ui|operator|operator.admin,operator.read|1700000000000|tok-123|nonce-abc|ios|iphone"
    );
    let empty = DeviceAuth {
        device_id: "dev-2",
        client_id: "openclaw-ios",
        scopes: &["operator.read"],
        signed_at: 1_700_000_000_001,
        token: "",
        nonce: "nonce-def",
        platform: "",
        device_family: "",
    };
    assert_eq!(
        payload(&empty),
        "v3|dev-2|openclaw-ios|ui|operator|operator.read|1700000000001||nonce-def||"
    );
}

#[test]
fn device_id_is_sha256_of_raw_public_key_and_proof_verifies() {
    use ed25519_dalek::{Signature, Verifier};
    // RFC 8032 test vector 1: public bytes, not DER or base64, own the ID.
    let public_key = [
        0xd7, 0x5a, 0x98, 0x01, 0x82, 0xb1, 0x0a, 0xb7, 0xd5, 0x4b, 0xfe, 0xd3, 0xc9, 0x64, 0x07,
        0x3a, 0x0e, 0xe1, 0x72, 0xf3, 0xda, 0xa6, 0x23, 0x25, 0xaf, 0x02, 0x1a, 0x68, 0xf7, 0x07,
        0x51, 0x1a,
    ];
    assert_eq!(
        device_id(&public_key),
        "21fe31dfa154a261626bf854046fd2271b7bed4b6abe45aa58877ef47f9721b9"
    );
    let identity = Identity {
        secret_key: URL_SAFE_NO_PAD.encode([7; 32]),
        device_tokens: BTreeMap::new(),
        access_sessions: BTreeMap::new(),
        last_gateway_url: None,
        profiles: Vec::new(),
        primary_profile_id: None,
        profiles_migrated: true,
        profile_credentials: BTreeMap::new(),
        profile_web_scopes: BTreeMap::new(),
        web_data_stores: BTreeMap::new(),
        sidebar_preferences: BTreeMap::new(),
        path: PathBuf::new(),
    };
    let auth = DeviceAuth {
        device_id: "",
        client_id: "openclaw-macos",
        scopes: &[
            "operator.read",
            "operator.write",
            "operator.approvals",
            "operator.questions",
        ],
        signed_at: 123,
        token: "fixture-token",
        nonce: "fixture-nonce",
        platform: "macos",
        device_family: "",
    };
    let proof = identity.proof(auth).unwrap();
    let signature = Signature::from_slice(
        &URL_SAFE_NO_PAD
            .decode(proof["signature"].as_str().unwrap())
            .unwrap(),
    )
    .unwrap();
    let expected = format!(
        "v3|{}|openclaw-macos|ui|operator|operator.read,operator.write,operator.approvals,operator.questions|123|fixture-token|fixture-nonce|macos|",
        proof["id"].as_str().unwrap()
    );
    identity
        .signing_key()
        .unwrap()
        .verifying_key()
        .verify(expected.as_bytes(), &signature)
        .unwrap();
}
