mod app;
mod window;
mod views;
mod widgets;
mod state;
mod bridge;
mod markdown;
mod notifications;
mod session_filter;
mod systemd;
mod tray;

use tracing_subscriber::EnvFilter;

const APP_ID: &str = "ai.openclaw.desktop";

fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::from_default_env().add_directive("info".parse().unwrap()))
        .init();

    // Default to the Cairo renderer on X11 unless the user overrides it.
    // GTK4's GL renderer has hit XRenderComposite BadDrawable on tiling WMs
    // (bspwm, i3, xmonad, etc.) when compositing Pixmaps during monitor
    // changes or widget realization. Cairo is CPU-bound but avoids all of
    // those paths and is perfectly fast enough for this app's widget tree.
    // On Wayland, GTK picks its own safe renderer — we don't override.
    #[cfg(target_os = "linux")]
    if std::env::var_os("GSK_RENDERER").is_none()
        && std::env::var("WAYLAND_DISPLAY").ok().filter(|s| !s.is_empty()).is_none()
    {
        // Safety: single-threaded — no other threads exist yet.
        unsafe { std::env::set_var("GSK_RENDERER", "cairo"); }
    }

    // Filter out a harmless-but-noisy libadwaita warning emitted during
    // its own init when the system theme has already set
    // GtkSettings:gtk-application-prefer-dark-theme (common on desktops
    // with `gsettings set org.gnome.desktop.interface color-scheme
    // 'prefer-dark'`). libadwaita still works correctly — it manages dark
    // mode via AdwStyleManager — but emits a WARN every startup. We silence
    // only this exact message and pass everything else through to stderr.
    use gtk4::glib;
    glib::log_set_writer_func(|level, fields| {
        let msg = fields
            .iter()
            .find(|f| f.key() == "MESSAGE")
            .and_then(|f| f.value_str())
            .unwrap_or("");
        if msg.contains("gtk-application-prefer-dark-theme with libadwaita")
        {
            return glib::LogWriterOutput::Handled;
        }
        glib::log_writer_default(level, fields)
    });

    // Start system tray (StatusNotifierItem via D-Bus)
    tray::start_tray();

    let application = app::OpenClawApplication::new(APP_ID);
    application.run();
}
