// Tauri's macOS runtime must be created on the main thread, outside libtest.
#[cfg(target_os = "macos")]
#[path = "../src/updater/builder.rs"]
mod builder;

#[cfg(target_os = "macos")]
fn main() {
    use std::io::{BufRead, BufReader, Write};
    use std::net::TcpListener;
    use std::time::Duration;

    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let endpoint = format!("http://{}/latest.json", listener.local_addr().unwrap());
    let server = std::thread::spawn(move || {
        for version in ["2026.9.3-1", "2026.9.3", "2026.9.2"] {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let mut reader = BufReader::new(&stream);
            let mut line = String::new();
            reader.read_line(&mut line).unwrap();
            assert!(line.starts_with("GET /latest.json HTTP/1.1"), "{line}");
            loop {
                line.clear();
                reader.read_line(&mut line).unwrap();
                if line == "\r\n" {
                    break;
                }
            }
            let body = serde_json::json!({
                "version": version,
                "notes": "Synthetic correction release",
                "url": "https://example.invalid/OpenClaw.app.tar.gz",
                "signature": "fixture",
            })
            .to_string();
            write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
        }
    });

    let mut context = tauri::generate_context!();
    context.package_info_mut().version = "2026.9.3".parse().unwrap();
    context.config_mut().app.windows.clear();
    context.config_mut().plugins.0.insert(
        "updater".into(),
        serde_json::json!({
            "pubkey": "synthetic fixture",
            "dangerousInsecureTransportProtocol": true,
        }),
    );
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .build(context)
        .unwrap();
    // Override only transport; the production builder must supply comparison policy.
    let updater = builder::updater_builder(app.handle())
        .unwrap()
        .endpoints(vec![endpoint.parse().unwrap()])
        .unwrap()
        .timeout(Duration::from_secs(5))
        .no_proxy()
        .build()
        .unwrap();
    tauri::async_runtime::block_on(async {
        let correction = updater
            .check()
            .await
            .unwrap()
            .expect("offer the correction release");
        assert_eq!(correction.version, "2026.9.3-1");
        assert_eq!(
            correction.body.as_deref(),
            Some("Synthetic correction release")
        );
        assert!(
            updater.check().await.unwrap().is_none(),
            "do not offer the installed release"
        );
        assert!(
            updater.check().await.unwrap().is_none(),
            "do not offer an older release"
        );
    });
    server.join().unwrap();
    println!("macOS native updater: correction offered; equal and older releases rejected");
}

#[cfg(not(target_os = "macos"))]
fn main() {}
