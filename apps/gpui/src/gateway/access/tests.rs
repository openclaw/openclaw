use super::jwt::issuer;
use super::*;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use rsa::Pkcs1v15Sign;
use rsa::{RsaPrivateKey, traits::PublicKeyParts};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::sync::OnceLock;

const TIME: f64 = 1_800_000_000.0;
const PEER: &str = "eaYx7t4b-cmPEgMs3q3Q56B5OY_HhriMyEbsia-FpRo=";
// Go 1.26.4, golang.org/x/crypto/nacl/box v0.53.0; the mobile interoperability fixture.
const ENVELOPE: &str = "4OHi4+Tl5ufo6err7O3u7/Dx8vP09fb3mUfpSI3NujJScq2SSYTNjPQHWD/4rcDtGZ4aXmZQQKiucDTkbzLbxWfGKrd5AcTTDtoyjAmnEygNkAiq9mC4Ma37GxgCkQhrX0liw7+6uoTpq9n5Rg==";

fn application() -> Application {
    Application {
        origin: "https://gateway.example.test:8443".into(),
        issuer: "https://example.cloudflareaccess.com".into(),
        audience: "test-audience".into(),
    }
}

struct Tokens {
    key: RsaPrivateKey,
    jwks: Vec<u8>,
}

fn tokens() -> &'static Tokens {
    static TOKENS: OnceLock<Tokens> = OnceLock::new();
    TOKENS.get_or_init(|| {
        // Like the Swift/Kotlin tests, sign at runtime rather than store a private fixture key.
        let key = RsaPrivateKey::new(&mut OsRng, 2048).unwrap();
        let jwks = serde_json::to_vec(&json!({"keys":[{
            "kty":"RSA", "kid":"test-key", "alg":"RS256", "use":"sig",
            "n":URL_SAFE_NO_PAD.encode(key.n().to_bytes_be()), "e":URL_SAFE_NO_PAD.encode(key.e().to_bytes_be())
        }]})).unwrap();
        Tokens { key, jwks }
    })
}

impl Tokens {
    fn token(&self, claims: Value) -> String {
        self.with_header(claims, json!({"alg":"RS256", "kid":"test-key"}))
    }
    fn with_header(&self, claims: Value, header: Value) -> String {
        let message = format!(
            "{}.{}",
            URL_SAFE_NO_PAD.encode(serde_json::to_vec(&header).unwrap()),
            URL_SAFE_NO_PAD.encode(serde_json::to_vec(&claims).unwrap())
        );
        let signature = self
            .key
            .sign(
                Pkcs1v15Sign::new::<Sha256>(),
                &Sha256::digest(message.as_bytes()),
            )
            .unwrap();
        format!("{message}.{}", URL_SAFE_NO_PAD.encode(signature))
    }
}

fn claims() -> Value {
    json!({"iss":application().issuer,"aud":[application().audience],"type":"app","sub":"test-subject","exp":TIME+3600.0})
}

fn metadata() -> Value {
    json!({"type":"match","hostname":"gateway.example.test","auth_domain":"example.cloudflareaccess.com","aud":"test-audience","iat":TIME})
}

#[test]
fn go_transfer_vector_opens_and_rejects_tampering_and_wire_alphabet_errors() {
    let secret = SecretKey::from(std::array::from_fn::<_, 32, _>(|index| index as u8));
    assert_eq!(
        app_token(ENVELOPE.as_bytes(), PEER, &secret).unwrap(),
        "test-only-app-token"
    );
    let decoded = STANDARD.decode(ENVELOPE).unwrap();
    for index in [0, 24, 108] {
        let mut changed = decoded.clone();
        changed[index] ^= 1;
        assert!(app_token(STANDARD.encode(changed).as_bytes(), PEER, &secret).is_err());
    }
    for (body, peer) in [
        (
            STANDARD.encode(&decoded[..decoded.len() - 1]),
            PEER.to_owned(),
        ),
        (
            ENVELOPE.into(),
            "j0DFrbaPJWJK5bIU6nZ6bslNgp09e14a0bpvPiE4KF8=".into(),
        ),
        ("invalid".into(), PEER.into()),
        (STANDARD.encode([0; 39]), PEER.into()),
        (ENVELOPE.into(), PEER[..43].into()),
        (ENVELOPE.into(), PEER.replace('-', "+").replace('_', "/")),
        (ENVELOPE.replace('+', "-").replace('/', "_"), PEER.into()),
        ("A".repeat(MAX_TRANSFER + 1), PEER.into()),
    ] {
        assert!(app_token(body.as_bytes(), &peer, &secret).is_err());
    }
    for unicode in ["é", "☃", "🦊"] {
        assert!(app_token(format!("{unicode}{ENVELOPE}").as_bytes(), PEER, &secret).is_err());
        assert!(
            app_token(
                ENVELOPE.as_bytes(),
                &format!("{}{unicode}", &PEER[..44 - unicode.len()]),
                &secret
            )
            .is_err()
        );
    }
    for malformed in [
        "YGFiY2RlZmdoaWprbG1ub3BxcnN0dXZ3tnpip9KPq9XQpBI5GjPt0k4=",
        "gIGCg4SFhoeIiYqLjI2Oj5CRkpOUlZaX4yew9i53b9+4rxh5Ix7UWTihTHI/Vzb1WO5a6ObFvXw7ZG9HhfL+6JQZgxuOPpv/heDdWETPVFwnFCVEpX6KUrs=",
        "oKGio6SlpqeoqaqrrK2ur7CxsrO0tba3udaJ6+8j8qaBZ7chKhIfXXKQgJRQ6OV5HOolnKdfDc/aXVQJ1Ra+UQCWuNZQcQ5PFktF",
    ] {
        assert!(
            app_token(
                malformed.as_bytes(),
                "NYBy1jZYgNGu6jKa35EhODhR7SGijjt16WXQ0s0WYlQ=",
                &secret
            )
            .is_err()
        );
    }
}

#[test]
fn browser_transfer_url_preserves_every_mobile_query_field_and_fresh_padded_keys() {
    let application = application();
    let public = "j0DFrbaPJWJK5bIU6nZ6bslNgp09e14a0bpvPiE4KF8=";
    let browser = Url::parse(&browser_url(&application, public).unwrap()).unwrap();
    assert_eq!(browser.path(), "/cdn-cgi/access/cli");
    assert_eq!(browser.query_pairs().into_owned().collect::<Vec<_>>(), vec![
        ("token".into(), public.into()), ("aud".into(), "test-audience".into()),
        ("redirect_url".into(), "https://gateway.example.test:8443/?token=j0DFrbaPJWJK5bIU6nZ6bslNgp09e14a0bpvPiE4KF8%3D&aud=test-audience".into()),
        ("send_org_token".into(), "true".into()), ("edge_token_transfer".into(), "true".into()), ("close_interstitial".into(), "true".into()),
    ]);
    let client = AccessClient::new().unwrap();
    let first = client.prepare_sign_in(&application).unwrap();
    let second = client.prepare_sign_in(&application).unwrap();
    assert_ne!(first.browser_url(), second.browser_url());
    assert_eq!(first.public.len(), 44);
    assert_eq!(URL_SAFE.decode(first.public).unwrap().len(), 32);
}

fn challenge(status: u16, name: &'static str, value: &str) -> bool {
    let mut headers = HeaderMap::new();
    headers.insert(name, value.parse().unwrap());
    is_challenge(
        "https://gateway.example.test:8443/gateway%20space/%2Fsocket",
        status,
        &headers,
        &application().origin,
    )
}

#[test]
fn login_redirect_hints_match_mobile_literal_dot_and_encoded_path_vectors() {
    for value in [
        "https://login.example.test/cdn-cgi/access/login/gateway.example.test?opaque=ignored",
        "/cdn-cgi/access/login?opaque=ignored",
        "../cdn-cgi/access/login",
        "/cdn-cgi/access/login-extra",
        "/%63dn-cgi/access/login",
        "/other/../cdn-cgi/access/login",
        "https://login.example.test/other/../cdn-cgi/access/login",
        "//login.example.test/other/../cdn-cgi/access/login",
        "/cdn-cgi/access/login/%2e%2e/ordinary",
        "/cdn-cgi/access/login%2Fchild",
        "/cdn-cgi/access/login//child",
        "../../../cdn-cgi/access/login",
        "///../../cdn-cgi/access/login",
    ] {
        assert!(challenge(302, "location", value), "{value}");
    }
    for (status, value) in [
        (200, "/cdn-cgi/access/login"),
        (301, "/cdn-cgi/access/login"),
        (303, "/cdn-cgi/access/login"),
        (307, "/cdn-cgi/access/login"),
        (308, "/cdn-cgi/access/login"),
        (302, ""),
        (302, "/login"),
        (302, "/cdn-cgi/access/login%ZZ"),
        (302, "?next=/cdn-cgi/access/login"),
        (401, "/cdn-cgi/access/login"),
        (302, "/cdn-cgi/access/login/../ordinary"),
        (
            302,
            "https://login.example.test/cdn-cgi/access/login/../ordinary",
        ),
        (302, "//login.example.test/cdn-cgi/access/login/../ordinary"),
        (302, "/cdn-cgi//access/login"),
        (302, "///cdn-cgi/access/login"),
        (302, "///cdn-cgi/access/login?next=ignored"),
        (302, "/other/%2e%2e/cdn-cgi/access/login"),
        (302, "../../../../ordinary"),
        (302, "/other//../cdn-cgi/access/login"),
        (302, "/other/..//cdn-cgi/access/login"),
    ] {
        assert!(!challenge(status, "location", value), "{status} {value}");
    }
    assert!(redirect_path("https://gateway.example.test/", "/cdn-cgi/access/login\n").is_none());
    let mut headers = HeaderMap::new();
    headers.insert("location", "/cdn-cgi/access/login".parse().unwrap());
    assert!(!is_challenge(
        "https://other.example.test:8443/",
        302,
        &headers,
        &application().origin
    ));
}

#[test]
fn authenticate_challenges_require_status_scheme_exact_origin_and_metadata_namespace() {
    for status in [301, 302, 303, 307, 308, 401, 403] {
        for scheme in ["Cloudflare-Access", "Bearer", "bearer"] {
            for path in ["", "/", "/mcp", "/gateway/socket"] {
                assert!(challenge(
                    status,
                    "www-authenticate",
                    &format!(
                        "{scheme} resource_metadata=\"https://gateway.example.test:8443/.well-known/cloudflare-access-protected-resource{path}\""
                    )
                ));
            }
        }
    }
    for value in [
        "Cloudflare-Access resource_metadata=\"https://other.example.test:8443/.well-known/cloudflare-access-protected-resource/\"",
        "Cloudflare-Access resource_metadata=\"https://gateway.example.test/.well-known/cloudflare-access-protected-resource/\"",
        "Basic resource_metadata=\"https://gateway.example.test:8443/.well-known/cloudflare-access-protected-resource/\"",
    ] {
        assert!(!challenge(403, "www-authenticate", value));
    }
    for path in [
        "/other/mcp",
        "/.well-known/cloudflare-access-protected-resource-spoof/mcp",
        "/.well-known/cloudflare-access-protected-resource/mcp?redirect=other",
        "/.well-known/cloudflare-access-protected-resource/mcp#fragment",
    ] {
        assert!(!challenge(
            401,
            "www-authenticate",
            &format!("Bearer resource_metadata=\"https://gateway.example.test:8443{path}\"")
        ));
    }
    assert!(!challenge(
        200,
        "www-authenticate",
        "Bearer resource_metadata=\"https://gateway.example.test:8443/.well-known/cloudflare-access-protected-resource/\""
    ));
    assert!(!challenge(403, "server", "cloudflare"));
    assert!(!challenge(
        401,
        "www-authenticate",
        &format!(
            "Bearer {}resource_metadata=\"https://gateway.example.test:8443/.well-known/cloudflare-access-protected-resource/\"",
            " ".repeat(8192)
        )
    ));
}

#[test]
fn metadata_requires_constrained_issuer_current_time_matching_host_and_rsa_signature() {
    let tokens = tokens();
    let good = tokens.token(metadata());
    verify_jwt(&good, &tokens.jwks).unwrap();
    assert_eq!(
        metadata_application(&good, &application().origin, TIME).unwrap(),
        application()
    );
    for (key, value) in [
        ("hostname", json!("other.example.test")),
        ("type", json!("other")),
        ("aud", json!("")),
        ("iat", json!(1)),
        ("iat", json!(TIME + 3600.0)),
        ("auth_domain", json!("attacker.example.test")),
    ] {
        let mut changed = metadata();
        changed[key] = value;
        let token = tokens.token(changed);
        verify_jwt(&token, &tokens.jwks).unwrap();
        assert!(metadata_application(&token, &application().origin, TIME).is_err());
    }
    for domain in [
        "example.test",
        "cloudflareaccess.com",
        ".cloudflareaccess.com",
        "https://example.cloudflareaccess.com",
        "example.cloudflareaccess.com:443",
        "example.cloudflareaccess.com/path",
        "x.example.cloudflareaccess.com",
        "-a.cloudflareaccess.com",
        "a-.cloudflareaccess.com",
    ] {
        assert!(issuer(domain).is_err(), "{domain}");
    }
    for header in [
        json!({"alg":"HS256","kid":"test-key"}),
        json!({"alg":"RS256","kid":"test-key","crit":["unknown"]}),
        json!({"alg":"RS256","kid":"missing"}),
    ] {
        assert!(verify_jwt(&tokens.with_header(metadata(), header), &tokens.jwks).is_err());
    }
    let mut parts: Vec<_> = good.split('.').map(str::to_owned).collect();
    let mut signature = URL_SAFE_NO_PAD.decode(&parts[2]).unwrap();
    signature[0] ^= 1;
    parts[2] = URL_SAFE_NO_PAD.encode(signature);
    assert!(verify_jwt(&parts.join("."), &tokens.jwks).is_err());
    assert!(verify_jwt(&format!("{good}="), &tokens.jwks).is_err());
}

#[test]
fn app_grant_checks_audience_issuer_type_subject_expiry_not_before_and_identity() {
    let tokens = tokens();
    let token = tokens.token(claims());
    verify_jwt(&token, &tokens.jwks).unwrap();
    let valid = app_claims(&token, &application(), TIME).unwrap();
    let session = session_from_identity(
        token.clone(),
        &application(),
        valid,
        br#"{"user_uuid":"test-subject","email":"reader@example.test"}"#,
    )
    .unwrap();
    assert_eq!(session.email.as_deref(), Some("reader@example.test"));
    for (key, value) in [
        ("iss", json!("https://other.cloudflareaccess.com")),
        ("aud", json!(["other-app"])),
        ("aud", json!(vec!["test-audience"; 17])),
        ("type", json!("org")),
        ("sub", json!("")),
        ("exp", json!(TIME)),
        ("nbf", json!(TIME + 3600.0)),
    ] {
        let mut changed = claims();
        changed[key] = value;
        let token = tokens.token(changed);
        verify_jwt(&token, &tokens.jwks).unwrap();
        assert!(app_claims(&token, &application(), TIME).is_err());
    }
    let valid = app_claims(&token, &application(), TIME).unwrap();
    assert!(
        session_from_identity(
            token.clone(),
            &application(),
            valid,
            br#"{"user_uuid":"another-subject"}"#
        )
        .is_err()
    );
    let mut scalar_audience = claims();
    scalar_audience["aud"] = json!("test-audience");
    assert!(app_claims(&tokens.token(scalar_audience), &application(), TIME).is_ok());
}

#[test]
fn session_roundtrip_redaction_and_headers_stay_on_unexpired_exact_authority() {
    let token = tokens().token(claims());
    let session = Session {
        application: application(),
        subject: "test-subject".into(),
        email: None,
        token: token.clone(),
        expires_at: TIME + 3600.0,
    };
    let encoded = serde_json::to_vec(&session).unwrap();
    let restored: Session = serde_json::from_slice(&encoded).unwrap();
    assert!(restored.is_valid(TIME));
    assert_eq!(
        format!("{restored:?}"),
        "CloudflareAccessSession(<redacted>)"
    );
    for url in [
        "https://gateway.example.test:8443/a?x=1",
        "wss://gateway.example.test:8443/socket",
    ] {
        assert_eq!(
            restored.authorization_header(url, TIME),
            Some(token.as_str())
        );
    }
    for url in [
        "https://gateway.example.test/",
        "https://gateway.example.test:443/",
        "https://other.example.test:8443/",
        "http://gateway.example.test:8443/",
        "https://user@gateway.example.test:8443/",
        "https://gateway.example.test:8443/#fragment",
    ] {
        assert!(restored.authorization_header(url, TIME).is_none());
    }
    assert!(
        restored
            .authorization_header(&application().origin, restored.expires_at)
            .is_none()
    );
    let mut changed = restored.clone();
    changed.subject = "forged".into();
    assert!(!changed.is_valid(TIME));
    changed = restored.clone();
    changed.expires_at += 1.0;
    assert!(!changed.is_valid(TIME));
    assert_eq!(
        origin("wss://gateway.example.test:443/path").unwrap(),
        "https://gateway.example.test"
    );
    assert_eq!(
        origin("https://[0:0:0:0:0:0:0:1]:8443/path").unwrap(),
        "https://[::1]:8443"
    );
}
