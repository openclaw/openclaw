use super::*;
use crate::gateway_control_auth::Challenge;

struct Fixture {
    client: GatewayClient,
    directory: std::path::PathBuf,
}

impl Fixture {
    fn connected() -> Self {
        let client = GatewayClient::new();
        let directory =
            std::env::temp_dir().join(format!("openclaw-control-owner-{}", Uuid::new_v4()));
        let mut store =
            GatewayDeviceIdentityStore::load_or_create(directory.join("identity.json")).unwrap();
        store
            .persist_device_token("wss://gateway.example/control", "first-grant")
            .unwrap();
        *client.inner.identity.lock().unwrap() = Some(store);
        client.replace_configuration(Some(GatewayWsConfig::new(
            "wss://gateway.example/control".into(),
            Some("shared-secret".into()),
            None,
            None,
            GatewayOwnership::Remote,
        )));
        client.inner.config.lock().unwrap().native_control_session =
            NativeControlSession::from_hello(
                GatewayAuth::DeviceToken("first-grant".into()),
                Some("device-token"),
                Some(vec!["operator.read".into()]),
                None,
            );
        client
            .inner
            .connection_state
            .store(GatewayConnectionState::Up as u64, Ordering::SeqCst);
        Self { client, directory }
    }

    fn challenge(&self) -> Challenge {
        Challenge {
            id: "fixture".into(),
            nonce: "server-nonce".into(),
            signed_at: 1_800_000_000_000,
        }
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.directory);
    }
}

#[test]
fn native_control_owner_rejects_disconnect_route_switch_and_stale_generation() {
    let fixture = Fixture::connected();
    let client = &fixture.client;
    let generation = client.generation();
    let dashboard = Url::parse("https://gateway.example/control/chat").unwrap();
    let challenge = fixture.challenge();
    let first = client
        .native_control_auth(generation, &dashboard, &challenge)
        .unwrap();
    assert_eq!(first["scopes"], json!(["operator.read"]));
    assert_eq!(first["auth"], json!({"deviceToken":"first-grant"}));
    assert!(client
        .native_control_auth(
            generation,
            &Url::parse("https://other.example/control").unwrap(),
            &challenge
        )
        .is_err());
    client
        .inner
        .connection_state
        .store(GatewayConnectionState::Down as u64, Ordering::SeqCst);
    assert!(client
        .native_control_auth(generation, &dashboard, &challenge)
        .is_err());
    client
        .inner
        .connection_state
        .store(GatewayConnectionState::Up as u64, Ordering::SeqCst);
    client
        .inner
        .identity
        .lock()
        .unwrap()
        .as_mut()
        .unwrap()
        .persist_device_token("wss://gateway.example/control", "rotated-grant")
        .unwrap();
    let rotated = client
        .native_control_auth(generation, &dashboard, &challenge)
        .unwrap();
    assert_eq!(rotated["auth"], json!({"deviceToken":"rotated-grant"}));
    assert_ne!(first["device"]["signature"], rotated["device"]["signature"]);
    client
        .inner
        .identity
        .lock()
        .unwrap()
        .as_mut()
        .unwrap()
        .clear_device_token("wss://gateway.example/control")
        .unwrap();
    assert!(
        client
            .native_control_auth(generation, &dashboard, &challenge)
            .is_err(),
        "a revoked device grant cannot fall back to configured shared credentials"
    );
    client.replace_configuration(Some(GatewayWsConfig::new(
        "wss://gateway.example/control".into(),
        None,
        None,
        None,
        GatewayOwnership::Remote,
    )));
    assert!(client
        .inner
        .config
        .lock()
        .unwrap()
        .native_control_session
        .is_none());
    client
        .inner
        .connection_state
        .store(GatewayConnectionState::Up as u64, Ordering::SeqCst);
    assert!(client
        .native_control_auth(generation, &dashboard, &challenge)
        .is_err());
    assert!(client
        .native_control_auth(client.generation(), &dashboard, &challenge)
        .is_err());
}

#[test]
fn desktop_route_action_can_read_native_bootstrap_and_rejects_same_url_replacement() {
    let fixture = Fixture::connected();
    let client = &fixture.client;
    let generation = client.generation();
    let dashboard = client
        .with_desktop_route(generation.0, |url| {
            assert_eq!(url, Some("wss://gateway.example/control"));
            // The production callback opens/navigates a Primary WebView, whose
            // native bootstrap reads this owner again. Detect its blocked entry
            // without hanging the test process on the old recursive mutex.
            drop(client.inner.config.try_lock().map_err(|_| {
                "Desktop navigation blocks its own native authentication read.".to_string()
            })?);
            client.with_native_control_bootstrap(generation, |dashboard, _| Ok(dashboard))
        })
        .expect("desktop navigation can project its currently accepted native owner");
    assert_eq!(dashboard.as_str(), "https://gateway.example/control");

    let same_url = client.inner.config.lock().unwrap().config.clone();
    client.replace_configuration(same_url);
    assert!(client
        .with_desktop_route::<()>(generation.0, |_| {
            panic!("same-URL replacement must retire the caller before any navigation")
        })
        .is_err());
    client
        .with_desktop_route(client.generation().0, |url| {
            assert_eq!(url, Some("wss://gateway.example/control"));
            Ok(())
        })
        .unwrap();
}

#[test]
fn native_control_bootstrap_projects_only_live_accepted_shared_bindings() {
    let fixture = Fixture::connected();
    let client = &fixture.client;
    let generation = client.generation();
    let mut scripts = Vec::new();
    let mut expected = Vec::new();
    for (accepted, method, fields) in [
        (
            GatewayAuth::DeviceToken("first-grant".into()),
            "device-token",
            json!({}),
        ),
        (
            GatewayAuth::SharedToken("accepted-token".into()),
            "token",
            json!({"token":"accepted-token"}),
        ),
        (
            GatewayAuth::SharedPassword("rotated-password".into()),
            "password",
            json!({"password":"rotated-password","token":null}),
        ),
    ] {
        client.inner.config.lock().unwrap().native_control_session =
            NativeControlSession::from_hello(
                accepted,
                Some(method),
                Some(vec!["operator.read".into()]),
                None,
            );
        client
            .with_native_control_bootstrap(generation, |dashboard, script| {
                assert_eq!(dashboard.as_str(), "https://gateway.example/control");
                scripts.push(script);
                Ok(())
            })
            .unwrap();
        expected.push(fields);
    }
    client
        .inner
        .connection_state
        .store(GatewayConnectionState::Down as u64, Ordering::SeqCst);
    client
        .with_native_control_bootstrap(generation, |_, script| {
            scripts.push(script);
            Ok(())
        })
        .expect("disconnected owner publishes only a native marker without retired credentials");
    expected.push(json!({}));
    client.inner.config.lock().unwrap().native_control_session = None;
    client
        .inner
        .connection_state
        .store(GatewayConnectionState::Up as u64, Ordering::SeqCst);
    client
        .with_native_control_bootstrap(generation, |_, script| {
            scripts.push(script);
            Ok(())
        })
        .unwrap();
    expected.push(json!({}));
    client.replace_configuration(None);
    assert!(client
        .with_native_control_bootstrap::<()>(generation, |_, _| {
            panic!("retired owner must not publish startup credentials")
        })
        .is_err());
    // Execute the actual document-start script. The submitted config credential
    // differs from each accepted method and must never appear in the bootstrap.
    let runner = r#"
      const inputs = JSON.parse(process.argv[1]);
      const expected = JSON.parse(process.argv[2]);
      const assert = require('node:assert/strict');
      inputs.forEach((script, index) => {
        const window = { addEventListener() {}, __TAURI_INTERNALS__: { invoke() {} } };
        window.top = window;
        new Function('window', 'location', script)(window, {origin:'https://gateway.example', pathname:'/control/chat'});
        assert.deepEqual(window.__OPENCLAW_NATIVE_CONTROL_AUTH__, {
          gatewayUrl:'wss://gateway.example/control', ...expected[index], nativeConnectAuth:true,
        });
      });
    "#;
    let output = std::process::Command::new("node")
        .args([
            "-e",
            runner,
            &serde_json::to_string(&scripts).unwrap(),
            &serde_json::to_string(&expected).unwrap(),
        ])
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
}

#[test]
fn native_control_owner_uses_accepted_session_secret_not_current_configuration_or_device_grant() {
    let fixture = Fixture::connected();
    let client = &fixture.client;
    let generation = client.generation();
    let dashboard = Url::parse("https://gateway.example/control/chat").unwrap();
    let challenge = fixture.challenge();
    for (auth, method, expected) in [
        (
            GatewayAuth::SharedToken("accepted-token".into()),
            "token",
            json!({"token":"accepted-token"}),
        ),
        (
            GatewayAuth::SharedPassword("accepted-password".into()),
            "password",
            json!({"password":"accepted-password"}),
        ),
    ] {
        let hello = validate_hello(json!({
            "type":"hello-ok", "protocol":MAX_PROTOCOL_VERSION,
            "features":{"methods":["agents.list", "chat.send"]},
            "auth":{"method":method,"role":"operator","scopes":["operator.read"]},
        }))
        .unwrap();
        client.inner.config.lock().unwrap().native_control_session =
            NativeControlSession::from_hello(
                auth.clone(),
                hello.auth_method.as_deref(),
                hello.operator_scopes,
                hello.device_token.as_deref(),
            );
        let result = client
            .native_control_auth(generation, &dashboard, &challenge)
            .unwrap();
        assert_eq!(result["auth"], expected);
        assert_eq!(result["scopes"], json!(["operator.read"]));
        client.inner.config.lock().unwrap().native_control_session =
            NativeControlSession::from_hello(
                auth,
                Some("trusted-proxy"),
                Some(vec!["operator.read".into()]),
                None,
            );
        assert!(
            client
                .native_control_auth(generation, &dashboard, &challenge)
                .is_err(),
            "method mismatch cannot use configured shared secret or stored device grant"
        );
    }
}

#[test]
fn verified_network_session_uses_only_its_issued_current_device_grant() {
    let fixture = Fixture::connected();
    let client = &fixture.client;
    let generation = client.generation();
    let dashboard = Url::parse("https://gateway.example/control/chat").unwrap();
    let challenge = fixture.challenge();
    for method in ["tailscale", "trusted-proxy", "bootstrap-token"] {
        let hello = validate_hello(json!({
            "type":"hello-ok", "protocol":MAX_PROTOCOL_VERSION,
            "features":{"methods":["agents.list", "chat.send"]},
            "auth":{"method":method,"role":"operator","scopes":["operator.read"],"deviceToken":"issued-network-grant"},
        })).unwrap();
        client
            .inner
            .identity
            .lock()
            .unwrap()
            .as_mut()
            .unwrap()
            .persist_device_token(
                "wss://gateway.example/control",
                hello.device_token.as_deref().unwrap(),
            )
            .unwrap();
        client.inner.config.lock().unwrap().native_control_session =
            NativeControlSession::from_hello(
                GatewayAuth::SharedToken("unaccepted-configured-secret".into()),
                hello.auth_method.as_deref(),
                hello.operator_scopes,
                hello.device_token.as_deref(),
            );
        let result = client
            .native_control_auth(generation, &dashboard, &challenge)
            .unwrap();
        assert_eq!(
            result["auth"],
            json!({"deviceToken":"issued-network-grant"})
        );
        client
            .inner
            .identity
            .lock()
            .unwrap()
            .as_mut()
            .unwrap()
            .persist_device_token("wss://gateway.example/control", "rotated-network-grant")
            .unwrap();
        let rotated = client
            .native_control_auth(generation, &dashboard, &challenge)
            .unwrap();
        assert_eq!(
            rotated["auth"],
            json!({"deviceToken":"rotated-network-grant"})
        );
        assert_ne!(
            result["device"]["signature"],
            rotated["device"]["signature"]
        );
        client
            .inner
            .identity
            .lock()
            .unwrap()
            .as_mut()
            .unwrap()
            .clear_device_token("wss://gateway.example/control")
            .unwrap();
        assert!(client
            .native_control_auth(generation, &dashboard, &challenge)
            .is_err());
    }
}

#[test]
fn hello_grants_operator_scopes_without_fabricating_native_authority() {
    let hello = |auth: Value| {
        validate_hello(json!({
            "type":"hello-ok", "protocol":MAX_PROTOCOL_VERSION,
            "features":{"methods":["agents.list", "chat.send"]}, "auth":auth,
        }))
        .unwrap()
    };
    assert_eq!(
        hello(json!({"role":"operator", "scopes":["operator.read"]})).operator_scopes,
        Some(vec!["operator.read".into()])
    );
    assert_eq!(
        hello(json!({"role":"operator", "scopes":[]})).operator_scopes,
        Some(vec![])
    );
    assert!(hello(json!({"role":"node", "scopes":["operator.admin"]}))
        .operator_scopes
        .is_none());
    assert!(hello(json!({"role":"operator"})).operator_scopes.is_none());
    assert!(hello(json!({})).operator_scopes.is_none());
}

#[tokio::test]
async fn native_control_wait_does_not_cross_configuration_generations() {
    let fixture = Fixture::connected();
    let generation = fixture.client.generation();
    fixture
        .client
        .wait_for_native_control_auth(generation)
        .await
        .unwrap();
    fixture.client.replace_configuration(None);
    assert!(fixture
        .client
        .wait_for_native_control_auth(generation)
        .await
        .is_err());
}
