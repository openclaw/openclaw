use futures_util::{SinkExt, StreamExt};
use openclaw_gateway_client::{
    ClientError, GatewayClient, GatewayClientConfig, TlsCertificatePolicy, TlsPeerCertificate,
    TlsTrust,
};
use rustls::{
    pki_types::PrivatePkcs8KeyDer,
    sign::{CertifiedKey, SingleCertAndKey},
    ServerConfig,
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    future::Future,
    pin::Pin,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{io::AsyncReadExt, net::TcpListener, sync::Notify};
use tokio_rustls::TlsAcceptor;
use tokio_tungstenite::{
    accept_hdr_async,
    tungstenite::{handshake::server::Request, Message},
};

// Synthetic test-only localhost certificate and private keys; never used outside this fixture.
// DER bytes are source text so security reviews can inspect the entire test patch.
const CERTIFICATE: &[u8] = &[
    0x30, 0x82, 0x01, 0x70, 0x30, 0x82, 0x01, 0x16, 0xa0, 0x03, 0x02, 0x01, 0x02, 0x02, 0x09, 0x00,
    0x84, 0x69, 0xda, 0xf3, 0xfb, 0xef, 0x4a, 0x76, 0x30, 0x0a, 0x06, 0x08, 0x2a, 0x86, 0x48, 0xce,
    0x3d, 0x04, 0x03, 0x02, 0x30, 0x14, 0x31, 0x12, 0x30, 0x10, 0x06, 0x03, 0x55, 0x04, 0x03, 0x0c,
    0x09, 0x6c, 0x6f, 0x63, 0x61, 0x6c, 0x68, 0x6f, 0x73, 0x74, 0x30, 0x1e, 0x17, 0x0d, 0x32, 0x36,
    0x30, 0x39, 0x31, 0x36, 0x30, 0x34, 0x31, 0x36, 0x33, 0x38, 0x5a, 0x17, 0x0d, 0x33, 0x36, 0x30,
    0x39, 0x31, 0x33, 0x30, 0x34, 0x31, 0x36, 0x33, 0x38, 0x5a, 0x30, 0x14, 0x31, 0x12, 0x30, 0x10,
    0x06, 0x03, 0x55, 0x04, 0x03, 0x0c, 0x09, 0x6c, 0x6f, 0x63, 0x61, 0x6c, 0x68, 0x6f, 0x73, 0x74,
    0x30, 0x59, 0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01, 0x06, 0x08, 0x2a,
    0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07, 0x03, 0x42, 0x00, 0x04, 0xb5, 0x2a, 0xfe, 0xa4, 0x17,
    0x73, 0x3c, 0xa2, 0xd4, 0x0b, 0x63, 0xc7, 0x2c, 0xd5, 0x49, 0x06, 0x95, 0x09, 0xe4, 0x2d, 0x88,
    0xf0, 0xdf, 0x52, 0xf3, 0xe0, 0x0d, 0x7a, 0x1d, 0xc5, 0x34, 0xc5, 0x7a, 0xf8, 0xf5, 0xb3, 0x19,
    0x82, 0xd2, 0xcb, 0x50, 0x44, 0x06, 0x38, 0x96, 0x57, 0xe3, 0xa6, 0xd4, 0x86, 0x23, 0x1a, 0xb3,
    0x35, 0xf5, 0x76, 0xf8, 0xb0, 0xa3, 0x79, 0x64, 0x04, 0x9f, 0x99, 0xa3, 0x51, 0x30, 0x4f, 0x30,
    0x1a, 0x06, 0x03, 0x55, 0x1d, 0x11, 0x04, 0x13, 0x30, 0x11, 0x82, 0x09, 0x6c, 0x6f, 0x63, 0x61,
    0x6c, 0x68, 0x6f, 0x73, 0x74, 0x87, 0x04, 0x7f, 0x00, 0x00, 0x01, 0x30, 0x0c, 0x06, 0x03, 0x55,
    0x1d, 0x13, 0x01, 0x01, 0xff, 0x04, 0x02, 0x30, 0x00, 0x30, 0x0e, 0x06, 0x03, 0x55, 0x1d, 0x0f,
    0x01, 0x01, 0xff, 0x04, 0x04, 0x03, 0x02, 0x07, 0x80, 0x30, 0x13, 0x06, 0x03, 0x55, 0x1d, 0x25,
    0x04, 0x0c, 0x30, 0x0a, 0x06, 0x08, 0x2b, 0x06, 0x01, 0x05, 0x05, 0x07, 0x03, 0x01, 0x30, 0x0a,
    0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x04, 0x03, 0x02, 0x03, 0x48, 0x00, 0x30, 0x45, 0x02,
    0x21, 0x00, 0xc7, 0xb2, 0xf9, 0xb0, 0x95, 0x8d, 0x5c, 0x9f, 0xee, 0xfb, 0x19, 0xc7, 0x23, 0xfe,
    0x2a, 0x6c, 0x6a, 0x4c, 0x08, 0x7c, 0xfe, 0x8a, 0x3a, 0xb0, 0x1c, 0xdd, 0x6b, 0x40, 0x89, 0x97,
    0x3c, 0xa4, 0x02, 0x20, 0x49, 0xc4, 0xb5, 0xfa, 0x07, 0xb1, 0xb0, 0x31, 0x68, 0x89, 0xcb, 0x55,
    0xde, 0x52, 0x9d, 0x5f, 0x1f, 0xf1, 0x16, 0x13, 0x92, 0xac, 0xae, 0x00, 0x8f, 0x3c, 0xa1, 0xd3,
    0x75, 0x6c, 0x10, 0x19,
];
const KEY: &[u8] = &[
    0x30, 0x81, 0x87, 0x02, 0x01, 0x00, 0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02,
    0x01, 0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07, 0x04, 0x6d, 0x30, 0x6b, 0x02,
    0x01, 0x01, 0x04, 0x20, 0xed, 0xfb, 0x20, 0x75, 0xe4, 0x7c, 0xad, 0x99, 0x6f, 0x27, 0x5a, 0xa3,
    0x2f, 0x77, 0x47, 0x2f, 0xf2, 0x4d, 0x8d, 0x84, 0xba, 0x7e, 0x5f, 0x3e, 0x24, 0x90, 0x8d, 0x1f,
    0xd2, 0xf7, 0x88, 0xc0, 0xa1, 0x44, 0x03, 0x42, 0x00, 0x04, 0xb5, 0x2a, 0xfe, 0xa4, 0x17, 0x73,
    0x3c, 0xa2, 0xd4, 0x0b, 0x63, 0xc7, 0x2c, 0xd5, 0x49, 0x06, 0x95, 0x09, 0xe4, 0x2d, 0x88, 0xf0,
    0xdf, 0x52, 0xf3, 0xe0, 0x0d, 0x7a, 0x1d, 0xc5, 0x34, 0xc5, 0x7a, 0xf8, 0xf5, 0xb3, 0x19, 0x82,
    0xd2, 0xcb, 0x50, 0x44, 0x06, 0x38, 0x96, 0x57, 0xe3, 0xa6, 0xd4, 0x86, 0x23, 0x1a, 0xb3, 0x35,
    0xf5, 0x76, 0xf8, 0xb0, 0xa3, 0x79, 0x64, 0x04, 0x9f, 0x99,
];
const WRONG_KEY: &[u8] = &[
    0x30, 0x81, 0x87, 0x02, 0x01, 0x00, 0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02,
    0x01, 0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07, 0x04, 0x6d, 0x30, 0x6b, 0x02,
    0x01, 0x01, 0x04, 0x20, 0x6b, 0xbd, 0x1a, 0x92, 0xa8, 0xb9, 0x2d, 0xe4, 0xa3, 0x15, 0xe1, 0xfd,
    0xc3, 0x7a, 0xd7, 0x29, 0xa7, 0xba, 0xe4, 0xed, 0x2c, 0xc7, 0xac, 0x8b, 0x2f, 0x49, 0x53, 0xa4,
    0xc2, 0x1b, 0xc9, 0x2d, 0xa1, 0x44, 0x03, 0x42, 0x00, 0x04, 0x19, 0x93, 0xba, 0x31, 0x26, 0x2c,
    0x5a, 0x4f, 0xaf, 0x71, 0xe9, 0xfa, 0x7b, 0x3f, 0x15, 0x70, 0x19, 0x39, 0x76, 0x49, 0x1c, 0x70,
    0x92, 0x9c, 0xf1, 0x8c, 0xad, 0x3f, 0xc3, 0x42, 0xf7, 0x49, 0x8f, 0xdd, 0xff, 0x91, 0x57, 0x63,
    0x97, 0xb3, 0x4a, 0x48, 0xee, 0xbc, 0xc4, 0x47, 0x64, 0x5e, 0xe9, 0xe3, 0xae, 0xb5, 0x9d, 0x12,
    0x6d, 0x2e, 0x78, 0xc9, 0xd1, 0x32, 0xde, 0x10, 0xcc, 0xc0,
];

#[derive(Debug)]
struct Policy {
    approve: Option<bool>,
    seen: Mutex<Option<TlsPeerCertificate>>,
    started: Notify,
}

impl Policy {
    fn new(approve: Option<bool>) -> Arc<Self> {
        Arc::new(Self {
            approve,
            seen: Mutex::new(None),
            started: Notify::new(),
        })
    }
}

impl TlsCertificatePolicy for Policy {
    fn verify(
        &self,
        peer: TlsPeerCertificate,
    ) -> Pin<Box<dyn Future<Output = Result<(), String>> + Send>> {
        *self.seen.lock().unwrap() = Some(peer);
        self.started.notify_one();
        let approve = self.approve;
        Box::pin(async move {
            match approve {
                Some(true) => Ok(()),
                Some(false) => Err("native certificate policy rejected the peer".into()),
                None => std::future::pending().await,
            }
        })
    }
}

fn acceptor(wrong_key: bool) -> TlsAcceptor {
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let key = PrivatePkcs8KeyDer::from(if wrong_key { WRONG_KEY } else { KEY }.to_vec()).into();
    let signer = provider.key_provider.load_private_key(key).unwrap();
    // The bad-signature case deliberately pairs this certificate with another private key.
    let certified = CertifiedKey::new(vec![CERTIFICATE.to_vec().into()], signer);
    let config = ServerConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .unwrap()
        .with_no_client_auth()
        .with_cert_resolver(Arc::new(SingleCertAndKey::from(certified)));
    TlsAcceptor::from(Arc::new(config))
}

#[tokio::test]
#[allow(clippy::result_large_err)]
async fn approved_native_and_pinned_trust_upgrade_the_same_socket() {
    for native_policy in [true, false] {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let policy = Policy::new(Some(true));
        let server_policy = Arc::clone(&policy);
        let server = tokio::spawn(async move {
            let (tcp, _) = listener.accept().await.unwrap();
            let tls = acceptor(false).accept(tcp).await.unwrap();
            let mut socket = accept_hdr_async(tls, |request: &Request, response| {
                assert_eq!(server_policy.seen.lock().unwrap().is_some(), native_policy);
                assert_eq!(
                    request.headers()["X-Synthetic-Credential"],
                    "after-native-trust"
                );
                Ok(response)
            })
            .await
            .unwrap();
            socket
                .send(Message::Text(
                    json!({"type":"event", "event":"connect.challenge",
            "payload":{"nonce":"nonce", "ts":1}})
                    .to_string()
                    .into(),
                ))
                .await
                .unwrap();
            let connect: Value =
                serde_json::from_str(&socket.next().await.unwrap().unwrap().into_text().unwrap())
                    .unwrap();
            socket
                .send(Message::Text(
                    json!({"type":"res", "id":connect["id"], "ok":true,
            "payload":{"protocol":4}})
                    .to_string()
                    .into(),
                ))
                .await
                .unwrap();
            socket.close(None).await.unwrap();
        });
        let config = GatewayClientConfig::new(format!("wss://{address}"))
            .unwrap()
            .header("X-Synthetic-Credential", "after-native-trust")
            .unwrap();
        let config = if native_policy {
            config.tls_certificate_policy(policy.clone())
        } else {
            config.tls_trust(TlsTrust::Pinned(Sha256::digest(CERTIFICATE).into()))
        };
        let session = GatewayClient::connect(config, |_| async {
            Ok::<_, String>(json!({"auth":{"token":"synthetic"}}))
        })
        .await
        .unwrap();
        assert_eq!(session.hello()["protocol"], 4);
        if native_policy {
            let peer = policy.seen.lock().unwrap().take().unwrap();
            assert_eq!(peer.peer_addr, address);
            assert_eq!(peer.server_name, "127.0.0.1");
            assert_eq!(peer.port, address.port());
            assert_eq!(peer.certificate_chain, vec![CERTIFICATE]);
        }
        server.await.unwrap();
    }
}

#[tokio::test]
async fn rejection_timeout_and_cancellation_close_tls_without_sending_http() {
    for outcome in ["reject", "timeout", "cancel"] {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (tcp, _) = listener.accept().await.unwrap();
            let mut tls = acceptor(false).accept(tcp).await.unwrap();
            let mut byte = [0];
            // EOF or an unclean TLS close is acceptable; even one HTTP byte is a credential leak.
            let read = tokio::time::timeout(Duration::from_secs(5), tls.read(&mut byte))
                .await
                .unwrap();
            assert!(
                matches!(read, Ok(0) | Err(_)),
                "application data preceded native approval"
            );
        });
        let policy = Policy::new(if outcome == "reject" {
            Some(false)
        } else {
            None
        });
        let config = GatewayClientConfig::new(format!("wss://{address}"))
            .unwrap()
            .header("Authorization", "Bearer synthetic-not-for-unverified-peers")
            .unwrap()
            .connect_timeout(Duration::from_secs(1))
            .tls_certificate_policy(policy.clone());
        let client = tokio::spawn(GatewayClient::connect(config, |_| async {
            Err::<Value, String>("Gateway auth requested before native trust".into())
        }));
        tokio::time::timeout(Duration::from_secs(5), policy.started.notified())
            .await
            .unwrap();
        if outcome == "cancel" {
            client.abort();
            let Err(error) = client.await else {
                panic!("cancelled connect continued")
            };
            assert!(error.is_cancelled());
        } else {
            let result = client.await.unwrap();
            assert!(matches!(
                (outcome, result),
                ("reject", Err(ClientError::Tls(_)))
                    | ("timeout", Err(ClientError::ConnectTimeout))
            ));
        }
        server.await.unwrap();
    }
}

#[tokio::test]
async fn native_policy_cannot_bypass_tls_handshake_signature_verification() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        let (tcp, _) = listener.accept().await.unwrap();
        assert!(acceptor(true).accept(tcp).await.is_err());
    });
    let policy = Policy::new(Some(true));
    let result = GatewayClient::connect(
        GatewayClientConfig::new(format!("wss://{address}"))
            .unwrap()
            .tls_certificate_policy(policy.clone()),
        |_| async { Ok::<_, String>(json!({})) },
    )
    .await;
    let Err(ClientError::Tls(reason)) = result else {
        panic!("invalid TLS signature was accepted")
    };
    assert!(
        reason.to_ascii_lowercase().contains("signature"),
        "{reason}"
    );
    assert!(policy.seen.lock().unwrap().is_none());
    server.await.unwrap();
}

#[tokio::test]
async fn builtin_pin_mismatch_still_rejects_before_http_upgrade() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        let (tcp, _) = listener.accept().await.unwrap();
        assert!(acceptor(false).accept(tcp).await.is_err());
    });
    let result = GatewayClient::connect(
        GatewayClientConfig::new(format!("wss://{address}"))
            .unwrap()
            .tls_trust(TlsTrust::Pinned([0; 32])),
        |_| async { Ok::<_, String>(json!({})) },
    )
    .await;
    let Err(ClientError::Tls(reason)) = result else {
        panic!("pin mismatch was accepted")
    };
    assert!(reason.contains(openclaw_gateway_client::TLS_PIN_MISMATCH_ERROR));
    server.await.unwrap();
}
