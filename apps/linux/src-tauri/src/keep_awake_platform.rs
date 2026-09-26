//! Idle inhibition only: never force wake, unlock, or block explicit sleep.
//! Linux desktop idle inhibition can also keep the display from idling.

#[cfg(target_os = "linux")]
mod platform {
    use futures_util::StreamExt;
    use std::{collections::HashMap, time::Duration};
    use zbus::zvariant::{OwnedObjectPath, OwnedValue, Value};

    enum Request {
        Gnome(u32),
        Portal(OwnedObjectPath),
    }

    pub struct Inhibitor {
        request: Option<Request>,
        connection: zbus::Connection,
    }

    impl Inhibitor {
        pub fn acquire() -> Result<Self, String> {
            tauri::async_runtime::block_on(async {
                let connection = zbus::Connection::session().await.map_err(|error| {
                    format!("Could not connect to the desktop session: {error}")
                })?;
                let result = async {
                    let bus = zbus::fdo::DBusProxy::new(&connection)
                        .await
                        .map_err(|error| error.to_string())?;
                    if bus
                        .name_has_owner(
                            "org.gnome.SessionManager"
                                .try_into()
                                .expect("valid GNOME bus name"),
                        )
                        .await
                        .map_err(|error| error.to_string())?
                    {
                        // The GTK portal can acknowledge an unsandboxed request
                        // with an empty app ID before GNOME rejects it. Ask the
                        // native session owner directly and require its cookie.
                        let proxy = zbus::Proxy::new(
                            &connection,
                            "org.gnome.SessionManager",
                            "/org/gnome/SessionManager",
                            "org.gnome.SessionManager",
                        )
                        .await
                        .map_err(|error| error.to_string())?;
                        let cookie: u32 = proxy
                            .call(
                                "Inhibit",
                                &("OpenClaw", 0_u32, "OpenClaw: Keep computer awake", 8_u32),
                            )
                            .await
                            .map_err(|error| error.to_string())?;
                        return Ok(Request::Gnome(cookie));
                    }
                    let token = format!("openclaw_{}", uuid::Uuid::new_v4().simple());
                    let sender = connection
                        .unique_name()
                        .ok_or("The desktop session has no bus identity.")?
                        .as_str()
                        .trim_start_matches(':')
                        .replace('.', "_");
                    let path = format!("/org/freedesktop/portal/desktop/request/{sender}/{token}");
                    let request_proxy = zbus::Proxy::new(
                        &connection,
                        "org.freedesktop.portal.Desktop",
                        path.as_str(),
                        "org.freedesktop.portal.Request",
                    )
                    .await
                    .map_err(|error| error.to_string())?;
                    // Inhibit returns a handle before the backend finishes. Subscribe
                    // first: fast Response signals can precede the method reply.
                    let mut responses = request_proxy
                        .receive_signal("Response")
                        .await
                        .map_err(|error| error.to_string())?;
                    let proxy = zbus::Proxy::new(
                        &connection,
                        "org.freedesktop.portal.Desktop",
                        "/org/freedesktop/portal/desktop",
                        "org.freedesktop.portal.Inhibit",
                    )
                    .await
                    .map_err(|error| error.to_string())?;
                    let options = HashMap::from([
                        ("reason", Value::from("OpenClaw: Keep computer awake")),
                        ("handle_token", Value::from(token.as_str())),
                    ]);
                    // Other desktops translate idle inhibition through their portal.
                    // logind idle alone misses desktop-managed automatic suspend;
                    // suspend flag 4 would also interfere with explicit sleep.
                    let request: OwnedObjectPath = proxy
                        .call("Inhibit", &("", 8_u32, options))
                        .await
                        .map_err(|error| error.to_string())?;
                    if request.as_str() != path {
                        return Err(
                            "The desktop portal returned an unexpected request handle.".to_string()
                        );
                    }
                    // Permission-denied portal versions can omit Response entirely.
                    let response = tokio::time::timeout(Duration::from_secs(30), responses.next())
                        .await
                        .map_err(|_| {
                            "The desktop portal did not confirm idle inhibition.".to_string()
                        })?
                        .ok_or(
                            "The desktop portal disconnected before confirming idle inhibition.",
                        )?;
                    let (code, _): (u32, HashMap<String, OwnedValue>) = response
                        .body()
                        .deserialize()
                        .map_err(|error| format!("Invalid desktop portal response: {error}"))?;
                    if code != 0 {
                        return Err(format!(
                            "The desktop portal declined idle inhibition (response {code})."
                        ));
                    }
                    Ok(Request::Portal(request))
                }
                .await;
                match result {
                    Ok(request) => Ok(Self {
                        request: Some(request),
                        connection,
                    }),
                    Err(error) => {
                        // Disconnect releases even a request whose method reply was lost.
                        let _ = connection.close().await;
                        Err(format!("Could not keep the computer awake. Check that the desktop session or its idle-inhibition portal is running, then try again. {error}"))
                    }
                }
            })
        }
    }

    impl crate::keep_awake::Inhibitor for Inhibitor {
        fn release(&mut self) -> Result<(), String> {
            let Some(request) = self.request.as_ref() else {
                return Ok(());
            };
            tauri::async_runtime::block_on(async {
                let path = match request {
                    Request::Gnome(cookie) => {
                        let proxy = zbus::Proxy::new(
                            &self.connection,
                            "org.gnome.SessionManager",
                            "/org/gnome/SessionManager",
                            "org.gnome.SessionManager",
                        )
                        .await
                        .map_err(|error| error.to_string())?;
                        return proxy
                            .call::<_, _, ()>("Uninhibit", &(*cookie,))
                            .await
                            .map_err(|error| {
                                format!("Could not release the GNOME idle-sleep request: {error}")
                            });
                    }
                    Request::Portal(path) => path,
                };
                let proxy = zbus::Proxy::new(
                    &self.connection,
                    "org.freedesktop.portal.Desktop",
                    path.as_str(),
                    "org.freedesktop.portal.Request",
                )
                .await
                .map_err(|error| error.to_string())?;
                proxy.call::<_, _, ()>("Close", &()).await.map_err(|error| {
                    format!("Could not release the desktop idle-sleep request: {error}")
                })
            })?;
            self.request = None;
            Ok(())
        }
    }

    impl Drop for Inhibitor {
        fn drop(&mut self) {
            if let Err(error) = crate::keep_awake::Inhibitor::release(self) {
                eprintln!("{error}");
            }
            // This dedicated connection also scopes the portal request. Disconnect
            // on shutdown/rollback so a failed Close cannot leave a live owner.
            let _ = tauri::async_runtime::block_on(self.connection.clone().close());
        }
    }
}

#[cfg(target_os = "macos")]
mod platform {
    use objc2_foundation::NSString;

    #[link(name = "IOKit", kind = "framework")]
    extern "C" {
        fn IOPMAssertionCreateWithName(
            assertion_type: *const NSString,
            level: u32,
            reason: *const NSString,
            assertion_id: *mut u32,
        ) -> i32;
        fn IOPMAssertionRelease(assertion_id: u32) -> i32;
    }

    pub struct Inhibitor(Option<u32>);

    impl Inhibitor {
        pub fn acquire() -> Result<Self, String> {
            let kind = NSString::from_str("PreventUserIdleSystemSleep");
            let reason = NSString::from_str("OpenClaw: Keep computer awake");
            let mut id = 0;
            // NSString and CFString are toll-free bridged. IOKit copies both
            // strings; only its assertion ID lives beyond this call.
            let result = unsafe { IOPMAssertionCreateWithName(&*kind, 255, &*reason, &mut id) };
            if result != 0 {
                return Err(format!(
                    "Could not prevent idle sleep (IOKit error {result})."
                ));
            }
            Ok(Self(Some(id)))
        }
    }

    impl crate::keep_awake::Inhibitor for Inhibitor {
        fn release(&mut self) -> Result<(), String> {
            if let Some(id) = self.0 {
                let result = unsafe { IOPMAssertionRelease(id) };
                if result != 0 {
                    return Err(format!(
                        "Could not release the idle-sleep assertion (IOKit error {result})."
                    ));
                }
                self.0 = None;
            }
            Ok(())
        }
    }

    impl Drop for Inhibitor {
        fn drop(&mut self) {
            if let Err(error) = crate::keep_awake::Inhibitor::release(self) {
                eprintln!("{error}");
            }
        }
    }
}

#[cfg(target_os = "windows")]
mod platform {
    const ES_CONTINUOUS: u32 = 0x8000_0000;
    const ES_SYSTEM_REQUIRED: u32 = 0x0000_0001;

    #[link(name = "kernel32")]
    extern "system" {
        fn SetThreadExecutionState(flags: u32) -> u32;
    }

    // The power worker creates and drops this on the same dedicated thread.
    // Do not move it to a Tokio task: this Windows API is thread-affine.
    pub struct Inhibitor {
        active: bool,
        _thread: std::marker::PhantomData<std::rc::Rc<()>>,
    }

    impl Inhibitor {
        pub fn acquire() -> Result<Self, String> {
            let previous = unsafe { SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED) };
            if previous == 0 {
                return Err("Windows could not prevent idle sleep.".into());
            }
            Ok(Self {
                active: true,
                _thread: std::marker::PhantomData,
            })
        }
    }

    impl crate::keep_awake::Inhibitor for Inhibitor {
        fn release(&mut self) -> Result<(), String> {
            if self.active {
                if unsafe { SetThreadExecutionState(ES_CONTINUOUS) } == 0 {
                    return Err("Windows could not clear the idle-sleep request.".into());
                }
                self.active = false;
            }
            Ok(())
        }
    }

    impl Drop for Inhibitor {
        fn drop(&mut self) {
            if let Err(error) = crate::keep_awake::Inhibitor::release(self) {
                eprintln!("{error}");
            }
        }
    }
}

#[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
mod platform {
    pub struct Inhibitor;
    impl Inhibitor {
        pub fn acquire() -> Result<Self, String> {
            Err("Keeping the computer awake is not supported on this platform.".into())
        }
    }
    impl crate::keep_awake::Inhibitor for Inhibitor {
        fn release(&mut self) -> Result<(), String> {
            Ok(())
        }
    }
}

pub use platform::Inhibitor;
