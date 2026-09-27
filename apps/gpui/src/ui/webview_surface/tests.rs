use super::*;
use core::prelude::v1::test;

#[test]
fn saved_profile_web_identity_survives_tunnel_port_changes() {
    let first = WebViewStores::new(
        "/isolated/app".into(),
        Some(("ssh-a".into(), "ws://127.0.0.1:18789/".into())),
    );
    let scope = first.control_scope("ws://127.0.0.1:41401/").unwrap();
    assert_eq!(scope, "profile:ssh-a:control:http://127.0.0.1:18789");
    assert_eq!(scope, first.control_scope("ws://127.0.0.1:41402/").unwrap());
    let second = WebViewStores::new(
        "/isolated/app".into(),
        Some(("ssh-b".into(), "ws://127.0.0.1:18789/".into())),
    );
    assert_ne!(
        scope,
        second.control_scope("ws://127.0.0.1:41401/").unwrap()
    );
    let ad_hoc = WebViewStores::new("/isolated/app".into(), None);
    assert_eq!(
        ad_hoc.control_scope("wss://EXAMPLE.test:443/path").unwrap(),
        "control:https://example.test"
    );
}

#[test]
fn retina_bounds_remain_logical_and_overlays_only_hide_intersections() {
    let bounds = SurfaceBounds {
        x: 80.24,
        y: 60.26,
        width: 400.24,
        height: 300.26,
    }
    .pixel_aligned(2.0);
    assert_eq!(
        bounds,
        SurfaceBounds {
            x: 80.0,
            y: 60.5,
            width: 400.0,
            height: 300.5
        }
    );
    let adjacent = SurfaceBounds {
        x: 480.0,
        y: 60.5,
        width: 80.0,
        height: 40.0,
    };
    assert!(surface_visible(true, false, bounds, &[adjacent]));
    assert!(!surface_visible(
        true,
        false,
        bounds,
        &[SurfaceBounds {
            x: 479.5,
            ..adjacent
        }]
    ));
    assert!(!surface_visible(false, false, bounds, &[]));
    assert!(!surface_visible(true, true, bounds, &[]));
    assert!(surface_visible(true, false, bounds, &[]));
}
