use std::sync::LazyLock;

static BACKGROUND: LazyLock<bool> = LazyLock::new(|| {
    std::env::var_os("OPENCLAW_GPUI_BACKGROUND").as_deref() == Some(std::ffi::OsStr::new("1"))
});

pub fn activates() -> bool {
    !*BACKGROUND
}

pub fn install() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    macos::install()?;
    Ok(())
}

pub fn with_suppressed_activation<R>(build: impl FnOnce() -> R) -> R {
    #[cfg(target_os = "macos")]
    let _scope = {
        let _main = objc2::MainThreadMarker::new()
            .expect("Webview activation suppression requires the main thread");
        macos::Suppression::new()
    };
    build()
}

#[cfg(target_os = "macos")]
mod macos {
    use std::{cell::Cell, ffi::CString, sync::OnceLock};

    use objc2::{
        MainThreadMarker,
        encode::{EncodeArguments, EncodeReturn},
        ffi::class_addMethod,
        msg_send,
        runtime::{AnyClass, AnyObject, Bool, MethodImplementation, Sel},
        sel,
    };
    use objc2_app_kit::NSApplication;

    static ACTIVATION_CLASS: OnceLock<&'static AnyClass> = OnceLock::new();

    thread_local! {
        static SUPPRESSION_DEPTH: Cell<usize> = const { Cell::new(0) };
    }

    pub(super) struct Suppression;

    impl Suppression {
        pub(super) fn new() -> Self {
            SUPPRESSION_DEPTH.set(SUPPRESSION_DEPTH.get() + 1);
            Self
        }
    }

    impl Drop for Suppression {
        fn drop(&mut self) {
            SUPPRESSION_DEPTH.set(SUPPRESSION_DEPTH.get() - 1);
        }
    }

    pub(super) fn install() -> Result<(), String> {
        let main = MainThreadMarker::new().ok_or("Background policy requires the main thread")?;
        let app = NSApplication::sharedApplication(main);
        let owner = AnyClass::get(c"GPUIApplication").ok_or("GPUI application class is missing")?;
        let mut ancestor = Some(app.class());
        while ancestor.is_some_and(|class| class != owner) {
            ancestor = ancestor.and_then(AnyClass::superclass);
        }
        if ancestor.is_none() {
            return Err(format!(
                "Cannot enforce background policy on unexpected application class {}",
                app.class()
            ));
        }
        install_overrides(owner)?;
        log::info!(
            "background_activation policy=installed class={} owner={owner} background={}",
            app.class(),
            !super::activates()
        );
        Ok(())
    }

    fn install_overrides(class: &'static AnyClass) -> Result<(), String> {
        // wry 0.57 activates NSApplication even for hidden, unfocused children.
        // Only GPUI's subclass is overridden. Its normal activation requests
        // still reach AppKit outside a webview construction scope.
        ACTIVATION_CLASS
            .set(class)
            .map_err(|_| "Application activation policy is already installed")?;
        add_override(
            class,
            sel!(activate),
            activate as extern "C" fn(*mut AnyObject, Sel),
        )?;
        add_override(
            class,
            sel!(activateIgnoringOtherApps:),
            activate_ignoring as extern "C" fn(*mut AnyObject, Sel, Bool),
        )
    }

    fn activation_parent() -> &'static AnyClass {
        // KVO can put a dynamic subclass above GPUIApplication. Forward from
        // the installation owner, not the receiver, to avoid reentering us.
        ACTIVATION_CLASS
            .get()
            .and_then(|class| class.superclass())
            .expect("Application activation superclass")
    }

    fn add_override<F>(class: &AnyClass, selector: Sel, implementation: F) -> Result<(), String>
    where
        F: MethodImplementation<Callee = AnyObject>,
    {
        let mut encoding = format!("{}@:", F::Return::ENCODING_RETURN);
        for argument in F::Arguments::ENCODINGS {
            use std::fmt::Write;
            write!(encoding, "{argument}").expect("write Objective-C method encoding");
        }
        let encoding = CString::new(encoding).expect("Objective-C encoding contains no null");
        // The implementation's ABI supplies its type encoding. Adding an override
        // leaves NSApplication and every other subclass's method table untouched.
        let added = unsafe {
            class_addMethod(
                std::ptr::from_ref(class).cast_mut(),
                selector,
                implementation.__imp(),
                encoding.as_ptr(),
            )
        };
        if !added.as_bool() {
            return Err(format!(
                "Could not enforce background policy for {selector}"
            ));
        }
        Ok(())
    }

    fn suppresses(selector: Sel) -> bool {
        if !super::activates() || SUPPRESSION_DEPTH.get() > 0 {
            log::info!("background_activation policy=suppressed selector={selector}");
            true
        } else {
            false
        }
    }

    extern "C" fn activate(app: *mut AnyObject, selector: Sel) {
        if !suppresses(selector) {
            // Objective-C supplies a live receiver of the guarded app subclass.
            unsafe {
                let app = &*app;
                let _: () = msg_send![super(app, activation_parent()), activate];
            }
        }
    }

    extern "C" fn activate_ignoring(app: *mut AnyObject, selector: Sel, ignore: Bool) {
        if !suppresses(selector) {
            unsafe {
                let app = &*app;
                let _: () =
                    msg_send![super(app, activation_parent()), activateIgnoringOtherApps: ignore];
            }
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use objc2::{ClassType, rc::Retained, runtime::ClassBuilder};
        use objc2_foundation::NSObject;
        use std::sync::atomic::{AtomicUsize, Ordering};

        static ACTIVATIONS: AtomicUsize = AtomicUsize::new(0);

        extern "C" fn activate(_app: *mut AnyObject, _selector: Sel) {
            ACTIVATIONS.fetch_add(1, Ordering::SeqCst);
        }

        extern "C" fn activate_ignoring(app: *mut AnyObject, selector: Sel, _ignore: Bool) {
            activate(app, selector);
        }

        #[test]
        fn scoped_suppression_blocks_nested_activation_and_restores_after_unwind() {
            let mut source =
                ClassBuilder::new(c"OpenClawActivationTestSource", NSObject::class()).unwrap();
            // NSObject fixtures exercise real Objective-C dispatch without
            // constructing NSApplication, a window, or any activation request.
            unsafe {
                source.add_method(
                    sel!(activate),
                    activate as extern "C" fn(*mut AnyObject, Sel),
                );
                source.add_method(
                    sel!(activateIgnoringOtherApps:),
                    activate_ignoring as extern "C" fn(*mut AnyObject, Sel, Bool),
                );
            }
            let source = source.register();
            let background = ClassBuilder::new(c"OpenClawBackgroundTestApp", source)
                .unwrap()
                .register();
            let observed = ClassBuilder::new(c"OpenClawObservedBackgroundTestApp", background)
                .unwrap()
                .register();
            let foreground: Retained<NSObject> = unsafe { msg_send![source, new] };
            let background_app: Retained<NSObject> = unsafe { msg_send![observed, new] };
            install_overrides(background).unwrap();
            unsafe {
                let _: () = msg_send![&background_app, activate];
                let _: () = msg_send![&background_app, activateIgnoringOtherApps: Bool::YES];
            }
            assert_eq!(ACTIVATIONS.load(Ordering::SeqCst), 2);
            {
                let _outer = Suppression::new();
                {
                    let _inner = Suppression::new();
                    unsafe {
                        let _: () = msg_send![&background_app, activate];
                        let _: () =
                            msg_send![&background_app, activateIgnoringOtherApps: Bool::YES];
                    }
                }
                unsafe {
                    let _: () = msg_send![&background_app, activate];
                    let _: () = msg_send![&background_app, activateIgnoringOtherApps: Bool::YES];
                    let _: () = msg_send![&foreground, activate];
                }
                assert_eq!(ACTIVATIONS.load(Ordering::SeqCst), 3);
            }
            assert!(
                std::panic::catch_unwind(|| {
                    let _scope = Suppression::new();
                    panic!("construction failed");
                })
                .is_err()
            );
            unsafe {
                let _: () = msg_send![&background_app, activate];
                let _: () = msg_send![&background_app, activateIgnoringOtherApps: Bool::YES];
                let _: () = msg_send![&foreground, activateIgnoringOtherApps: Bool::YES];
            }
            assert_eq!(ACTIVATIONS.load(Ordering::SeqCst), 6);
        }
    }
}
