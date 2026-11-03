use super::*;

#[test]
fn native_control_authority_retires_with_document_primary_or_profile() {
    let url = Url::parse("https://gateway.example/control/").unwrap();
    let source = DocumentAuthority {
        label: "main".into(),
        lifetime: "document".into(),
        nonce: "document-token".into(),
    };
    let mut routing = Routing::default();
    routing.primary_ownership = Some(GatewayOwnership::Remote);
    routing.primary_generation = 7;
    routing.windows.insert(
        "main".into(),
        WindowRoute {
            target: PRIMARY.into(),
            primary_generation: Some(7),
            document: Some(Document {
                lifetime: source.lifetime.clone(),
                nonce: Some(source.nonce.clone()),
                url: url.clone(),
                navigation_url: url.clone(),
                native_auth: true,
                phase: NavigationPhase::Active,
                navigation: 1,
                native_navigation: None,
                queued_url: None,
                completion: None,
                profile_revision: None,
                #[cfg(target_os = "windows")]
                _browser_data: None,
            }),
            ..WindowRoute::default()
        },
    );
    assert!(authorize_control_auth(&routing, &source, &url).is_ok());
    assert!(authorize_control_auth(
        &routing,
        &source,
        &Url::parse("https://other.example/control").unwrap()
    )
    .is_err());
    routing.windows.get_mut("main").unwrap().target = "saved-other-profile".into();
    assert!(authorize_control_auth(&routing, &source, &url).is_err());
    routing.windows.get_mut("main").unwrap().target = PRIMARY.into();
    routing.primary_generation += 1;
    assert!(authorize_control_auth(&routing, &source, &url).is_err());
    routing.primary_generation -= 1;
    routing
        .windows
        .get_mut("main")
        .unwrap()
        .document
        .as_mut()
        .unwrap()
        .nonce = Some("replacement-token".into());
    assert!(authorize_control_auth(&routing, &source, &url).is_err());
    routing
        .windows
        .get_mut("main")
        .unwrap()
        .document
        .as_mut()
        .unwrap()
        .nonce = Some(source.nonce.clone());
    routing
        .windows
        .get_mut("main")
        .unwrap()
        .document
        .as_mut()
        .unwrap()
        .lifetime = "replacement-document".into();
    assert!(authorize_control_auth(&routing, &source, &url).is_err());
    routing
        .windows
        .get_mut("main")
        .unwrap()
        .document
        .as_mut()
        .unwrap()
        .lifetime = source.lifetime.clone();
    routing.primary_ownership = Some(GatewayOwnership::Local);
    assert!(authorize_control_auth(&routing, &source, &url).is_err());
    routing.primary_ownership = Some(GatewayOwnership::Remote);
    routing.closing = true;
    assert!(authorize_control_auth(&routing, &source, &url).is_err());
}
